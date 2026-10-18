//! The editor and CRDT share UTF-16 positions over canonical LF source. Disk
//! line endings are a projection preference, never part of those positions.
use super::*;

pub(super) fn canonical(source: &str) -> String {
    source.replace("\r\n", "\n").replace('\r', "\n")
}
pub(super) fn ending(source: &str, fallback: &str) -> String {
    if source.contains("\r\n") {
        "crlf".into()
    } else if source.contains('\r') {
        "cr".into()
    } else if source.contains('\n') {
        "lf".into()
    } else {
        fallback.into()
    }
}
pub(super) fn render(source: &str, ending: &str) -> String {
    match ending {
        "crlf" => source.replace('\n', "\r\n"),
        "cr" => source.replace('\n', "\r"),
        _ => source.into(),
    }
}
// Delete just the CR in CRLF and replace standalone CR. Keep every unaffected
// item's identity so existing selections, cursors and comment anchors survive.
pub(super) fn normalize(doc: &Doc) -> bool {
    let value = doc.get_or_insert_text("content");
    let source = value.get_string(&doc.transact());
    if !source.contains('\r') {
        return false;
    }
    let chars: Vec<_> = source.chars().collect();
    let mut position = source.encode_utf16().count() as u32;
    let mut txn = doc.transact_mut();
    for (i, ch) in chars.iter().enumerate().rev() {
        position -= ch.len_utf16() as u32;
        if *ch == '\r' {
            value.remove_range(&mut txn, position, 1);
            if chars.get(i + 1) != Some(&'\n') {
                value.insert(&mut txn, position, "\n");
            }
        }
    }
    true
}

// In-place projection writes the new prefix, then truncates. Distinguish its
// possible interrupted byte images from a complete unrelated desktop save.
pub(super) fn interrupted(before: &[u8], intended: &[u8], observed: &[u8]) -> bool {
    if observed == intended {
        return true;
    }
    if observed.len() == before.len() {
        let prefix = observed
            .iter()
            .zip(intended)
            .take_while(|(a, b)| a == b)
            .count();
        return observed[prefix..] == before[prefix..];
    }
    observed.len() > before.len()
        && observed.len() <= intended.len()
        && intended.starts_with(observed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_preserves_other_crdt_item_ids_and_utf16_positions() {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        apply_text(&doc, "", "First\r\n😀 second\r\nThird\r");
        let peer = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        peer.transact_mut()
            .apply_update(
                Update::decode_v1(
                    &doc.transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                )
                .unwrap(),
            )
            .unwrap();
        assert!(normalize(&doc));
        let old = peer.transact().state_vector();
        peer.transact_mut()
            .apply_update(
                Update::decode_v1(&doc.transact().encode_state_as_update_v1(&old)).unwrap(),
            )
            .unwrap();
        assert_eq!(
            peer.get_or_insert_text("content")
                .get_string(&peer.transact()),
            "First\n😀 second\nThird\n"
        );
        assert!(!normalize(&peer));
        for ending in ["lf", "crlf", "cr"] {
            assert_eq!(canonical(&render("a\nb\n", ending)), "a\nb\n");
        }
    }
}
