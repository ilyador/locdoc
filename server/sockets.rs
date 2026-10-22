//! Collaboration WebSockets: admission, the sync loop and presence.
use super::*;

pub(super) async fn websocket(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    axum::extract::ConnectInfo(remote): axum::extract::ConnectInfo<std::net::SocketAddr>,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let d = s.doc(&id)?;
    let (owner, _) = s.access(&h, &d, &a)?;
    let visitor = if owner {
        None
    } else {
        Some(s.visitors.enter(peers::address(&h, remote.ip()))?)
    };
    let target = d.clone();
    let r = doc_job(s.clone(), d.id.clone(), move |s| s.room(&target)).await?;
    let protocols = browser_auth::websocket_protocol(&h)
        .into_iter()
        .collect::<Vec<_>>();
    Ok(ws
        .protocols(protocols)
        .max_message_size(6 * MB)
        .on_upgrade(move |socket| async move {
            let _visitor = visitor;
            socket_loop(socket, s, d.id, r, h, a).await
        }))
}
pub(super) async fn socket_access(
    s: &App,
    id: &str,
    headers: &HeaderMap,
    access: &Access,
    checked: &mut peers::PermissionCheck,
    force: bool,
) -> Result<()> {
    loop {
        let generation = s.permissions.current();
        if !checked.needs_check(generation, force) {
            return Ok(());
        }
        let document = id.to_string();
        let headers = headers.clone();
        let access = access.clone();
        let result = job(s.clone(), move |s| {
            s.doc(&document)
                .and_then(|d| s.access(&headers, &d, &access))?;
            Ok(())
        })
        .await;
        if s.permissions.current() != generation {
            // Never cache an old result under a newer generation when a share
            // or session mutation completed while the check was queued.
            continue;
        }
        result?;
        checked.checked(generation);
        return Ok(());
    }
}
async fn send_socket(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    frame: WsMessage,
) -> bool {
    // A peer which never reads must not keep a visitor slot by blocking the
    // heartbeat in a full TCP send buffer. Slow clients retain their draft.
    tokio::time::timeout(peers::PING_INTERVAL * 2, sender.send(frame))
        .await
        .is_ok_and(|result| result.is_ok())
}
async fn close_socket(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
) {
    // Drain the peer's already queued handshake through the close exchange.
    // Dropping a TCP socket with unread data can reset it and lose the error
    // frame which tells an older editor to preserve and recover its draft.
    let _ = tokio::time::timeout(std::time::Duration::from_millis(250), async {
        if sender.send(WsMessage::Close(None)).await.is_err() {
            return;
        }
        while let Some(frame) = receiver.next().await {
            if matches!(frame, Ok(WsMessage::Close(_)) | Err(_)) {
                break;
            }
        }
    })
    .await;
}
async fn socket_loop(
    socket: WebSocket,
    s: App,
    id: String,
    room: Arc<Mutex<Room>>,
    h: HeaderMap,
    a: Access,
) {
    let (mut sender, mut receiver) = socket.split();
    let document_id = id.clone();
    let access_epoch = a.epoch.clone();
    let outdated = job(s.clone(), move |s| {
        Ok(s.epoch(&document_id)
            .is_ok_and(|epoch| access_epoch.as_deref().unwrap_or("") != epoch))
    })
    .await
    .unwrap_or(true);
    if (h.contains_key(header::ORIGIN) && a.client.as_deref() != Some("plain-text-v2")) || outdated
    {
        // Old editors cannot safely interpret the new source records. Their
        // existing error handler stops reconnecting and preserves local drafts.
        let _ = send_socket(&mut sender, WsMessage::Binary(Message::Custom(125,
            b"Locdoc was updated. Reload to continue. Your unsaved browser draft is kept here.".to_vec()
        ).encode_v1().into())).await;
        close_socket(&mut sender, &mut receiver).await;
        return;
    }
    let mut peer = Peer::default();
    let target = room.clone();
    let document_id = id.clone();
    let headers = h.clone();
    let access = a.clone();
    let initial = doc_job(s.clone(), id.clone(), move |s| {
        s.doc(&document_id)
            .and_then(|d| s.access(&headers, &d, &access))?;
        let mut r = target.lock().unwrap();
        r.ensure_committed(s, &s.doc(&document_id)?)?;
        let rx = r.tx.subscribe();
        let mut frames = vec![
            r.projection_status(),
            Message::Sync(SyncMessage::SyncStep1(
                r.awareness.doc().transact().state_vector(),
            ))
            .encode_v1(),
        ];
        if let Ok(u) = r.awareness.update() {
            frames.push(Message::Awareness(u).encode_v1());
        }
        Ok((rx, frames))
    })
    .await;
    let Ok((mut rx, initial)) = initial else {
        return;
    };
    for data in initial {
        if !send_socket(&mut sender, WsMessage::Binary(data.into())).await {
            return;
        }
    }
    let mut pulse = tokio::time::interval(peers::PING_INTERVAL);
    pulse.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heartbeat = peers::Heartbeat::default();
    let mut permission = peers::PermissionCheck::default();
    let mut frames = 0u32;
    'connection: loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(WsMessage::Binary(bytes))) => {
                    frames += 1;
                    if frames > 1500 { break; }
                    let document_id = id.clone();
                    let mut state = std::mem::take(&mut peer);
                    let target = room.clone();
                    let headers = h.clone();
                    let access = a.clone();
                    let outcome = doc_job(s.clone(), id.clone(), move |s| {
                        // Authorization belongs after the work queue as well:
                        // a link may have been revoked while this job waited.
                        let result = s.doc(&document_id).and_then(|current| {
                            let (owner, edit) = s.access(&headers, &current, &access)?;
                            process_frame(s, &current, &target, &bytes, edit, owner, &mut state)
                        });
                        Ok((state, result))
                    }).await;
                    let result = match outcome { Ok((state, result)) => { peer = state; result }, Err(error) => Err(error) };
                    match result {
                        Ok(responses) => {
                            for frame in responses {
                                if !send_socket(&mut sender, WsMessage::Binary(frame.into())).await { break 'connection; }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("sync rejected: {}", e.1);
                            let _ = send_socket(&mut sender, WsMessage::Binary(Message::Custom(if e.0.is_server_error() {120} else {125}, e.1.into_bytes()).encode_v1().into())).await;
                            break;
                        }
                    }
                }
                Some(Ok(WsMessage::Pong(bytes))) => heartbeat.pong(&bytes),
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            outgoing = rx.recv() => match outgoing {
                Ok(data) => {
                    if data == [126] { break; }
                    if socket_access(&s, &id, &h, &a, &mut permission, false).await.is_err() { break; }
                    let Some(data) = peer.presence.outgoing(data) else { continue; };
                    if !send_socket(&mut sender, WsMessage::Binary(data.into())).await { break; }
                }
                Err(_) => break,
            },
            _ = pulse.tick() => {
                frames = 0;
                // Filesystem replacement and natural session expiry need a
                // live check even when no settings generation has changed.
                if socket_access(&s, &id, &h, &a, &mut permission, true).await.is_err() { break; }
                let Some(nonce) = heartbeat.ping() else { break; };
                if !send_socket(&mut sender, WsMessage::Ping(nonce.to_vec().into())).await { break; }
            }
        }
    }
    let _ = doc_job(s.clone(), id, move |_| {
        let mut r = room.lock().unwrap();
        r.detach(&peer);
        Ok(())
    })
    .await;
    close_socket(&mut sender, &mut receiver).await;
}
pub(super) fn valid_presence(json: &str) -> bool {
    fn color(v: &Value, alpha: bool) -> bool {
        v.as_str().is_some_and(|s| {
            (s.len() == 7 || (alpha && s.len() == 9))
                && s.starts_with('#')
                && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    }
    fn position(v: &Value) -> bool {
        let Some(p) = v.as_object() else {
            return false;
        };
        let id = |v: &Value| {
            v.as_object().is_some_and(|o| {
                o.get("client")
                    .and_then(Value::as_u64)
                    .is_some_and(|n| n <= 9_007_199_254_740_991)
                    && o.get("clock")
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n <= u32::MAX as u64)
            })
        };
        p.get("type").is_none_or(|v| v.is_null() || id(v))
            && p.get("item").is_none_or(|v| v.is_null() || id(v))
            && p.get("tname")
                .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| s.len() <= 100))
            && p.get("assoc")
                .is_none_or(|v| v.as_i64().is_some_and(|n| i32::try_from(n).is_ok()))
    }
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return false;
    };
    if value.is_null() {
        return true;
    }
    let Some(state) = value.as_object() else {
        return false;
    };
    let user_ok = state.get("user").is_none_or(|user| {
        user.as_object().is_some_and(|u| {
            u.get("name").and_then(Value::as_str).is_some_and(|n| {
                !n.trim().is_empty() && n.chars().count() <= 60 && !n.chars().any(char::is_control)
            }) && u.get("color").is_none_or(|v| color(v, false))
                && u.get("colorLight").is_none_or(|v| color(v, true))
        })
    });
    user_ok
        && state.get("cursor").is_none_or(|cursor| {
            cursor.is_null()
                || cursor.as_object().is_some_and(|c| {
                    c.get("anchor").is_some_and(position) && c.get("head").is_some_and(position)
                })
        })
}
pub(super) struct Peer {
    pub(super) id: uuid::Uuid,
    pub(super) presence: peers::Presence,
    pub(super) media_paths: HashSet<PathBuf>,
    pub(super) awaiting_sync: bool,
    pub(super) held_receipt: Option<String>,
}
impl Default for Peer {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4(),
            presence: peers::Presence::default(),
            media_paths: HashSet::new(),
            awaiting_sync: false,
            held_receipt: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::store;

    #[test]
    fn malformed_viewer_presence_is_rejected_before_broadcast() {
        let (_dir, s) = store();
        fs::write(s.root.join("presence.md"), "Hello").unwrap();
        let d = s.index_document("presence.md").unwrap();
        let room = s.room(&d).unwrap();
        let mut peer = Awareness::new(Doc::new());
        peer.set_local_state(json!({"user":{"name":42,"color":"#487495"}}))
            .unwrap();
        let frame = Message::Awareness(peer.update().unwrap()).encode_v1();
        assert!(process_frame(&s, &d, &room, &frame, false, false, &mut Peer::default()).is_err());
        peer.set_local_state(json!({"user":{"name":"Alice","color":"#487495"}}))
            .unwrap();
        let frame = Message::Awareness(peer.update().unwrap()).encode_v1();
        assert!(process_frame(&s, &d, &room, &frame, false, false, &mut Peer::default()).is_ok());
        for invalid in [
            json!({"user":{"name":"Alice","color":"red;position:fixed"}}),
            json!({"cursor":{"anchor":{"item":{"client":1,"clock":"bad"}},"head":{}}}),
            json!({"user":{"name":"\n"}}),
        ] {
            assert!(!valid_presence(&invalid.to_string()));
        }
    }
}
