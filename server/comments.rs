//! Markdown is the canonical comment body/thread store. SQLite retains only
//! stable identity, selected-passage anchors, timestamps and resolution state.
//! Every source edit uses the same CRDT + durable projection as normal writing.
use super::*;
use std::{ops::Range, sync::LazyLock};
use yrs::{Assoc, IndexedSequence, StickyIndex};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct MessageText {
    name: String,
    body: String,
}
#[derive(Debug)]
struct Thread {
    from: usize,
    to: usize,
    messages: Vec<MessageText>,
}
static PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"\[\[comment\(((?:\\[^\r\n]|[^\\)\r\n])*)\):[ \t]*((?:\\[^\r\n]|[^\\\r\n])*?)\]\]",
    )
    .unwrap()
});

fn decode(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
        {
            match next {
                'n' => {
                    out.push('\n');
                    chars.next();
                    continue;
                }
                'r' => {
                    out.push('\r');
                    chars.next();
                    continue;
                }
                '\\' | ')' | ']' => {
                    out.push(next);
                    chars.next();
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
    }
    out
}
fn encode(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(')', "\\)")
        .replace(']', "\\]")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}
fn record(name: &str, body: &str) -> String {
    format!(
        "[[comment({}): {}]]",
        encode(name.trim()),
        encode(body.trim())
    )
}
fn valid(body: &str, name: &str) -> bool {
    !body.trim().is_empty()
        && body.chars().count() <= 4000
        && !name.trim().is_empty()
        && name.chars().count() <= 60
        && !name.chars().any(char::is_control)
}
fn line_breaks(source: &str) -> usize {
    let mut count = 0;
    let mut carriage_return = false;
    for c in source.chars() {
        if c == '\r' || (c == '\n' && !carriage_return) {
            count += 1;
        }
        carriage_return = c == '\r';
    }
    count
}
fn parse(source: &str) -> Vec<Thread> {
    if !source.contains("[[comment(") {
        return Vec::new();
    }
    let code: Vec<Range<usize>> = parser(source)
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(
                event,
                pulldown_cmark::Event::Code(_)
                    | pulldown_cmark::Event::Html(_)
                    | pulldown_cmark::Event::InlineHtml(_)
                    | pulldown_cmark::Event::Start(
                        pulldown_cmark::Tag::CodeBlock(_)
                            | pulldown_cmark::Tag::HtmlBlock
                            | pulldown_cmark::Tag::Link { .. }
                            | pulldown_cmark::Tag::Image { .. }
                    )
            )
            .then_some(range)
        })
        .collect();
    let mut threads: Vec<Thread> = Vec::new();
    for c in PATTERN.captures_iter(source) {
        let m = c.get(0).unwrap();
        let escaped = source[..m.start()]
            .chars()
            .rev()
            .take_while(|&c| c == '\\')
            .count()
            % 2
            == 1;
        if escaped
            || code.iter().any(|r| {
                r.contains(&m.start())
                    && !threads.iter().any(|t| t.from <= r.start && r.start < t.to)
            })
        {
            continue;
        }
        let name = decode(&c[1]).trim().to_string();
        let body = decode(&c[2]).trim().to_string();
        if !valid(&body, &name) {
            continue;
        }
        let message = MessageText { name, body };
        if let Some(t) = threads.last_mut() {
            let gap = &source[t.to..m.start()];
            if gap.chars().all(|c| matches!(c, ' ' | '\t' | '\r' | '\n')) && line_breaks(gap) <= 1 {
                t.to = m.end();
                t.messages.push(message);
                continue;
            }
        }
        threads.push(Thread {
            from: m.start(),
            to: m.end(),
            messages: vec![message],
        });
    }
    threads
}
pub(super) fn reading_source(source: &str) -> String {
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for t in parse(source) {
        if let Some(previous) = ranges.last_mut()
            && source[previous.end..t.from].trim().is_empty()
        {
            previous.end = t.to;
        } else {
            ranges.push(t.from..t.to);
        }
    }
    let mut out = String::new();
    let mut from = 0;
    for range in ranges {
        out.push_str(&source[from..range.start]);
        from = range.end;
    }
    out.push_str(&source[from..]);
    out
}
/// Source without its comment records, for a copy that starts a new
/// document. A record on a line of its own leaves with that line and with
/// one of the blank lines that set it apart, so the copy keeps no gap where
/// a conversation was. Text the parser leaves literal, as in code, stays.
pub(super) fn without_records(source: &str) -> String {
    fn leading_break(text: &str) -> usize {
        if text.starts_with("\r\n") {
            2
        } else {
            usize::from(text.starts_with(['\n', '\r']))
        }
    }
    fn trailing_break(text: &str) -> usize {
        if text.ends_with("\r\n") {
            2
        } else {
            usize::from(text.ends_with(['\n', '\r']))
        }
    }
    // Nothing, or a blank line, comes before the line starting here.
    fn blank_before(text: &str) -> bool {
        let line = text[..text.len() - trailing_break(text)].trim_end_matches([' ', '\t']);
        text.is_empty() || line.is_empty() || line.ends_with(['\n', '\r'])
    }
    let mut out = source.to_owned();
    for thread in parse(source).iter().rev() {
        let before = out[..thread.from].trim_end_matches([' ', '\t']);
        let rest = out[thread.to..].trim_start_matches([' ', '\t']);
        let own_line = before.is_empty() || before.ends_with(['\n', '\r']);
        let mut start = thread.from;
        let mut end = thread.to;
        if own_line || before.len() < thread.from {
            // One space between the words either side is enough.
            end = out.len() - rest.len();
        }
        if rest.is_empty() || rest.starts_with(['\n', '\r']) {
            // Nothing of it stays at the end of its line.
            start = before.len();
            end = out.len() - rest.len();
            if own_line {
                end += leading_break(rest);
                let after = &out[end..];
                let separated = after.trim_start_matches([' ', '\t']);
                if blank_before(before) {
                    if after.is_empty() {
                        start -= trailing_break(before);
                    } else if separated.is_empty() || separated.starts_with(['\n', '\r']) {
                        end += after.len() - separated.len() + leading_break(separated);
                    }
                }
            }
        }
        out.replace_range(start..end, "");
    }
    out
}
fn utf16(source: &str, byte: usize) -> u32 {
    source[..byte].encode_utf16().count() as u32
}
fn byte(source: &str, offset: u32) -> Option<usize> {
    let mut index = 0;
    for (byte, c) in source.char_indices() {
        if index == offset {
            return Some(byte);
        }
        index += c.len_utf16() as u32;
    }
    (index == offset).then_some(source.len())
}
fn doc_relative(doc: &Doc, index: u32, assoc: Assoc) -> Value {
    let text = doc.get_or_insert_text("content");
    let txn = doc.transact();
    json!(text.sticky_index(&txn, index, assoc).unwrap())
}
fn relative(r: &Room, index: u32, assoc: Assoc) -> Value {
    doc_relative(r.awareness.doc(), index, assoc)
}
fn index_shape(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    let mut scope = false;
    for (key, value) in fields {
        match key.as_str() {
            "item" | "type" if !value.is_null() => {
                let Some(id) = value.as_object() else {
                    return false;
                };
                if id.len() != 2
                    || !id
                        .get("client")
                        .and_then(Value::as_u64)
                        .is_some_and(|client| client <= 9_007_199_254_740_991)
                    || !id
                        .get("clock")
                        .and_then(Value::as_u64)
                        .is_some_and(|clock| clock <= u32::MAX as u64)
                {
                    return false;
                }
                scope = true;
            }
            "tname" if !value.is_null() => {
                if !value.as_str().is_some_and(|name| name.len() <= 100) {
                    return false;
                }
                scope = true;
            }
            "assoc" if !value.is_null() => {
                if !matches!(value.as_i64(), Some(-1 | 0)) {
                    return false;
                }
            }
            "item" | "type" | "tname" | "assoc" => {}
            _ => return false,
        }
    }
    scope
}
fn doc_offset(doc: &Doc, value: &Value) -> Option<u32> {
    // yrs ClientID's serde constructor assumes JavaScript's 53-bit bound.
    // Guard every ID (including unused alternative scopes) before invoking it.
    if !index_shape(value) {
        return None;
    }
    let sticky: StickyIndex = serde_json::from_value(value.clone()).ok()?;
    let text = doc.get_or_insert_text("content");
    let txn = doc.transact();
    let position = sticky.get_offset(&txn)?;
    // Never accept an anchor into another shared type.
    let branch: &yrs::branch::Branch = text.as_ref();
    std::ptr::eq(position.branch.as_ref(), branch).then_some(position.index)
}
fn offset(r: &Room, value: &Value) -> Option<u32> {
    doc_offset(r.awareness.doc(), value)
}
fn validate_anchor(anchor: &Value) -> Result<()> {
    if !anchor.as_object().is_some_and(|fields| fields.len() == 2)
        || !index_shape(&anchor["start"])
        || !index_shape(&anchor["end"])
    {
        return Err(bad("Invalid comment anchor."));
    }
    Ok(())
}
fn anchor_pending() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "This passage has not synced yet. Wait a moment and post again.".into(),
    )
}
fn anchor_ready(r: &Room, anchor: &Value) -> bool {
    offset(r, &anchor["start"]).is_some() && offset(r, &anchor["end"]).is_some()
}
async fn await_anchor(s: App, id: &str, room: &Arc<Mutex<Room>>, anchor: &Value) -> Result<()> {
    // HTTP may overtake its selected WebSocket characters. Subscribe and check
    // atomically, then await committed source updates without occupying a
    // worker or repeatedly competing for a busy room's lock.
    let wait = async {
        let target = room.clone();
        let selected = anchor.clone();
        let (ready, mut updates) = doc_job(s.clone(), id.to_string(), move |_| {
            let r = target.lock().unwrap();
            Ok((anchor_ready(&r, &selected), r.tx.subscribe()))
        })
        .await?;
        if ready {
            return Ok(());
        }
        loop {
            match updates.recv().await {
                Ok(update) if !update.starts_with(&[0, 2]) => continue,
                Err(broadcast::error::RecvError::Closed) => return Err(anchor_pending()),
                // Lag may have skipped precisely the update we need. Check
                // current accepted state instead of waiting for another one.
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
            }
            let target = room.clone();
            let selected = anchor.clone();
            if doc_job(s.clone(), id.to_string(), move |_| {
                Ok(anchor_ready(&target.lock().unwrap(), &selected))
            })
            .await?
            {
                return Ok(());
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), wait)
        .await
        .unwrap_or_else(|_| Err(anchor_pending()))
}
fn parser(source: &str) -> pulldown_cmark::Parser<'_> {
    pulldown_cmark::Parser::new_ext(
        source,
        pulldown_cmark::Options::all().difference(pulldown_cmark::Options::ENABLE_WIKILINKS),
    )
}

// The passage anchor and the location of its raw-file records serve different
// purposes. Keep the original anchor, but store records after the containing
// top-level block so a selection cannot cut a paragraph, list, table or tag.
fn insertion_point(source: &str, at: usize) -> usize {
    let target = source[..at].char_indices().last().map_or(at, |(i, _)| i);
    let mut depth = 0;
    for (event, range) in parser(source).into_offset_iter() {
        match event {
            pulldown_cmark::Event::Start(_) => {
                if depth == 0 && range.start <= target && target < range.end {
                    return range.end;
                }
                depth += 1;
            }
            pulldown_cmark::Event::End(_) => depth -= 1,
            _ if depth == 0 && range.start <= target && target < range.end => return range.end,
            _ => {}
        }
    }
    at
}

// Compare rendered Markdown, not byte offsets: block separators may gain blank
// lines, but adding a hidden record must not change prose, list nesting, tables,
// headings, links, or literal HTML/code. HTML's trailing line terminator is not
// semantic and may be supplied by the new block separator.
fn visible_structure(source: &str) -> impl Iterator<Item = pulldown_cmark::Event<'_>> {
    parser(source).filter_map(|event| match event {
        pulldown_cmark::Event::Html(value) => {
            let mut value = value.into_string();
            value.truncate(value.trim_end_matches(['\r', '\n']).len());
            (!value.is_empty()).then(|| pulldown_cmark::Event::Html(value.into()))
        }
        _ => Some(event),
    })
}
fn same_visible_structure(before: &str, after: &str) -> bool {
    let before = reading_source(before);
    let after = reading_source(after);
    visible_structure(&before).eq(visible_structure(&after))
}

fn valid_candidate(source: &str, candidate: &str, expected: &[(usize, &[MessageText])]) -> bool {
    let parsed = parse(candidate);
    parsed.len() == expected.len()
        && expected.iter().all(|(from, messages)| {
            parsed
                .binary_search_by_key(from, |thread| thread.from)
                .is_ok_and(|index| parsed[index].messages == *messages)
        })
        && same_visible_structure(source, candidate)
}

struct Insertion {
    at: usize,
    encoded: String,
    marker: usize,
}
fn root_record(
    source: &str,
    threads: &[Thread],
    at: usize,
    messages: &[MessageText],
) -> Result<Insertion> {
    let at = insertion_point(source, at);
    let prefix = if at == 0 || source[..at].ends_with("\n\n") {
        ""
    } else if source[..at].ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    let suffix = if at == source.len() || source[at..].starts_with("\n\n") {
        ""
    } else if source[at..].starts_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    let body = messages
        .iter()
        .map(|message| record(&message.name, &message.body))
        .collect::<Vec<_>>()
        .join("\n");
    let encoded = format!("{prefix}{body}{suffix}");
    let candidate = format!("{}{}{}", &source[..at], encoded, &source[at..]);
    let marker = at + prefix.len();
    let mut expected = threads
        .iter()
        .map(|thread| {
            let shifted = thread.from + if thread.from >= at { encoded.len() } else { 0 };
            (shifted, thread.messages.as_slice())
        })
        .collect::<Vec<_>>();
    expected.push((marker, messages));
    if valid_candidate(source, &candidate, &expected) {
        Ok(Insertion {
            at,
            encoded,
            marker,
        })
    } else {
        // In particular an unfinished fence/HTML block may still consume the
        // records. Never invent closing syntax or acknowledge a hidden thread.
        Err(bad("Close this Markdown block before adding a comment."))
    }
}
fn metadata(s: &Store, id: &str) -> Result<Vec<Value>> {
    let db = s.db.lock().unwrap();
    let mut q = db.prepare("SELECT data FROM comments WHERE doc=? ORDER BY rowid")?;
    Ok(q.query_map([id], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok().and_then(|v| serde_json::from_str(&v).ok()))
        .collect())
}
fn preceding_passage(source: &str, threads: &[Thread], at: usize) -> std::ops::Range<usize> {
    let mut end = source[..at].trim_end().len();
    // Separate conversations may follow the same prose. Never anchor a new
    // raw-file conversation to another conversation's hidden source records.
    for previous in threads.iter().rev().filter(|t| t.to <= at) {
        if previous.to == end {
            end = source[..previous.from].trim_end().len();
        }
    }
    let line = source[..end].rfind('\n').map_or(0, |n| n + 1);
    let from = line + source[line..end].len() - source[line..end].trim_start().len();
    from..end
}
fn unique_passage(source: &str, threads: &[Thread], quote: &str) -> Option<Range<usize>> {
    if quote.is_empty() {
        return None;
    }
    let mut result = None;
    let mut from = 0;
    while let Some(index) = source[from..].find(quote) {
        let start = from + index;
        let end = start + quote.len();
        if !threads
            .iter()
            .any(|thread| start < thread.to && end > thread.from)
        {
            if result.is_some() {
                return None;
            }
            result = Some(start..end);
        }
        from = start + source[start..].chars().next()?.len_utf8();
    }
    result
}
fn thread_value(
    r: &Room,
    source: &str,
    threads: &[Thread],
    t: &Thread,
    stored: Option<&Value>,
    doc_id: &str,
) -> Value {
    let start = utf16(source, t.from);
    let marker = relative(r, start, Assoc::After);
    let mut c = stored.cloned().unwrap_or_else(|| {
        let passage = preceding_passage(source, threads, t.from);
        let (from, end) = (passage.start, passage.end);
        json!({"id":format!("md-{}-{}-{}",doc_id,marker["item"]["client"],marker["item"]["clock"]),"guest":"","created":0,"resolved":false,
            "quote":&source[from..end],"anchor":{"start":relative(r,utf16(source,from),Assoc::After),"end":relative(r,utf16(source,end),Assoc::Before)},"replies":[]})
    });
    c["source"] = marker;
    if offset(r, &c["anchor"]["start"]).is_none() || offset(r, &c["anchor"]["end"]).is_none() {
        let passage = preceding_passage(source, threads, t.from);
        c["quote"] = json!(&source[passage.clone()]);
        c["anchor"] = json!({"start":relative(r,utf16(source,passage.start),Assoc::After),"end":relative(r,utf16(source,passage.end),Assoc::Before)});
    }
    let first = &t.messages[0];
    if c["name"] != first.name || c["body"] != first.body {
        c["created"] = json!(0);
    }
    c["name"] = json!(first.name);
    c["body"] = json!(first.body);
    let old = c["replies"].as_array().cloned().unwrap_or_default();
    c["replies"] = json!(
        t.messages
            .iter()
            .skip(1)
            .enumerate()
            .map(|(i, m)| {
                let created = old
                    .get(i)
                    .filter(|v| v["name"] == m.name && v["body"] == m.body)
                    .map_or(0, |v| v["created"].as_i64().unwrap_or(0));
                json!({"name":m.name,"body":m.body,"created":created})
            })
            .collect::<Vec<_>>()
    );
    c
}

fn stored_messages(row: &Value) -> Option<Vec<MessageText>> {
    let mut messages = Vec::new();
    let mut push = |value: &Value| {
        let name = value["name"].as_str()?;
        let body = value["body"].as_str()?;
        valid(body, name).then(|| {
            messages.push(MessageText {
                name: name.to_string(),
                body: body.to_string(),
            });
        })
    };
    push(row)?;
    for reply in row["replies"].as_array()? {
        push(reply)?;
    }
    Some(messages)
}
fn source_id(marker: &Value) -> Option<(u64, u64)> {
    Some((
        marker["item"]["client"].as_u64()?,
        marker["item"]["clock"].as_u64()?,
    ))
}
fn reanchor_moved(
    r: &Room,
    source: &str,
    threads: &[Thread],
    thread: &Thread,
    previous: &Value,
    value: &mut Value,
) {
    let quote = previous["quote"].as_str().filter(|quote| !quote.is_empty());
    let matching = (|| {
        let from = offset(r, &previous["anchor"]["start"])?;
        let to = offset(r, &previous["anchor"]["end"])?;
        if from >= to {
            return None;
        }
        let selected = &source[byte(source, from)?..byte(source, to)?];
        Some(quote.is_none_or(|quote| reading_source(selected).starts_with(quote)))
    })()
    .unwrap_or(false);
    if matching {
        return;
    }
    let passage = quote
        .and_then(|quote| unique_passage(source, threads, quote))
        .unwrap_or_else(|| preceding_passage(source, threads, thread.from));
    value["quote"] = json!(&source[passage.clone()]);
    value["anchor"] = json!({
        "start": relative(r, utf16(source, passage.start), Assoc::After),
        "end": relative(r, utf16(source, passage.end), Assoc::Before),
    });
}

// A raw cut/paste creates new CRDT items. Reattach dates/resolution only when
// the complete conversation is unique on both sides and the original marker
// is gone. Copies, duplicate conversations, altered replies and literal/code
// records never acquire another thread's metadata. This is document-local;
// author privileges and idempotency receipts never follow recreated text.
fn thread_values(
    r: &Room,
    source: &str,
    threads: &[Thread],
    meta: &[Value],
    doc_id: &str,
) -> (Vec<Value>, Vec<Value>) {
    let markers: Vec<_> = threads
        .iter()
        .map(|thread| relative(r, utf16(source, thread.from), Assoc::After))
        .collect();
    let signatures: Vec<_> = meta.iter().map(stored_messages).collect();
    let mut metadata_signatures = HashMap::<&[MessageText], (usize, usize)>::new();
    let mut thread_counts = HashMap::<&[MessageText], usize>::new();
    let mut by_marker = HashMap::new();
    for (index, row) in meta.iter().enumerate() {
        if let Some(id) = source_id(&row["source"]) {
            by_marker.entry(id).or_insert(index);
        }
    }
    for (index, signature) in signatures.iter().enumerate() {
        if let Some(signature) = signature {
            let entry = metadata_signatures
                .entry(signature.as_slice())
                .or_insert((0, index));
            entry.0 += 1;
        }
    }
    for thread in threads {
        *thread_counts.entry(&thread.messages).or_default() += 1;
    }
    let mut changed = Vec::new();
    let values = threads
        .iter()
        .zip(markers)
        .map(|(thread, marker)| {
            let direct = source_id(&marker).and_then(|id| by_marker.get(&id).copied());
            let moved = direct
                .is_none()
                .then(|| {
                    let &(count, index) = metadata_signatures.get(thread.messages.as_slice())?;
                    if count != 1 || thread_counts.get(thread.messages.as_slice()) != Some(&1) {
                        return None;
                    }
                    let previous = &meta[index]["source"];
                    previous["item"].as_object()?;
                    // A marker can still exist inside a fence/escaped record or a
                    // partially edited conversation. Such text has not been cut.
                    let alive = offset(r, previous).is_some_and(|at| {
                        relative(r, at, Assoc::After)["item"] == previous["item"]
                    });
                    (!alive).then_some(index)
                })
                .flatten();
            let stored = direct.or(moved).map(|index| &meta[index]);
            let mut value = thread_value(r, source, threads, thread, stored, doc_id);
            if moved.is_some() {
                value["guest"] = json!("");
                value.as_object_mut().unwrap().remove("requestId");
                value.as_object_mut().unwrap().remove("replyRequests");
                reanchor_moved(r, source, threads, thread, stored.unwrap(), &mut value);
            }
            // Remember independent copies too. A later deletion of the first
            // conversation must not turn an already-seen copy into a move.
            if stored.is_none_or(|old| *old != value) {
                changed.push(value.clone());
            }
            value
        })
        .collect();
    (values, changed)
}

// Explicit owner maintenance may replace CRDT identities while keeping the
// source. Duplicate conversations still require their original source items.
pub(super) fn rebuild_metadata(
    old: &Room,
    fresh: &Doc,
    source: &str,
    rows: &[Value],
) -> Vec<Value> {
    let previous = room_text(old);
    let old_threads = parse(&previous);
    let threads = parse(source);
    let identical = previous == source;
    let source_length = source.encode_utf16().count() as u32;
    let markers: Vec<_> = old_threads
        .iter()
        .map(|thread| relative(old, utf16(&previous, thread.from), Assoc::After))
        .collect();
    let originals: Vec<Option<usize>> = rows
        .iter()
        .map(|row| {
            markers
                .iter()
                .position(|marker| row["source"]["item"] == marker["item"])
        })
        .collect();
    let serialized: Vec<Option<String>> = rows
        .iter()
        .zip(&originals)
        .map(|(row, original)| {
            if let Some(index) = original {
                return Some(
                    previous[old_threads[*index].from..old_threads[*index].to].to_string(),
                );
            }
            let name = row["name"].as_str()?;
            let body = row["body"].as_str()?;
            if !valid(body, name) {
                return None;
            }
            let mut value = record(name, body);
            for reply in row["replies"].as_array()? {
                let name = reply["name"].as_str()?;
                let body = reply["body"].as_str()?;
                if !valid(body, name) {
                    return None;
                }
                value.push('\n');
                value.push_str(&record(name, body));
            }
            Some(value)
        })
        .collect();
    let reserved: HashSet<usize> = if identical {
        originals.iter().flatten().copied().collect()
    } else {
        HashSet::new()
    };
    let mut used = HashSet::new();
    let mut rebuilt = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let direct = identical.then_some(originals[index]).flatten();
        let selected = direct.or_else(|| {
            let raw = serialized[index].as_ref()?;
            // Both sides must be unique; two identical conversations have no
            // trustworthy identity after the source itself was replaced.
            if serialized
                .iter()
                .filter(|other| other.as_ref() == Some(raw))
                .count()
                != 1
            {
                return None;
            }
            let mut matches = threads
                .iter()
                .enumerate()
                .filter(|(_, thread)| source[thread.from..thread.to] == *raw);
            let (index, _) = matches.next()?;
            (matches.next().is_none() && !reserved.contains(&index)).then_some(index)
        });
        let Some(selected) = selected else {
            continue;
        };
        if !used.insert(selected) {
            continue;
        }
        let thread = &threads[selected];
        let anchored = identical
            .then(|| {
                let start = offset(old, &row["anchor"]["start"])?;
                let end = offset(old, &row["anchor"]["end"])?;
                (start <= end && end <= source_length).then_some((start, end))
            })
            .flatten();
        let quoted = || {
            let passage = unique_passage(source, &threads, row["quote"].as_str()?)?;
            Some((utf16(source, passage.start), utf16(source, passage.end)))
        };
        let passage = preceding_passage(source, &threads, thread.from);
        let selected = anchored.or_else(quoted);
        let (from, to) =
            selected.unwrap_or_else(|| (utf16(source, passage.start), utf16(source, passage.end)));
        let mut row = row.clone();
        if selected.is_none() {
            row["quote"] = json!(&source[passage]);
        }
        row["source"] = doc_relative(fresh, utf16(source, thread.from), Assoc::After);
        let start = doc_relative(fresh, from, Assoc::After);
        let end = doc_relative(fresh, to, Assoc::Before);
        row["anchor"] = json!({"start":start, "end":end});
        rebuilt.push(row);
    }
    rebuilt
}

#[cfg(test)]
fn commit(s: &Store, d: &Document, r: &mut Room, rows: &[Value]) -> Result<()> {
    r.accept_test_command(s, d, rows)
}

fn insert(r: &Room, at: u32, value: &str) {
    let text = r.awareness.doc().get_or_insert_text("content");
    text.insert(&mut r.awareness.doc().transact_mut(), at, value);
}
fn migrate(s: &Store, d: &Document, r: &mut Room, meta: &mut [Value]) -> Result<()> {
    if !meta.iter().any(|c| c.get("source").is_none()) {
        return Ok(());
    }
    let original = room_text(r);
    let mut candidate = original.clone();
    let original_threads = parse(&original);
    let mut planned = Vec::<(usize, Insertion, Value)>::new();
    // Validate the entire migration before changing even one CRDT item. A bad
    // legacy record must leave its metadata and all existing threads intact.
    for (index, old) in meta
        .iter()
        .enumerate()
        .filter(|(_, c)| c.get("source").is_none())
    {
        let mut c = old.clone();
        if (offset(r, &c["anchor"]["start"]).is_none() || offset(r, &c["anchor"]["end"]).is_none())
            && let Some(passage) = c["quote"]
                .as_str()
                .and_then(|quote| unique_passage(&original, &original_threads, quote))
        {
            let start = relative(r, utf16(&original, passage.start), Assoc::After);
            let end = relative(r, utf16(&original, passage.end), Assoc::Before);
            c["anchor"] = json!({"start":start,"end":end});
        }
        let end = offset(r, &c["anchor"]["end"]).unwrap_or(original.encode_utf16().count() as u32);
        let mut at = byte(&original, end).unwrap_or(original.len());
        for (_, insertion, _) in &planned {
            if insertion.at <= at {
                at += insertion.encoded.len();
            }
        }
        let mut messages = Vec::new();
        let normalize = |value: &mut Value, fallback: &str| -> Result<MessageText> {
            let name = if value["name"] == "You" {
                s.owner_name.as_str()
            } else {
                value["name"].as_str().unwrap_or("Guest")
            }
            .trim()
            .to_string();
            let body = value["body"]
                .as_str()
                .unwrap_or(fallback)
                .trim()
                .to_string();
            if !valid(&body, &name) {
                return Err(bad(
                    "A legacy comment needs a valid name and body before it can be migrated.",
                ));
            }
            value["name"] = json!(name);
            value["body"] = json!(body);
            Ok(MessageText { name, body })
        };
        messages.push(normalize(&mut c, "Comment")?);
        if let Some(replies) = c["replies"].as_array_mut() {
            for reply in replies {
                messages.push(normalize(reply, "Reply")?);
            }
        }
        let insertion = root_record(&candidate, &parse(&candidate), at, &messages)?;
        if candidate.len() + insertion.encoded.len() > 5 * MB {
            return Err(bad("Document exceeds 5 MB."));
        }
        candidate.insert_str(insertion.at, &insertion.encoded);
        planned.push((index, insertion, c));
    }
    r.edit(s, d, |room| {
        for (index, insertion, mut c) in planned {
            let source = room_text(room);
            let at = utf16(&source, insertion.at);
            let prefix = &insertion.encoded[..insertion.marker - insertion.at];
            insert(room, at, &insertion.encoded);
            c["source"] = relative(
                room,
                at + prefix.encode_utf16().count() as u32,
                Assoc::After,
            );
            meta[index] = c;
        }
        meta.to_vec()
    })?;
    Ok(())
}
type Loaded = (String, Vec<Thread>, Vec<Value>);

fn load(s: &Store, d: &Document, r: &mut Room) -> Result<Loaded> {
    r.reconcile(s, d)?;
    let mut meta = metadata(s, &d.id)?;
    migrate(s, d, r, &mut meta)?;
    let source = room_text(r);
    let threads = parse(&source);
    let (values, changed) = thread_values(r, &source, &threads, &meta, &d.id);
    if !changed.is_empty() {
        r.edit(s, d, |_| changed)?;
    }
    Ok((source, threads, values))
}
pub(super) async fn list(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        let d = s.doc(&id)?;
        let (owner, editor) = s.access(&h, &d, &a)?;
        let guest = guest_id(&h).ok();
        let room = s.room(&d)?;
        let mut r = room.lock().unwrap();
        list_payload(s, &d, &mut r, owner || editor, guest.as_deref()).map(Json)
    })
    .await
}
pub(super) fn list_payload(
    s: &Store,
    d: &Document,
    room: &mut Room,
    may_edit: bool,
    guest: Option<&str>,
) -> Result<Value> {
    let (_, _, rows) = load(s, d, room)?;
    let rows = rows
        .into_iter()
        .map(|row| browser_auth::comment_value(row, may_edit, guest))
        .collect::<Vec<_>>();
    Ok(json!({"comments": rows}))
}
#[derive(Deserialize)]
pub(super) struct NewComment {
    body: String,
    name: String,
    quote: Option<String>,
    anchor: Option<Value>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
}
pub(super) async fn add(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
    Json(b): Json<NewComment>,
) -> Result<Json<Value>> {
    let (id, a, h, b, guest, room) = doc_job(s.clone(), id.clone(), move |s| {
        let d = s.doc(&id)?;
        s.access(&h, &d, &a)?;
        if !valid(&b.body, &b.name) {
            return Err(bad(
                "Enter a name (1–60 characters) and comment (1–4,000 characters).",
            ));
        }
        if b.request_id
            .as_ref()
            .is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
        {
            return Err(bad("Invalid comment request."));
        }
        let guest = guest_id(&h)?;
        if let Some(anchor) = &b.anchor {
            validate_anchor(anchor)?;
        }
        let room = s.room(&d)?;
        Ok((id, a, h, b, guest, room))
    })
    .await?;
    if let Some(anchor) = &b.anchor {
        await_anchor(s.clone(), &id, &room, anchor).await?;
    }
    doc_job(s, id.clone(), move |s| {
        let d = s.doc(&id)?;
        let (owner, editor) = s.access(&h, &d, &a)?;
        let mut r = room.lock().unwrap();
        Ok(Json(add_command(
            s,
            &d,
            &mut r,
            b,
            guest,
            owner || editor,
            None,
        )?))
    })
    .await
}
pub(super) fn add_from_connector(
    s: &Store,
    d: &Document,
    r: &mut Room,
    actor: String,
    mut b: NewComment,
    expected_revision: &str,
) -> Result<Value> {
    let loaded = load(s, d, r)?;
    let (source, _, rows) = &loaded;
    if let Some(request) = b.request_id.as_deref()
        && let Some(existing) = rows
            .iter()
            .find(|row| row["requestId"] == request && row["guest"] == actor)
    {
        return Ok(browser_auth::comment_value(
            existing.clone(),
            true,
            Some(&actor),
        ));
    }
    if hash(source) != expected_revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Document changed. Read it again before commenting.".into(),
        ));
    }
    if !valid(&b.body, &b.name)
        || b.request_id
            .as_ref()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(bad("Enter a valid name, comment and UUID request_id."));
    }
    b.anchor = if let Some(quote) = b.quote.as_deref() {
        if quote.is_empty() || quote.len() > 8 * 1024 {
            return Err(bad("Choose a nonempty passage up to 8 KB."));
        }
        let at = source
            .find(quote)
            .ok_or_else(|| bad("Passage not found. Read the document again."))?;
        let next = at + quote.chars().next().expect("nonempty passage").len_utf8();
        if source[next..].contains(quote) {
            return Err(bad(
                "Passage occurs more than once. Choose a longer unique passage.",
            ));
        }
        Some(json!({
            "start": relative(r, utf16(source, at), Assoc::After),
            "end": relative(r, utf16(source, at + quote.len()), Assoc::Before)
        }))
    } else {
        None
    };
    add_command(s, d, r, b, actor, true, Some(loaded))
}

// HTTP and MCP comments share validation, idempotency and the engine commit.
fn add_command(
    s: &Store,
    d: &Document,
    r: &mut Room,
    b: NewComment,
    guest: String,
    may_edit: bool,
    loaded: Option<Loaded>,
) -> Result<Value> {
    let (source, threads, rows) = match loaded {
        Some(loaded) => loaded,
        None => load(s, d, r)?,
    };
    if let Some(request) = &b.request_id
        && let Some(c) = rows
            .iter()
            .find(|c| c["requestId"] == *request && c["guest"] == guest)
    {
        return Ok(browser_auth::comment_value(
            c.clone(),
            may_edit,
            Some(&guest),
        ));
    }
    if threads.len() >= 2000 {
        return Err(bad("This document has reached its comment limit."));
    }
    let at = if let Some(anchor) = &b.anchor {
        if anchor.to_string().len() > 2048 || offset(r, &anchor["start"]).is_none() {
            return Err(bad("Invalid comment anchor."));
        }
        offset(r, &anchor["end"])
            .ok_or_else(|| bad("This passage moved. Select it again before commenting."))?
    } else {
        source.encode_utf16().count() as u32
    };
    let at_byte = byte(&source, at).ok_or_else(|| bad("Invalid comment anchor."))?;
    if threads.iter().any(|t| t.from < at_byte && at_byte < t.to) {
        return Err(bad("Reply to this conversation instead."));
    }
    let Insertion {
        at,
        encoded,
        marker,
    } = root_record(
        &source,
        &threads,
        at_byte,
        &[MessageText {
            name: b.name.trim().into(),
            body: b.body.trim().into(),
        }],
    )?;
    let marker = utf16(&source, at) + encoded[..marker - at].encode_utf16().count() as u32;
    let at = utf16(&source, at);
    if source.len() + encoded.len() > 5 * MB {
        return Err(bad("Document exceeds 5 MB."));
    }
    let rows = r.edit(s, d, |room| {
        insert(room, at, &encoded);
        vec![json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "body": b.body.trim(),
            "name": b.name.trim(),
            "guest": guest,
            "quote": b.quote.map(|v| v.chars().take(500).collect::<String>()),
            "anchor": b.anchor,
            "source": relative(room, marker, Assoc::After),
            "created": now(),
            "resolved": false,
            "replies": [],
            "requestId": b.request_id
        })]
    })?;
    let c = rows.into_iter().next().unwrap();
    Ok(browser_auth::comment_value(c, may_edit, Some(&guest)))
}

#[derive(Deserialize)]
pub(super) struct Edit {
    resolved: Option<bool>,
    body: Option<String>,
    name: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
}
pub(super) async fn edit(
    State(s): State<App>,
    AxPath((id, cid)): AxPath<(String, String)>,
    Query(a): Query<Access>,
    h: HeaderMap,
    Json(b): Json<Edit>,
) -> Result<Json<Value>> {
    let actor = guest_id(&h)?;
    edit_as(s, id, cid, a, h, b, actor).await
}

pub(super) async fn edit_as(
    s: App,
    id: String,
    cid: String,
    a: Access,
    h: HeaderMap,
    b: Edit,
    guest: String,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        let d = s.doc(&id)?;
        let (owner, editor) = s.access(&h, &d, &a)?;
        let room = s.room(&d)?;
        let mut r = room.lock().unwrap();
        edit_payload(s, &d, &mut r, cid, b, &guest, (owner, editor)).map(Json)
    })
    .await
}
pub(super) fn edit_payload(
    s: &Store,
    d: &Document,
    r: &mut Room,
    cid: String,
    b: Edit,
    guest: &str,
    (owner, editor): (bool, bool),
) -> Result<Value> {
    let (source, threads, rows) = load(s, d, r)?;
    let index = rows
        .iter()
        .position(|v| v["id"] == cid)
        .ok_or_else(|| bad("Comment not found."))?;
    let mut c = rows[index].clone();
    let mut insertion = None;
    if let Some(resolved) = b.resolved {
        if !owner && !editor && c["guest"] != guest {
            return Err(denied());
        }
        c["resolved"] = json!(resolved);
    }
    if let Some(body) = b.body {
        let name = b.name.unwrap_or_default();
        if !valid(&body, &name) {
            return Err(bad(
                "Enter a name (1–60 characters) and reply (1–4,000 characters).",
            ));
        }
        if b.request_id
            .as_ref()
            .is_some_and(|v| uuid::Uuid::parse_str(v).is_err())
        {
            return Err(bad("Invalid reply request."));
        }
        let mut requests = c["replyRequests"].as_array().cloned().unwrap_or_default();
        if let Some(request) = &b.request_id
            && requests
                .iter()
                .any(|v| v["id"] == *request && v["guest"] == guest)
        {
            return Ok(browser_auth::comment_value(c, owner || editor, Some(guest)));
        }
        if c["replies"].as_array().unwrap().len() >= 200 {
            return Err(bad("This thread has reached its reply limit."));
        }
        let encoded = format!("\n{}", record(&name, &body));
        if source.len() + encoded.len() > 5 * MB {
            return Err(bad("Document exceeds 5 MB."));
        }
        let at = threads[index].to;
        let mut candidate = source.clone();
        candidate.insert_str(at, &encoded);
        let mut messages = threads[index].messages.clone();
        messages.push(MessageText {
            name: name.trim().into(),
            body: body.trim().into(),
        });
        let expected = threads
            .iter()
            .enumerate()
            .map(|(i, thread)| {
                let shifted = thread.from + if thread.from >= at { encoded.len() } else { 0 };
                (
                    shifted,
                    if i == index {
                        messages.as_slice()
                    } else {
                        thread.messages.as_slice()
                    },
                )
            })
            .collect::<Vec<_>>();
        if !valid_candidate(&source, &candidate, &expected) {
            return Err(bad(
                "This conversation moved into a Markdown block. Move it outside that block before replying.",
            ));
        }
        insertion = Some((utf16(&source, threads[index].to), encoded));
        c["replies"]
            .as_array_mut()
            .unwrap()
            .push(json!({"body":body.trim(),"name":name.trim(),"created":now()}));
        if let Some(request) = b.request_id {
            requests.push(json!({"id":request,"guest":guest}));
        }
        c["replyRequests"] = json!(requests);
    }
    let values = r.edit(s, d, |room| {
        if let Some((at, encoded)) = insertion {
            insert(room, at, &encoded);
        }
        vec![c]
    })?;
    let c = values.into_iter().next().unwrap();
    Ok(browser_auth::comment_value(c, owner || editor, Some(guest)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn causal_fixture() -> (
        tempfile::TempDir,
        App,
        Document,
        Arc<Mutex<Room>>,
        Value,
        Vec<u8>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let s = Store::open(
            directory.path().join("docs"),
            directory.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        fs::write(s.root.join("causal.md"), "Original.").unwrap();
        let d = s.index_document("causal.md").unwrap();
        let room = s.room(&d).unwrap();
        s.persist(&d, &mut room.lock().unwrap()).unwrap();
        let client = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        client
            .transact_mut()
            .apply_update(
                Update::decode_v1(
                    &room
                        .lock()
                        .unwrap()
                        .awareness
                        .doc()
                        .transact()
                        .encode_state_as_update_v1(&StateVector::default()),
                )
                .unwrap(),
            )
            .unwrap();
        let before = client.transact().state_vector();
        let text = client.get_or_insert_text("content");
        let from = text.len(&client.transact());
        text.insert(&mut client.transact_mut(), from, " Newly typed passage");
        let to = text.len(&client.transact());
        let anchor = json!({"start":doc_relative(&client,from,Assoc::After),"end":doc_relative(&client,to,Assoc::Before)});
        let frame = Message::Sync(SyncMessage::Update(
            client.transact().encode_state_as_update_v1(&before),
        ))
        .encode_v1();
        (directory, s, d, room, anchor, frame)
    }

    async fn subscribed(room: &Arc<Mutex<Room>>) {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if room.lock().unwrap().tx.receiver_count() != 0 {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("causal waiter must install its atomic subscription");
    }

    #[tokio::test]
    async fn causal_comments_wait_for_the_commit_instead_of_exhausting_lock_samples() {
        let (_directory, s, d, room, anchor, frame) = causal_fixture();
        let target = room.clone();
        let selected = anchor.clone();
        let store = s.clone();
        let target_id = d.id.clone();
        let pending =
            tokio::spawn(async move { await_anchor(store, &target_id, &target, &selected).await });
        subscribed(&room).await;
        let (locked, acquired) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let busy_room = room.clone();
        let coordinator = std::thread::spawn(move || {
            let _guard = busy_room.lock().unwrap();
            locked.send(()).unwrap();
            released
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
        });
        acquired.await.unwrap();
        // Model a background projection holding this room beyond the old
        // polling budget. The HTTP waiter occupies neither lock nor worker.
        tokio::time::sleep(std::time::Duration::from_millis(450)).await;
        assert!(
            !pending.is_finished(),
            "a causally pending passage must not receive a false conflict after 300ms"
        );
        release.send(()).unwrap();
        coordinator.join().unwrap();
        process_frame(&s, &d, &room, &frame, true, true, &mut Peer::default()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let r = room.lock().unwrap();
        assert!(anchor_ready(&r, &anchor));
        assert_eq!(room_text(&r), "Original. Newly typed passage");
    }

    #[tokio::test]
    async fn causal_comment_subscription_cannot_lose_an_immediate_or_lagged_commit() {
        let (_directory, s, d, room, anchor, frame) = causal_fixture();
        let target = room.clone();
        let selected = anchor.clone();
        let store = s.clone();
        let target_id = d.id.clone();
        let pending =
            tokio::spawn(async move { await_anchor(store, &target_id, &target, &selected).await });
        subscribed(&room).await;
        // This current-thread runtime cannot poll the waiter during the burst,
        // so its bounded receiver must report lag before seeing the commit.
        for _ in 0..300 {
            room.lock()
                .unwrap()
                .tx
                .send(Message::Custom(121, b"0".to_vec()).encode_v1())
                .unwrap();
        }
        process_frame(&s, &d, &room, &frame, true, true, &mut Peer::default()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        // A commit preceding registration must succeed from the atomic initial
        // check, even though there will never be another update notification.
        await_anchor(s, &d.id, &room, &anchor).await.unwrap();
    }

    #[tokio::test]
    async fn nonexistent_comment_anchors_expire_without_inventing_a_fallback_passage() {
        let (_directory, s, d, room, anchor, _frame) = causal_fixture();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            await_anchor(s.clone(), &d.id, &room, &anchor),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
        assert_eq!(room_text(&room.lock().unwrap()), "Original.");
        assert_eq!(
            fs::read_to_string(s.root.join(&d.path)).unwrap(),
            "Original."
        );
        assert_eq!(room.lock().unwrap().tx.receiver_count(), 0);
    }

    #[test]
    fn untrusted_anchor_ids_are_bounded_before_yrs_json_deserialization() {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        apply_text(&doc, "", "A safe passage.");
        let valid = doc_relative(&doc, 2, Assoc::After);
        for bad_id in [
            json!({"client":9_007_199_254_740_992u64,"clock":0}),
            json!({"client":u64::MAX,"clock":0}),
            json!({"client":-1,"clock":0}),
            json!({"client":1.5,"clock":0}),
            json!({"client":1,"clock":u64::from(u32::MAX)+1}),
            json!({"client":1,"clock":-1}),
        ] {
            for field in ["item", "type"] {
                let mut index = valid.clone();
                index[field] = bad_id.clone();
                assert!(!index_shape(&index));
                assert_eq!(
                    doc_offset(&doc, &index),
                    None,
                    "malformed persisted metadata is ignored without a panic or ID alias"
                );
                for anchor in [
                    json!({"start":index,"end":valid}),
                    json!({"start":valid,"end":index}),
                ] {
                    assert_eq!(
                        validate_anchor(&anchor).unwrap_err().0,
                        StatusCode::BAD_REQUEST
                    );
                }
            }
        }
        let boundary =
            json!({"item":{"client":9_007_199_254_740_991u64,"clock":u32::MAX},"assoc":0});
        assert!(index_shape(&boundary));
        assert_eq!(
            doc_offset(&doc, &boundary),
            None,
            "an unknown but valid ID is merely unavailable"
        );
        assert!(validate_anchor(&json!({"start":valid,"end":valid})).is_ok());
        assert_eq!(doc_offset(&doc, &valid), Some(2));
    }

    fn remembered_thread(r: &Room, source: &str, id: &str) -> Value {
        let threads = parse(source);
        let thread = &threads[0];
        let mut row = thread_value(r, source, &threads, thread, None, id);
        row["id"] = json!("remembered-thread");
        row["created"] = json!(42);
        row["resolved"] = json!(true);
        row["guest"] = json!("original-author");
        row["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        row["replyRequests"] =
            json!([{"id":uuid::Uuid::new_v4().to_string(),"guest":"original-author"}]);
        for reply in row["replies"].as_array_mut().unwrap() {
            reply["created"] = json!(43);
        }
        row
    }

    fn delete_thread(r: &Room, source: &str, thread: &Thread) {
        r.awareness
            .doc()
            .get_or_insert_text("content")
            .remove_range(
                &mut r.awareness.doc().transact_mut(),
                utf16(source, thread.from),
                utf16(source, thread.to) - utf16(source, thread.from),
            );
    }

    #[test]
    fn raw_cut_paste_preserves_unique_complete_conversation_metadata_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("docs");
        let state = dir.path().join("state");
        fs::create_dir(&docs).unwrap();
        let s = Store::open(docs.clone(), state.clone(), "http://localhost:3477".into()).unwrap();
        let d = s.create_document("cut-paste.md").unwrap();
        let source = "Original passage.\n\n[[comment(Ana): A note]]\n[[comment(Alex): A reply]]\n\nDestination passage.";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        {
            let mut r = room.lock().unwrap();
            let row = remembered_thread(&r, source, &d.id);
            s.commit_room(&d, &mut r, &[row]).unwrap();
            let thread = &parse(source)[0];
            let raw = &source[thread.from..thread.to];
            delete_thread(&r, source, thread);
            let (_, threads, values) = load(&s, &d, &mut r).unwrap();
            assert!(
                threads.is_empty() && values.is_empty(),
                "cut text stays absent"
            );
            let at = room_text(&r).encode_utf16().count() as u32;
            insert(&r, at, &format!("\n\n{raw}"));
            let (_, _, values) = load(&s, &d, &mut r).unwrap();
            assert_eq!(values.len(), 1);
            assert_eq!(values[0]["id"], "remembered-thread");
            assert_eq!(values[0]["created"], 42);
            assert_eq!(values[0]["resolved"], true);
            assert_eq!(values[0]["replies"][0]["created"], 43);
            assert_eq!(values[0]["guest"], "");
            assert!(values[0].get("requestId").is_none());
            assert!(values[0].get("replyRequests").is_none());
            let selected_from = offset(&r, &values[0]["anchor"]["start"]).unwrap();
            let selected_to = offset(&r, &values[0]["anchor"]["end"]).unwrap();
            let current = room_text(&r);
            assert_eq!(
                &current
                    [byte(&current, selected_from).unwrap()..byte(&current, selected_to).unwrap()],
                "Original passage.",
                "moving only records keeps their still-present selected passage"
            );
            let (_, _, repeated) = load(&s, &d, &mut r).unwrap();
            assert_eq!(
                repeated, values,
                "reattachment is stable, not repeated on each read"
            );
        }
        drop(room);
        drop(s);
        let s = Store::open(docs, state, "http://localhost:3477".into()).unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        let (_, _, values) = load(&s, &d, &mut r).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["id"], "remembered-thread");
        assert_eq!(values[0]["created"], 42);
        assert_eq!(values[0]["resolved"], true);
        assert_eq!(values[0]["replies"][0]["created"], 43);
    }

    #[test]
    fn failed_raw_reattachment_is_atomic_and_keeps_original_metadata_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("metadata-retry.md").unwrap();
        let source = "Passage.\n\n[[comment(Ana): A note]]\n[[comment(Alex): A reply]]";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        let original = remembered_thread(&r, source, &d.id);
        s.commit_room(&d, &mut r, std::slice::from_ref(&original))
            .unwrap();
        delete_thread(&r, source, &parse(source)[0]);
        let end = room_text(&r).encode_utf16().count() as u32;
        insert(
            &r,
            end,
            "\n\n[[comment(Ana): A note]]\n[[comment(Alex): A reply]]",
        );
        s.db.lock().unwrap().execute_batch(
            "CREATE TRIGGER fail_comment_reattachment BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT,'test comment metadata failure'); END;"
        ).unwrap();
        assert!(load(&s, &d, &mut r).is_err());
        assert_eq!(metadata(&s, &d.id).unwrap(), vec![original]);
        s.db.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_comment_reattachment;")
            .unwrap();
        let (_, _, values) = load(&s, &d, &mut r).unwrap();
        assert_eq!(values[0]["id"], "remembered-thread");
        assert_eq!(values[0]["created"], 42);
        assert_eq!(values[0]["resolved"], true);
        assert_eq!(values[0]["guest"], "");
        assert_eq!(metadata(&s, &d.id).unwrap(), values);
    }

    #[test]
    fn moving_a_selected_passage_and_records_reanchors_the_original_quote() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("move-passage.md").unwrap();
        let source = "Passage selected.\n\n[[comment(Ana): A note]]\n\nA different paragraph.";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        let mut row = remembered_thread(&r, source, &d.id);
        row["quote"] = json!("selected");
        row["anchor"] =
            json!({"start":relative(&r,8,Assoc::After),"end":relative(&r,16,Assoc::Before)});
        s.commit_room(&d, &mut r, &[row]).unwrap();
        let cut_to = parse(source)[0].to;
        r.awareness
            .doc()
            .get_or_insert_text("content")
            .remove_range(
                &mut r.awareness.doc().transact_mut(),
                0,
                utf16(source, cut_to),
            );
        let end = room_text(&r).encode_utf16().count() as u32;
        insert(&r, end, &format!("\n\n{}", &source[..cut_to]));
        let (current, _, values) = load(&s, &d, &mut r).unwrap();
        assert_eq!(values[0]["id"], "remembered-thread");
        assert_eq!(values[0]["created"], 42);
        assert_eq!(values[0]["resolved"], true);
        assert_eq!(values[0]["quote"], "selected");
        let from = offset(&r, &values[0]["anchor"]["start"]).unwrap();
        let to = offset(&r, &values[0]["anchor"]["end"]).unwrap();
        assert!(from > end, "selection follows the moved passage");
        assert_eq!(
            &current[byte(&current, from).unwrap()..byte(&current, to).unwrap()],
            "selected"
        );
    }

    #[test]
    fn raw_moves_do_not_guess_between_duplicates_changes_or_still_live_records() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let original = "Passage.\n\n[[comment(Ana): A note]]\n[[comment(Alex): A reply]]";
        let raw = "[[comment(Ana): A note]]\n[[comment(Alex): A reply]]";
        for (name, replacement, old_duplicate, keep_original) in [
            (
                "changed-root",
                raw.replace("A note", "Changed note"),
                false,
                false,
            ),
            (
                "changed-reply",
                raw.replace("A reply", "Changed reply"),
                false,
                false,
            ),
            ("new-duplicates", format!("{raw}\n\n{raw}"), false, false),
            ("old-duplicates", raw.into(), true, false),
            ("copy", format!("\n\n{raw}"), false, true),
            (
                "literal-original",
                format!("```\n{original}\n```\n\n{raw}"),
                false,
                true,
            ),
        ] {
            let d = s.create_document(&format!("{name}.md")).unwrap();
            fs::write(s.root.join(&d.path), original).unwrap();
            let room = s.room(&d).unwrap();
            let r = room.lock().unwrap();
            let mut meta = vec![remembered_thread(&r, original, &d.id)];
            if old_duplicate {
                let mut duplicate = meta[0].clone();
                duplicate["id"] = json!("other-remembered-thread");
                duplicate["source"] = json!({"item":{"client":12345,"clock":0},"assoc":0});
                meta.push(duplicate);
            }
            if name == "literal-original" {
                insert(&r, 0, "```\n");
                let end = room_text(&r).encode_utf16().count() as u32;
                insert(&r, end, &format!("\n```\n\n{raw}"));
            } else if keep_original {
                let end = original.encode_utf16().count() as u32;
                insert(&r, end, &replacement);
            } else {
                delete_thread(&r, original, &parse(original)[0]);
                let end = room_text(&r).encode_utf16().count() as u32;
                insert(&r, end, &format!("\n\n{replacement}"));
            }
            let source = room_text(&r);
            let threads = parse(&source);
            let (values, _) = thread_values(&r, &source, &threads, &meta, &d.id);
            let new = values.last().unwrap();
            assert_ne!(
                new["id"], "remembered-thread",
                "{name}: recreated/copy text must stay independent"
            );
            assert_eq!(new["created"], 0, "{name}");
            assert_eq!(new["resolved"], false, "{name}");
            if name == "copy" {
                assert_eq!(values[0]["id"], "remembered-thread");
                assert_eq!(values[0]["created"], 42);
            }
        }
    }

    #[test]
    fn simultaneous_raw_pastes_do_not_share_a_single_threads_metadata() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("parallel-comments.md").unwrap();
        let source = "Passage.\n\n[[comment(Ana): A note]]\n[[comment(Alex): A reply]]";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let r = room.lock().unwrap();
        let row = remembered_thread(&r, source, &d.id);
        let baseline = r
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let vector = r.awareness.doc().transact().state_vector();
        let thread = &parse(source)[0];
        let raw = &source[thread.from..thread.to];
        for _ in 0..2 {
            let peer = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            peer.transact_mut()
                .apply_update(Update::decode_v1(&baseline).unwrap())
                .unwrap();
            let text = peer.get_or_insert_text("content");
            let mut txn = peer.transact_mut();
            text.remove_range(
                &mut txn,
                utf16(source, thread.from),
                utf16(source, thread.to) - utf16(source, thread.from),
            );
            let end = text.len(&txn);
            text.insert(&mut txn, end, &format!("\n\n{raw}\n\n"));
            let update = txn.encode_state_as_update_v1(&vector);
            drop(txn);
            r.awareness
                .doc()
                .transact_mut()
                .apply_update(Update::decode_v1(&update).unwrap())
                .unwrap();
        }
        let source = room_text(&r);
        let threads = parse(&source);
        assert_eq!(threads.len(), 2);
        let (values, _) = thread_values(&r, &source, &threads, &[row], &d.id);
        assert!(values.iter().all(|value| value["created"] == 0
            && value["resolved"] == false
            && value["id"] != "remembered-thread"));
        assert_ne!(values[0]["id"], values[1]["id"]);
    }

    fn planned(source: &str, at: usize) -> String {
        let plan = root_record(
            source,
            &parse(source),
            at,
            &[MessageText {
                name: "Ana".into(),
                body: "A note".into(),
            }],
        )
        .expect("complete Markdown supports a safe comment insertion");
        let mut result = source.to_string();
        result.insert_str(plan.at, &plan.encoded);
        result
    }

    #[test]
    fn comments_preserve_complete_markdown_blocks_at_selection_boundaries() {
        for (source, at) in [
            ("- one\n- two\n", 6),
            ("one\n\ntwo", 5),
            ("| A | B |\n| - | - |\n| x | y |\n\nAfter the table.", 3),
            ("Before <span title=\"hello\">text</span> after.", 20),
            ("# A heading #\n\nAfter.", 5),
            ("Heading\n=======\n\nAfter.", 5),
            ("> quote\n> second line\n\nAfter.", 6),
            ("- one\n  - nested\n- two\n\nAfter.", 12),
            ("    code\n    second\n\nAfter.", 8),
            ("```md\ncode\n```\n\nAfter.", 8),
            ("Before [a link](https://example.test) after.", 14),
            ("Before `code` after.", 10),
        ] {
            let result = planned(source, at);
            assert_eq!(parse(&result).len(), 1, "{source}");
            assert!(same_visible_structure(&result, source), "{source}");
        }
    }

    #[test]
    fn another_conversation_never_splits_the_commented_paragraph_or_adopts_a_thread() {
        let source = "A long paragraph that continues beyond the selected word.";
        let first = planned(source, 6);
        let second = planned(&first, 6);
        let threads = parse(&second);
        assert_eq!(threads.len(), 2);
        assert!(threads.iter().all(|thread| thread.messages.len() == 1));
        assert!(second.starts_with(source));
        assert!(same_visible_structure(&second, source));
    }

    #[test]
    fn unsafe_records_are_rejected_before_changing_any_migrated_thread() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("migration.md").unwrap();
        let source = "A paragraph.\n\n```md\nAn unfinished fence";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        let mut meta = vec![
            json!({"id":"one", "name":"Ana", "body":"Safe first", "anchor":{"start":relative(&r,0,Assoc::After), "end":relative(&r,1,Assoc::Before)},"replies":[]}),
            json!({"id":"two", "name":"Ana", "body":"Unsafe later", "anchor":{"start":relative(&r,20,Assoc::After), "end":relative(&r,source.len() as u32,Assoc::Before)},"replies":[]}),
        ];
        assert!(migrate(&s, &d, &mut r, &mut meta).is_err());
        assert_eq!(room_text(&r), source);
        assert!(meta.iter().all(|value| value.get("source").is_none()));
        assert!(metadata(&s, &d.id).unwrap().is_empty());
    }

    #[test]
    fn migration_uses_safe_blocks_and_keeps_replies_metadata_and_selected_anchor() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("migration.md").unwrap();
        let source = "| Name | Value |\n| - | - |\n| one | two |\n\nAfter the table.";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        let anchor =
            json!({"start":relative(&r,2,Assoc::After), "end":relative(&r,6,Assoc::Before)});
        let mut meta = vec![
            json!({"id":"legacy", "name":"You", "body":"First", "anchor":anchor,"quote":"Name","created":42,"resolved":true,"replies":[{"name":"Ana","body":"Reply","created":43}]}),
        ];
        migrate(&s, &d, &mut r, &mut meta).unwrap();
        let current = room_text(&r);
        assert!(same_visible_structure(&current, source));
        let threads = parse(&current);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 2);
        assert_eq!(threads[0].messages[0].name, s.owner_name);
        assert_eq!(meta[0]["created"], 42);
        assert_eq!(meta[0]["resolved"], true);
        assert_eq!(meta[0]["replies"][0]["created"], 43);
        assert_eq!(offset(&r, &meta[0]["anchor"]["start"]), Some(2));
        assert_eq!(offset(&r, &meta[0]["anchor"]["end"]), Some(6));
        assert_eq!(metadata(&s, &d.id).unwrap().len(), 1);
        let before = r.awareness.doc().transact().state_vector();
        migrate(&s, &d, &mut r, &mut meta).unwrap();
        assert_eq!(
            before,
            r.awareness.doc().transact().state_vector(),
            "migration is idempotent"
        );
    }

    #[test]
    fn accepted_comment_source_gets_a_protected_recovery_before_desktop_replacement() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("recovery.md").unwrap();
        let source = "A passage.";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let mut r = room.lock().unwrap();
        s.persist(&d, &mut r).unwrap();
        insert(
            &r,
            source.len() as u32,
            "\n\n[[comment(Ana): Keep this note]]",
        );
        commit(&s, &d, &mut r, &[]).unwrap();
        s.persist(&d, &mut r).unwrap();
        assert!(r.engine.unprotected());
        let accepted = room_text(&r);
        fs::write(s.root.join(&d.path), source).unwrap();
        s.persist(&d, &mut r).unwrap();
        let recovered: i64 =
            s.db.lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM revisions WHERE doc=? AND kind='recovery' AND content=?",
                    params![d.id, accepted],
                    |row| row.get(0),
                )
                .unwrap();
        assert_eq!(
            recovered, 1,
            "accepted HTTP comment text must have its own protected pre-import copy"
        );
    }

    #[test]
    fn owner_rebuild_preserves_exact_thread_identity_and_reanchors_unique_passages() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        let s = Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap();
        let d = s.create_document("rebuild.md").unwrap();
        let source =
            "Selected passage continues.\n\n[[comment(Ana): note]]\n[[comment(Alex): reply]]";
        fs::write(s.root.join(&d.path), source).unwrap();
        let room = s.room(&d).unwrap();
        let old = room.lock().unwrap();
        let thread = &parse(source)[0];
        let row = json!({"id":"stable-thread", "source":relative(&old,utf16(source,thread.from),Assoc::After),
            "name":"Ana","body":"note", "quote":"Selected", "anchor":{"start":relative(&old,0,Assoc::After),"end":relative(&old,8,Assoc::Before)},
            "created":42,"resolved":true,"replies":[{"name":"Alex","body":"reply","created":43}]});
        for (chosen, expected) in [
            (source.to_string(), 0),
            (format!("A new lead.\n\n{source}"), 13),
        ] {
            let fresh = Doc::with_options(Options {
                offset_kind: OffsetKind::Utf16,
                ..Options::default()
            });
            apply_text(&fresh, "", &chosen);
            let rows = rebuild_metadata(&old, &fresh, &chosen, std::slice::from_ref(&row));
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["id"], "stable-thread");
            assert_eq!(rows[0]["created"], 42);
            assert_eq!(rows[0]["resolved"], true);
            assert_eq!(rows[0]["replies"][0]["created"], 43);
            assert_eq!(
                doc_offset(&fresh, &rows[0]["anchor"]["start"]),
                Some(expected)
            );
            assert_eq!(
                doc_offset(&fresh, &rows[0]["anchor"]["end"]),
                Some(expected + 8)
            );
            assert_eq!(
                doc_offset(&fresh, &rows[0]["source"]),
                Some(utf16(&chosen, parse(&chosen)[0].from))
            );
        }
        let chosen = format!("{source}\n\n{source}");
        let fresh = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        apply_text(&fresh, "", &chosen);
        assert!(
            rebuild_metadata(&old, &fresh, &chosen, std::slice::from_ref(&row)).is_empty(),
            "ambiguous identities stay only in the maintenance archive"
        );
        assert!(
            rebuild_metadata(
                &old,
                &fresh,
                "Selected passage continues.",
                std::slice::from_ref(&row)
            )
            .is_empty(),
            "deleted threads must not reappear through legacy migration"
        );
    }

    #[test]
    fn file_comment_grammar_matches_the_editor_fixtures() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../test/fixtures/file-comments.json")).unwrap();
        for case in cases {
            let threads = parse(case["source"].as_str().unwrap());
            let actual = json!(
                threads
                    .iter()
                    .map(|t| t
                        .messages
                        .iter()
                        .map(|m| json!({"name":m.name,"body":m.body}))
                        .collect::<Vec<_>>())
                    .collect::<Vec<_>>()
            );
            assert_eq!(actual, case["threads"], "{}", case["name"]);
        }
    }
    #[test]
    fn comment_serialization_cannot_escape_its_record_or_grant_media_access() {
        let name = "Ana) ] \\";
        let body = "Line one\n]] [[comment(forged): injected]]\n![private](../private.png)\n<script>bad()</script>";
        let encoded = record(name, body);
        let threads = parse(&encoded);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].messages.len(), 1);
        assert_eq!(threads[0].messages[0].name, name);
        assert_eq!(threads[0].messages[0].body, body);
        assert!(Store::references(&encoded).is_empty());
        assert_eq!(
            reading_source(&format!("Before {encoded} after")),
            "Before  after"
        );
        assert_eq!(
            reading_source("wor[[comment(alex): note]]\n[[comment(ana): reply]]d"),
            "word"
        );
    }

    #[test]
    fn a_copy_without_records_leaves_no_gap_where_each_conversation_was() {
        for (source, expected) in [
            // Records the editor inserts as their own block, with replies.
            (
                "Para one.\n\n[[comment(alex): note]]\n[[comment(ana): reply]]\n\nPara two.\n",
                "Para one.\n\nPara two.\n",
            ),
            ("Para one.\n\n[[comment(alex): note]]", "Para one.\n"),
            ("Para one.\n\n[[comment(alex): note]]\n", "Para one.\n"),
            ("[[comment(alex): note]]\n\nPara two.", "Para two."),
            (
                "Para one.\n\n[[comment(a): one]]\n\n[[comment(b): two]]\n\nPara two.",
                "Para one.\n\nPara two.",
            ),
            (
                "Line one\n  [[comment(alex): note]]\nLine two",
                "Line one\nLine two",
            ),
            // Records written inside a line by a desktop editor.
            (
                "The passage[[comment(alex): note]]\nNext",
                "The passage\nNext",
            ),
            (
                "The passage [[comment(alex): note]]\r\nNext",
                "The passage\r\nNext",
            ),
            ("Some [[comment(alex): note]] words", "Some words"),
            ("Café[[comment(alex): note]] après", "Café après"),
            ("wor[[comment(alex): note]]d", "word"),
            (
                "The passage[[comment(alex): note]]   \nNext",
                "The passage\nNext",
            ),
            // Literal text stays.
            (
                "`[[comment(alex): code]]` and \\[[comment(alex): escaped]]",
                "`[[comment(alex): code]]` and \\[[comment(alex): escaped]]",
            ),
            ("No comments here.\n", "No comments here.\n"),
        ] {
            assert_eq!(without_records(source), expected, "{source:?}");
        }
        // The editor's grammar cases: a copy renders as the source reads
        // without its records, up to the spaces a removal leaves.
        let rendered = |source: &str| {
            let mut html = String::new();
            pulldown_cmark::html::push_html(&mut html, parser(source));
            html.split_whitespace().collect::<Vec<_>>().join(" ")
        };
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../test/fixtures/file-comments.json")).unwrap();
        for case in cases {
            let source = case["source"].as_str().unwrap();
            let copy = without_records(source);
            assert!(parse(&copy).is_empty(), "{}", case["name"]);
            assert_eq!(
                rendered(&copy),
                rendered(&reading_source(source)),
                "{}",
                case["name"]
            );
        }
    }
}
