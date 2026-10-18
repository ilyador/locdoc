//! Connection-scoped admission, liveness and awareness ownership.
use super::*;
use std::{
    net::{IpAddr, Ipv6Addr},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use yrs::{sync::AwarenessUpdate, updates::decoder::Decode};

const VISITORS: usize = 64;
const VISITORS_PER_ADDRESS: usize = 16;
pub(super) const AWARENESS_CLIENT_LIMIT: usize = 256;
pub(super) const PING_INTERVAL: Duration = Duration::from_secs(20);

/// Settings mutations are rare; cursor broadcasts are not. Sockets retain the
/// generation they actually checked, and still refresh live filesystem grants
/// and session expiry on every heartbeat.
#[derive(Default)]
pub(super) struct PermissionEpoch(AtomicU64);
impl PermissionEpoch {
    pub(super) fn current(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
    pub(super) fn invalidate(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }
}

#[derive(Default)]
pub(super) struct PermissionCheck(Option<u64>);
impl PermissionCheck {
    pub(super) fn needs_check(&self, generation: u64, force: bool) -> bool {
        force || self.0 != Some(generation)
    }
    pub(super) fn checked(&mut self, generation: u64) {
        self.0 = Some(generation);
    }
}

fn address_group(address: IpAddr) -> IpAddr {
    match address.to_canonical() {
        IpAddr::V6(address) => {
            // Privacy addresses from one host normally vary within its /64.
            // Apply one budget to the prefix, preserving separate IPv4 hosts.
            let mut bytes = address.octets();
            bytes[8..].fill(0);
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        address => address,
    }
}

/// Forwarded addresses are trusted only on the local reverse-proxy hop. Use the
/// final value Caddy appends, rather than an address supplied by the browser.
pub(super) fn address(headers: &HeaderMap, peer: IpAddr) -> IpAddr {
    if peer.is_loopback()
        && let Some(forwarded) = headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
    {
        return address_group(forwarded);
    }
    address_group(peer)
}

#[derive(Default)]
pub(super) struct Visitors {
    active: Mutex<HashMap<IpAddr, usize>>,
}
impl Visitors {
    pub(super) fn enter(self: &Arc<Self>, address: IpAddr) -> Result<Visitor> {
        let mut active = self.active.lock().unwrap();
        if active.values().sum::<usize>() >= VISITORS
            || active.get(&address).copied().unwrap_or(0) >= VISITORS_PER_ADDRESS
        {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Visitor connections are busy. Close an unused tab or try again shortly.".into(),
            ));
        }
        *active.entry(address).or_default() += 1;
        Ok(Visitor {
            visitors: self.clone(),
            address,
        })
    }
}
pub(super) struct Visitor {
    visitors: Arc<Visitors>,
    address: IpAddr,
}
impl Drop for Visitor {
    fn drop(&mut self) {
        let mut active = self.visitors.active.lock().unwrap();
        if let Some(count) = active.get_mut(&self.address) {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.address);
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Heartbeat {
    pending: Option<[u8; 16]>,
}
impl Heartbeat {
    /// Every interval must answer the previous challenge. Ordinary incoming
    /// edits, unsolicited pongs and outbound broadcasts do not prove liveness.
    pub(super) fn ping(&mut self) -> Option<[u8; 16]> {
        if self.pending.is_some() {
            return None;
        }
        let nonce = *uuid::Uuid::new_v4().as_bytes();
        self.pending = Some(nonce);
        Some(nonce)
    }
    pub(super) fn pong(&mut self, bytes: &[u8]) {
        if self.pending.as_ref().is_some_and(|nonce| nonce == bytes) {
            self.pending = None;
        }
    }
}

#[derive(Default)]
pub(super) struct Presence {
    source: Option<yrs::ClientID>,
    wire: Option<yrs::ClientID>,
    received: Option<u32>,
    clock: u32,
    removed: bool,
}
impl Presence {
    pub(super) fn client(&self) -> Option<yrs::ClientID> {
        self.wire
    }
    pub(super) fn accept(
        &mut self,
        update: &mut AwarenessUpdate,
        awareness: &Awareness,
    ) -> Result<()> {
        // Each connection has one source ID, but its public ID is allocated by
        // the server. Claiming a disconnected peer's source ID cannot hide or
        // reserve that peer's cursor. Cursor JSON retains its Yjs positions.
        if self.source.is_none()
            && update.clients.len() == 1
            && let Some((&source, state)) = update.clients.iter().next()
            && state.json.as_ref() != "null"
        {
            self.source = Some(source);
            self.wire = Some(loop {
                // Browser Yjs IDs are uint32. Use the upper safe-integer range
                // and exclude existing awareness IDs, including tombstones.
                let id = yrs::ClientID::new((rand::random::<u64>() & ((1 << 53) - 1)) | (1 << 52));
                if id != source && id != awareness.client_id() && awareness.meta(id).is_none() {
                    break id;
                }
            });
        }
        let entry = self
            .source
            .and_then(|source| update.clients.remove(&source));
        update.clients.clear();
        let Some(mut entry) = entry else {
            return Ok(());
        };
        let removed = entry.json.as_ref() == "null";
        if self.received.is_some_and(|last| {
            entry.clock < last || (entry.clock == last && (!removed || self.removed))
        }) {
            return Ok(());
        }
        self.received = Some(entry.clock);
        self.removed = removed;
        // Peer clocks are untrusted. A MAX clock must not overflow Yrs during
        // disconnect or poison a later connection which reuses the source ID.
        self.clock = self
            .clock
            .checked_add(1)
            .filter(|clock| *clock < u32::MAX - 1)
            .ok_or_else(|| bad("Presence connection needs to be reopened."))?;
        entry.clock = self.clock;
        update.clients.insert(self.wire.unwrap(), entry);
        Ok(())
    }
    pub(super) fn outgoing(&self, bytes: Vec<u8>) -> Option<Vec<u8>> {
        let Some(client) = self.wire else {
            return Some(bytes);
        };
        if bytes.first() != Some(&1) {
            return Some(bytes);
        }
        // Server-created frames already passed wire validation. Filter both
        // broadcasts and full awareness query responses before they are sent.
        let Message::Awareness(mut update) = Message::decode_v1(&bytes).ok()? else {
            return None;
        };
        update.clients.remove(&client);
        (!update.clients.is_empty()).then(|| Message::Awareness(update).encode_v1())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::sync::awareness::AwarenessUpdateEntry;

    fn update(client: u64, json: &str) -> AwarenessUpdate {
        AwarenessUpdate {
            clients: HashMap::from([(
                yrs::ClientID::new(client),
                AwarenessUpdateEntry {
                    clock: 100,
                    json: json.into(),
                },
            )]),
        }
    }

    #[test]
    fn visitor_limit_is_per_address_and_returns_capacity_on_disconnect() {
        let visitors = Arc::new(Visitors::default());
        let address = "192.0.2.1".parse().unwrap();
        let mut leases = (0..VISITORS_PER_ADDRESS)
            .map(|_| visitors.enter(address).unwrap())
            .collect::<Vec<_>>();
        assert!(visitors.enter(address).is_err());
        assert!(visitors.enter("192.0.2.2".parse().unwrap()).is_ok());
        leases.pop();
        assert!(visitors.enter(address).is_ok());
        drop(leases);
        assert!(visitors.active.lock().unwrap().is_empty());
    }

    #[test]
    fn visitor_global_limit_and_forwarded_addresses_cannot_be_spoofed() {
        let visitors = Arc::new(Visitors::default());
        let leases = (1..=VISITORS)
            .map(|n| visitors.enter(IpAddr::from([192, 0, 2, n as u8])).unwrap())
            .collect::<Vec<_>>();
        assert!(visitors.enter("192.0.2.100".parse().unwrap()).is_err());
        drop(leases);
        assert!(visitors.active.lock().unwrap().is_empty());
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "198.51.100.2, 192.0.2.10".parse().unwrap(),
        );
        assert_eq!(
            address(&headers, "127.0.0.1".parse().unwrap()).to_string(),
            "192.0.2.10"
        );
        assert_eq!(
            address(&headers, "198.51.100.5".parse().unwrap()).to_string(),
            "198.51.100.5"
        );
        assert_eq!(
            address(&HeaderMap::new(), "::ffff:192.0.2.5".parse().unwrap()).to_string(),
            "192.0.2.5"
        );
    }

    #[test]
    fn ipv6_privacy_addresses_share_one_budget_without_combining_ipv4_hosts() {
        let visitors = Arc::new(Visitors::default());
        let mut headers = HeaderMap::new();
        let mut leases = Vec::new();
        for n in 1..=VISITORS_PER_ADDRESS {
            headers.insert(
                "x-forwarded-for",
                format!("2001:db8:1234:5678::{n:x}").parse().unwrap(),
            );
            let group = address(&headers, "127.0.0.1".parse().unwrap());
            assert_eq!(group.to_string(), "2001:db8:1234:5678::");
            leases.push(visitors.enter(group).unwrap());
        }
        headers.insert(
            "x-forwarded-for",
            "2001:db8:1234:5678::ffff".parse().unwrap(),
        );
        assert!(
            visitors
                .enter(address(&headers, "127.0.0.1".parse().unwrap()))
                .is_err()
        );
        assert!(
            visitors
                .enter(address(
                    &HeaderMap::new(),
                    "2001:db8:1234:5679::1".parse().unwrap()
                ))
                .is_ok()
        );
        assert_eq!(
            address(&HeaderMap::new(), "::ffff:192.0.2.5".parse().unwrap()),
            "192.0.2.5".parse::<IpAddr>().unwrap()
        );
        assert_ne!(
            address(&HeaderMap::new(), "192.0.2.5".parse().unwrap()),
            address(&HeaderMap::new(), "192.0.2.6".parse().unwrap())
        );
    }

    #[tokio::test]
    async fn unchanged_socket_permissions_do_not_queue_storage_and_revocation_rechecks() {
        let directory = tempfile::tempdir().unwrap();
        let s = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        fs::write(s.root.join("shared.md"), "Shared text\n").unwrap();
        let doc = s.index_document("shared.md").unwrap();
        let _ = share(
            State(s.clone()),
            AxPath(doc.id.clone()),
            security::Owner,
            Json(Share {
                permission: "view".into(),
                rotate: false,
            }),
        )
        .await
        .unwrap();
        let access = Access {
            token: s.doc(&doc.id).unwrap().token,
            ..Access::default()
        };
        let headers = HeaderMap::new();
        let mut checked = PermissionCheck::default();
        socket_access(&s, &doc.id, &headers, &access, &mut checked, false)
            .await
            .unwrap();
        let permits = s.work.clone().acquire_many_owned(4).await.unwrap();
        let relays = tokio::time::timeout(Duration::from_millis(100), async {
            for _ in 0..1024 {
                socket_access(&s, &doc.id, &headers, &access, &mut checked, false).await?;
            }
            Ok::<(), ApiError>(())
        })
        .await;
        assert!(
            matches!(relays, Ok(Ok(()))),
            "steady broadcasts must bypass occupied storage workers"
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(20),
                socket_access(&s, &doc.id, &headers, &access, &mut checked, true),
            )
            .await
            .is_err(),
            "heartbeats must force a fresh permission check"
        );
        drop(permits);
        let _ = share(
            State(s.clone()),
            AxPath(doc.id.clone()),
            security::Owner,
            Json(Share {
                permission: "private".into(),
                rotate: false,
            }),
        )
        .await
        .unwrap();
        assert!(
            socket_access(&s, &doc.id, &headers, &access, &mut checked, false)
                .await
                .is_err(),
            "revocation must invalidate a socket's successful cached check"
        );
    }

    #[tokio::test]
    async fn heartbeat_rechecks_unversioned_folder_identity_changes() {
        let directory = tempfile::tempdir().unwrap();
        let s = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        fs::create_dir(s.root.join("Shared")).unwrap();
        fs::write(s.root.join("Shared/note.md"), "Shared text\n").unwrap();
        let doc = s.index_document("Shared/note.md").unwrap();
        let value = folders::share(
            State(s.clone()),
            security::Owner,
            Json(serde_json::from_value(json!({"path":"Shared","permission":"view"})).unwrap()),
        )
        .await
        .unwrap();
        let token = value.0["shareUrl"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap();
        let access = Access {
            token: Some(token.into()),
            ..Access::default()
        };
        let headers = HeaderMap::new();
        let mut checked = PermissionCheck::default();
        socket_access(&s, &doc.id, &headers, &access, &mut checked, false)
            .await
            .unwrap();
        // No watcher runs in this fixture: the heartbeat must also cover a
        // dropped namespace notice, rather than trusting the epoch forever.
        fs::rename(s.root.join("Shared"), s.root.join("Moved")).unwrap();
        fs::create_dir(s.root.join("Shared")).unwrap();
        fs::rename(s.root.join("Moved/note.md"), s.root.join("Shared/note.md")).unwrap();
        assert!(
            socket_access(&s, &doc.id, &headers, &access, &mut checked, true)
                .await
                .is_err(),
            "heartbeat must reject a replaced folder even without an epoch bump"
        );
    }

    #[tokio::test]
    async fn logout_revokes_a_cached_private_document_socket() {
        let directory = tempfile::tempdir().unwrap();
        let s = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost".into(),
        )
        .unwrap();
        fs::write(s.root.join("private.md"), "Private text\n").unwrap();
        let doc = s.index_document("private.md").unwrap();
        let session = browser_auth::issue(&s, "origin").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {session}").parse().unwrap(),
        );
        let access = Access::default();
        let mut checked = PermissionCheck::default();
        socket_access(&s, &doc.id, &headers, &access, &mut checked, false)
            .await
            .unwrap();
        let _ = logout(State(s.clone()), headers.clone()).await.unwrap();
        assert!(
            socket_access(&s, &doc.id, &headers, &access, &mut checked, false)
                .await
                .is_err(),
            "logout must stop passive private-document access without waiting for heartbeat"
        );
    }

    #[test]
    fn heartbeat_requires_the_matching_pong_before_the_next_interval() {
        let mut heartbeat = Heartbeat::default();
        let nonce = heartbeat.ping().unwrap();
        heartbeat.pong(b"not the challenge");
        assert!(heartbeat.ping().is_none());
        heartbeat.pong(&nonce);
        assert!(heartbeat.ping().is_some());
    }

    #[test]
    fn awareness_uses_connection_ids_without_reserving_another_clients_source_id() {
        let mut awareness = Awareness::new(Doc::new());
        let mut first = Presence::default();
        let mut second = Presence::default();
        let mut state = update(1, "{\"user\":{\"name\":\"Alice\"}}");
        first.accept(&mut state, &awareness).unwrap();
        let first_wire = first.client().unwrap();
        assert_ne!(first_wire.get(), 1);
        awareness.apply_update(state).unwrap();
        // Knowing or preclaiming a raw client ID cannot reserve it. The second
        // connection receives its own public ID even with the same source ID.
        let mut state = update(1, "{\"user\":{\"name\":\"Bob\"}}");
        second.accept(&mut state, &awareness).unwrap();
        let second_wire = second.client().unwrap();
        assert_ne!(first_wire, second_wire);
        awareness.apply_update(state).unwrap();
        for json in ["null", "{\"user\":{\"name\":\"Fake Alice\"}}"] {
            let mut forged = update(first_wire.get(), json);
            second.accept(&mut forged, &awareness).unwrap();
            assert!(forged.clients.is_empty());
        }
        let mut extra = update(3, "{}");
        second.accept(&mut extra, &awareness).unwrap();
        assert!(extra.clients.is_empty());
        assert_eq!(
            awareness.state::<Value>(first_wire).unwrap()["user"]["name"],
            "Alice"
        );
        assert_eq!(
            awareness.state::<Value>(second_wire).unwrap()["user"]["name"],
            "Bob"
        );
    }

    #[test]
    fn peer_clock_max_cannot_overflow_disconnect_or_poison_a_reconnect() {
        let mut awareness = Awareness::new(Doc::new());
        let mut peer = Presence::default();
        let mut state = update(1, "{}");
        state.clients.values_mut().next().unwrap().clock = u32::MAX;
        peer.accept(&mut state, &awareness).unwrap();
        let old = peer.client().unwrap();
        awareness.apply_update(state).unwrap();
        awareness.remove_state(old);
        assert_eq!(awareness.meta(old).unwrap().0, 2);
        let mut reconnected = Presence::default();
        let mut state = update(1, "{}");
        state.clients.values_mut().next().unwrap().clock = 0;
        reconnected.accept(&mut state, &awareness).unwrap();
        let fresh = reconnected.client().unwrap();
        assert_ne!(old, fresh);
        awareness.apply_update(state).unwrap();
        assert_eq!(awareness.meta(fresh).unwrap().0, 1);
        assert!(awareness.state::<Value>(fresh).is_some());
    }

    #[test]
    fn own_public_presence_is_filtered_from_broadcasts_and_queries() {
        let mut awareness = Awareness::new(Doc::new());
        let mut first = Presence::default();
        let mut state = update(1, "{}");
        first.accept(&mut state, &awareness).unwrap();
        assert!(
            first
                .outgoing(Message::Awareness(state.clone()).encode_v1())
                .is_none()
        );
        awareness.apply_update(state).unwrap();
        let mut second = Presence::default();
        let mut state = update(2, "{}");
        second.accept(&mut state, &awareness).unwrap();
        awareness.apply_update(state).unwrap();
        let frame = first
            .outgoing(Message::Awareness(awareness.update().unwrap()).encode_v1())
            .unwrap();
        let Message::Awareness(filtered) = Message::decode_v1(&frame).unwrap() else {
            panic!("Expected awareness");
        };
        assert_eq!(filtered.clients.len(), 1);
        assert!(filtered.clients.contains_key(&second.client().unwrap()));
        let mut echoed = update(first.client().unwrap().get(), "{}");
        first.accept(&mut echoed, &awareness).unwrap();
        assert!(echoed.clients.is_empty());
    }

    #[test]
    fn large_bootstrap_echoes_are_bounded_and_only_update_the_sender() {
        let mut awareness = Awareness::new(Doc::new());
        let mut peer = Presence::default();
        let mut initial = update(1, "{}");
        peer.accept(&mut initial, &awareness).unwrap();
        awareness.apply_update(initial).unwrap();
        let mut echoed = update(1, "{}");
        echoed.clients.values_mut().next().unwrap().clock += 1;
        for id in 2..=32 {
            echoed.clients.extend(update(id, "{}").clients);
        }
        let encoded = Message::Awareness(echoed).encode_v1();
        let Message::Awareness(mut echoed) = security::decode_frame(&encoded).unwrap() else {
            panic!("Expected awareness");
        };
        peer.accept(&mut echoed, &awareness).unwrap();
        assert_eq!(echoed.clients.len(), 1);
        assert!(echoed.clients.contains_key(&peer.client().unwrap()));
        assert_eq!(echoed.clients.values().next().unwrap().clock, 2);
    }
}
