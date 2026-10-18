//! Markdown is the canonical comment body/thread store. SQLite retains only
//! stable identity, selected-passage anchors, timestamps and resolution state.
//! Every source edit uses the same CRDT + durable projection as normal writing.
use super::*;
use std::{ops::Range, sync::LazyLock};
use yrs::{Assoc, IndexedSequence, StickyIndex};

#[derive(Debug, Clone, PartialEq, Eq)]
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
fn doc_offset(doc: &Doc, value: &Value) -> Option<u32> {
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
    if anchor.to_string().len() > 2048
        || serde_json::from_value::<StickyIndex>(anchor["start"].clone()).is_err()
        || serde_json::from_value::<StickyIndex>(anchor["end"].clone()).is_err()
    {
        return Err(bad("Invalid comment anchor."));
    }
    Ok(())
}
async fn await_anchor(room: &Arc<Mutex<Room>>, anchor: &Value) -> Result<()> {
    // An HTTP comment can overtake its selected characters on the WebSocket.
    // Wait briefly for that causal update without holding the room lock or
    // waiting for a desktop file to become writable.
    for _ in 0..12 {
        {
            if let Ok(r) = room.try_lock()
                && offset(&r, &anchor["start"]).is_some()
                && offset(&r, &anchor["end"]).is_some()
            {
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Err(ApiError(
        StatusCode::CONFLICT,
        "This passage has not synced yet. Wait a moment and post again.".into(),
    ))
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
    meta: &[Value],
    doc_id: &str,
) -> Value {
    let start = utf16(source, t.from);
    let marker = relative(r, start, Assoc::After);
    let stored = meta.iter().find(|c| c["source"]["item"] == marker["item"]);
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

// Explicit owner maintenance may replace CRDT identities while keeping the
// source. Normal editing never guesses identity from equal comment bodies.
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

// Commit source state and its metadata together before attempting Markdown I/O.
fn commit(s: &Store, d: &Document, r: &mut Room, rows: &[Value]) -> Result<()> {
    if !r.pending_updates.lock().unwrap().is_empty() {
        r.browser_generation += 1;
    }
    let intent = r.recovering;
    s.commit_room(d, r, intent, rows)?;
    r.disk_dirty = true;
    Ok(())
}
fn project(s: &Store, d: &Document, r: &mut Room) {
    if let Err(error) = s.persist(d, r) {
        r.waiting(true);
        tracing::warn!("comment projection pending: {error}");
    }
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
    for (index, insertion, mut c) in planned {
        let source = room_text(r);
        let at = utf16(&source, insertion.at);
        let prefix = &insertion.encoded[..insertion.marker - insertion.at];
        insert(r, at, &insertion.encoded);
        c["source"] = relative(r, at + prefix.encode_utf16().count() as u32, Assoc::After);
        meta[index] = c;
    }
    if let Err(error) = commit(s, d, r, meta) {
        apply_text(r.awareness.doc(), &room_text(r), &original);
        return Err(error);
    }
    project(s, d, r);
    Ok(())
}
fn load(s: &Store, d: &Document, r: &mut Room) -> Result<(String, Vec<Thread>, Vec<Value>)> {
    s.persist(d, r)?;
    let mut meta = metadata(s, &d.id)?;
    migrate(s, d, r, &mut meta)?;
    let source = room_text(r);
    let threads = parse(&source);
    let values = threads
        .iter()
        .map(|t| thread_value(r, &source, &threads, t, &meta, &d.id))
        .collect();
    Ok((source, threads, values))
}
pub(super) async fn list(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    Query(a): Query<Access>,
    h: HeaderMap,
) -> Result<Json<Value>> {
    job(s, move |s| {
        let d = s.doc(&id)?;
        s.access(&h, &d, &a)?;
        let room = s.room(&d)?;
        let mut r = room.lock().unwrap();
        let (_, _, rows) = load(s, &d, &mut r)?;
        Ok(Json(json!({"comments":rows})))
    })
    .await
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
    let (id, a, h, b, guest, room) = job(s.clone(), move |s| {
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
        await_anchor(&room, anchor).await?;
    }
    job(s, move |s| {
        let d = s.doc(&id)?;
        s.access(&h, &d, &a)?;
        let mut r = room.lock().unwrap();
        let (source, threads, rows) = load(s, &d, &mut r)?;
        if let Some(request) = &b.request_id
            && let Some(c) = rows
                .iter()
                .find(|c| c["requestId"] == *request && c["guest"] == guest)
        {
            return Ok(Json(c.clone()));
        }
        if threads.len() >= 2000 {
            return Err(bad("This document has reached its comment limit."));
        }
        let at = if let Some(anchor) = &b.anchor {
            if anchor.to_string().len() > 2048 || offset(&r, &anchor["start"]).is_none() {
                return Err(bad("Invalid comment anchor."));
            }
            offset(&r, &anchor["end"])
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
        insert(&r, at, &encoded);
        let c = json!({"id":uuid::Uuid::new_v4().to_string(),"body":b.body.trim(),"name":b.name.trim(),"guest":guest,"quote":b.quote.map(|v|v.chars().take(500).collect::<String>()),"anchor":b.anchor,"source":relative(&r,marker,Assoc::After),"created":now(),"resolved":false,"replies":[],"requestId":b.request_id});
        if let Err(error) = commit(s, &d, &mut r, std::slice::from_ref(&c)) {
            apply_text(r.awareness.doc(), &room_text(&r), &source);
            return Err(error);
        }
        project(s, &d, &mut r);
        Ok(Json(c))
    }).await
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
    job(s, move |s| {
        let d = s.doc(&id)?;
        let (owner, editor) = s.access(&h, &d, &a)?;
        let guest = guest_id(&h)?;
        let room = s.room(&d)?;
        let mut r = room.lock().unwrap();
        let (source, threads, rows) = load(s, &d, &mut r)?;
        let index = rows
            .iter()
            .position(|v| v["id"] == cid)
            .ok_or_else(|| bad("Comment not found."))?;
        let mut c = rows[index].clone();
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
                return Ok(Json(c));
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
            insert(&r, utf16(&source, threads[index].to), &encoded);
            c["replies"]
                .as_array_mut()
                .unwrap()
                .push(json!({"body":body.trim(),"name":name.trim(),"created":now()}));
            if let Some(request) = b.request_id {
                requests.push(json!({"id":request,"guest":guest}));
            }
            c["replyRequests"] = json!(requests);
        }
        if let Err(error) = commit(s, &d, &mut r, std::slice::from_ref(&c)) {
            apply_text(r.awareness.doc(), &room_text(&r), &source);
            return Err(error);
        }
        project(s, &d, &mut r);
        Ok(Json(c))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(r.browser_generation > r.protected_generation);
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
}
