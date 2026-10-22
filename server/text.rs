//! The editor and CRDT share UTF-16 positions over canonical LF source. Disk
//! line endings are a projection detail, never part of those positions.
use super::*;
use yrs::{Observable, Out, types::Delta};

pub(super) fn canonical(source: &str) -> String {
    source.replace("\r\n", "\n").replace('\r', "\n")
}
pub(super) fn ending(source: &str, fallback: &str) -> String {
    let mut separators = String::new();
    let mut bytes = source.bytes().peekable();
    while let Some(byte) = bytes.next() {
        match byte {
            b'\r' if bytes.peek() == Some(&b'\n') => {
                bytes.next();
                separators.push('c');
            }
            b'\r' => separators.push('r'),
            b'\n' => separators.push('l'),
            _ => {}
        }
    }
    encode_endings(&separators, default_ending(fallback))
}
pub(super) fn render(source: &str, ending: &str) -> String {
    if mixed_endings(ending).is_none() {
        return match ending {
            "crlf" => source.replace('\n', "\r\n"),
            "cr" => source.replace('\n', "\r"),
            _ => source.into(),
        };
    }
    let default = default_ending(ending);
    let mut separators = mixed_endings(ending).unwrap_or_default().bytes();
    let mut result = String::with_capacity(source.len());
    for part in source.split_inclusive('\n') {
        if let Some(line) = part.strip_suffix('\n') {
            result.push_str(line);
            result.push_str(match separators.next().unwrap_or(default) {
                b'c' => "\r\n",
                b'r' => "\r",
                _ => "\n",
            });
        } else {
            result.push_str(part);
        }
    }
    result
}
/// The one separator a new file takes from a document's line endings,
/// which may record a separator for each line of another text.
pub(super) fn uniform(ending: &str) -> &'static str {
    match default_ending(ending) {
        b'c' => "crlf",
        b'r' => "cr",
        _ => "lf",
    }
}
fn default_ending(ending: &str) -> u8 {
    match ending {
        "crlf" => b'c',
        "cr" => b'r',
        _ => mixed_endings(ending)
            .and_then(|endings| endings.bytes().next())
            .unwrap_or(b'l'),
    }
}
fn mixed_endings(ending: &str) -> Option<&str> {
    ending.strip_prefix("mixed:")
}
fn encode_endings(separators: &str, fallback: u8) -> String {
    let Some(first) = separators.bytes().next() else {
        return match fallback {
            b'c' => "crlf",
            b'r' => "cr",
            _ => "lf",
        }
        .into();
    };
    if separators.bytes().any(|separator| separator != first) {
        format!("mixed:{separators}")
    } else {
        match first {
            b'c' => "crlf",
            b'r' => "cr",
            _ => "lf",
        }
        .into()
    }
}

/// Preserve each existing newline's disk separator. Only genuinely inserted
/// newlines inherit the document default. A CRDT delta avoids a lossy text diff
/// when identical lines move, concurrent edits arrive, or a newline is replaced.
/// Uniform files need no baseline decoding or extra CRDT work.
pub(super) fn projection(
    doc: &Doc,
    baseline: &[u8],
    before: &str,
    source: &str,
    ending: &str,
) -> Result<String> {
    let Some(separators) = mixed_endings(ending) else {
        return Ok(render(source, ending));
    };
    if source == before {
        return Ok(render(source, ending));
    }
    let previous = Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    });
    previous
        .transact_mut()
        .apply_update(security::decode_update(baseline).map_err(|_| bad("Invalid disk baseline."))?)
        .map_err(|_| bad("Invalid disk baseline."))?;
    let old_units: Arc<[u16]> = before.encode_utf16().collect::<Vec<_>>().into();
    let old_separators: Arc<[u8]> = separators.as_bytes().into();
    let observed = Arc::new(Mutex::new(None));
    let result = observed.clone();
    let default = default_ending(ending);
    previous
        .get_or_insert_text("content")
        .observe("line-endings", move |txn, event| {
            let mut position = 0;
            let mut separator = 0;
            let mut projected = String::new();
            for change in event.delta(txn) {
                match change {
                    Delta::Retain(length, _) | Delta::Deleted(length) => {
                        let end = position + *length as usize;
                        for unit in &old_units[position..end] {
                            if *unit == b'\n' as u16 {
                                if matches!(change, Delta::Retain(..)) {
                                    projected
                                        .push(*old_separators.get(separator).unwrap_or(&default)
                                            as char);
                                }
                                separator += 1;
                            }
                        }
                        position = end;
                    }
                    Delta::Inserted(Out::Any(yrs::Any::String(value)), _) => {
                        for _ in value.bytes().filter(|byte| *byte == b'\n') {
                            projected.push(default as char);
                        }
                    }
                    Delta::Inserted(..) => {}
                }
            }
            for unit in &old_units[position..] {
                if *unit == b'\n' as u16 {
                    projected.push(*old_separators.get(separator).unwrap_or(&default) as char);
                    separator += 1;
                }
            }
            *result.lock().unwrap() = Some(projected);
        });
    let update = doc
        .transact()
        .encode_state_as_update_v1(&previous.transact().state_vector());
    previous
        .transact_mut()
        .apply_update(
            security::decode_update(&update).map_err(|_| bad("Invalid projection state."))?,
        )
        .map_err(|_| bad("Invalid projection state."))?;
    let separators = observed
        .lock()
        .unwrap()
        .take()
        .unwrap_or_else(|| separators.into());
    Ok(render(source, &encode_endings(&separators, default)))
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
