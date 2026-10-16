//! Markdown is the canonical comment body/thread store. SQLite retains only
//! stable identity, selected-passage anchors, timestamps and resolution state.
//! Every source edit uses the same CRDT + durable projection as normal writing.
use super::*;
use std::{ops::Range, sync::LazyLock};
use yrs::{Assoc, IndexedSequence, StickyIndex};

#[derive(Debug)]
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
fn parse(source: &str) -> Vec<Thread> {
    if !source.contains("[[comment(") {
        return Vec::new();
    }
    let code: Vec<Range<usize>> = pulldown_cmark::Parser::new_ext(
        source,
        pulldown_cmark::Options::all().difference(pulldown_cmark::Options::ENABLE_WIKILINKS),
    )
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
            if gap.chars().all(|c| matches!(c, ' ' | '\t' | '\r' | '\n'))
                && gap.chars().filter(|&c| c == '\n').count() <= 1
            {
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
fn relative(r: &Room, index: u32, assoc: Assoc) -> Value {
    let text = r.awareness.doc().get_or_insert_text("content");
    let txn = r.awareness.doc().transact();
    json!(text.sticky_index(&txn, index, assoc).unwrap())
}
fn offset(r: &Room, value: &Value) -> Option<u32> {
    let sticky: StickyIndex = serde_json::from_value(value.clone()).ok()?;
    let text = r.awareness.doc().get_or_insert_text("content");
    let txn = r.awareness.doc().transact();
    let position = sticky.get_offset(&txn)?;
    // Never accept an anchor into another shared type.
    let branch: &yrs::branch::Branch = text.as_ref();
    std::ptr::eq(position.branch.as_ref(), branch).then_some(position.index)
}
async fn await_anchor(room: &Arc<Mutex<Room>>, anchor: &Value) -> Result<()> {
    if anchor.to_string().len() > 2048
        || serde_json::from_value::<StickyIndex>(anchor["start"].clone()).is_err()
        || serde_json::from_value::<StickyIndex>(anchor["end"].clone()).is_err()
    {
        return Err(bad("Invalid comment anchor."));
    }
    // An HTTP comment can overtake its selected characters on the WebSocket.
    // Wait briefly for that causal update without holding the room lock or
    // waiting for a desktop file to become writable.
    for _ in 0..12 {
        {
            let r = room.lock().unwrap();
            if offset(&r, &anchor["start"]).is_some() && offset(&r, &anchor["end"]).is_some() {
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
fn insertion_point(source: &str, at: usize) -> (usize, &'static str) {
    let protected = pulldown_cmark::Parser::new_ext(
        source,
        pulldown_cmark::Options::all().difference(pulldown_cmark::Options::ENABLE_WIKILINKS),
    )
    .into_offset_iter()
    .filter_map(|(event, range)| {
        if !(range.start <= at && at <= range.end) {
            return None;
        }
        match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::Heading { .. }) => {
                let mut end = source[at..].find('\n').map_or(source.len(), |n| at + n);
                let start = source[..at].rfind('\n').map_or(0, |n| n + 1);
                let line = source[start..end].trim();
                if !line.is_empty() && line.chars().all(|c| c == '-' || c == '=') && start > 0 {
                    end = start - 1;
                } else if line.starts_with('#') {
                    let trimmed = source[..end].trim_end_matches([' ', '\t']);
                    let body = trimmed.trim_end_matches('#');
                    if body.len() != trimmed.len() && body.ends_with([' ', '\t']) {
                        end = body.trim_end_matches([' ', '\t']).len();
                    }
                }
                Some((end, false))
            }
            pulldown_cmark::Event::Start(
                pulldown_cmark::Tag::CodeBlock(_)
                | pulldown_cmark::Tag::Table(_)
                | pulldown_cmark::Tag::HtmlBlock,
            ) => Some((range.end, true)),
            pulldown_cmark::Event::Code(_)
            | pulldown_cmark::Event::Start(
                pulldown_cmark::Tag::Link { .. } | pulldown_cmark::Tag::Image { .. },
            ) => Some((range.end, false)),
            _ => None,
        }
    })
    .max_by_key(|&(end, _)| end);
    match protected {
        Some((end, true)) if !source[..end].ends_with('\n') => {
            if let Some(newline) = source[end..].find('\n') {
                (end + newline + 1, "")
            } else {
                (source.len(), "\n")
            }
        }
        Some((end, _)) => (end, ""),
        None => (at, ""),
    }
}
fn root_record(
    source: &str,
    threads: &[Thread],
    at: usize,
    line_prefix: &str,
    name: &str,
    body: &str,
) -> Result<(String, usize)> {
    let adjacent_before = threads
        .iter()
        .any(|t| t.to <= at && source[t.to..at].trim().is_empty());
    let adjacent_after = threads
        .iter()
        .any(|t| t.from >= at && source[at..t.from].trim().is_empty());
    let suffix = if adjacent_after { "\n\n" } else { "" };
    let message = record(name, body);
    for prefix in [if adjacent_before { "\n\n" } else { line_prefix }, "\n\n"] {
        let encoded = format!("{prefix}{message}{suffix}");
        let candidate = format!("{}{}{}", &source[..at], encoded, &source[at..]);
        let parsed = parse(&candidate);
        if parsed.len() == threads.len() + 1
            && parsed
                .iter()
                .any(|t| t.from == at + prefix.len() && t.messages.len() == 1)
        {
            return Ok((encoded, prefix.len()));
        }
    }
    // Validate the complete candidate before changing CRDT state. A comment
    // inside an unfinished fence/HTML block would otherwise be acknowledged but
    // disappear on the next read. Never invent closing syntax for user content.
    Err(bad("Close this Markdown block before adding a comment."))
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

// Commit source state and its metadata together before attempting Markdown I/O.
fn commit(s: &Store, d: &Document, r: &mut Room, rows: &[Value]) -> Result<()> {
    let state = r
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let mut db = s.db.lock().unwrap();
    let tx = db.transaction()?;
    tx.execute(
        "UPDATE docs SET state=?,disk_state=?,write_intent=? WHERE id=?",
        params![&state, r.disk_state.as_ref(), r.recovering, d.id],
    )?;
    for c in rows {
        tx.execute("INSERT INTO comments(id,doc,guest,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![c["id"].as_str(),d.id,c["guest"].as_str().unwrap_or(""),c.to_string()])?;
    }
    tx.commit()?;
    r.persisted = state.into();
    r.persisted_disk = r.disk_state.clone();
    r.persisted_intent = r.recovering;
    r.disk_dirty = true;
    Ok(())
}
fn publish(s: &Store, d: &Document, r: &mut Room, before: &StateVector) {
    if let Err(error) = s.persist(d, r) {
        r.waiting(true);
        tracing::warn!("comment projection pending: {error}");
    }
    let update = r
        .awareness
        .doc()
        .transact()
        .encode_state_as_update_v1(before);
    let _ =
        r.tx.send(Message::Sync(SyncMessage::Update(update)).encode_v1());
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
    let before = r.awareness.doc().transact().state_vector();
    for c in meta.iter_mut().filter(|c| c.get("source").is_none()) {
        let source = room_text(r);
        let at = offset(r, &c["anchor"]["end"]).unwrap_or(source.encode_utf16().count() as u32);
        let (at_byte, line_prefix) =
            insertion_point(&source, byte(&source, at).unwrap_or(source.len()));
        let at = utf16(&source, at_byte);
        let threads = parse(&source);
        let prefix = if threads.iter().any(|t| t.to == at_byte) {
            "\n\n"
        } else {
            line_prefix
        };
        let suffix = if threads.iter().any(|t| t.from == at_byte) {
            "\n\n"
        } else {
            ""
        };
        let name = if c["name"] == "You" {
            s.owner_name.as_str()
        } else {
            c["name"].as_str().unwrap_or("Guest")
        }
        .to_string();
        let mut encoded = format!(
            "{prefix}{}",
            record(&name, c["body"].as_str().unwrap_or("Comment"))
        );
        c["name"] = json!(name);
        if let Some(replies) = c["replies"].as_array_mut() {
            for reply in replies {
                let name = if reply["name"] == "You" {
                    s.owner_name.as_str()
                } else {
                    reply["name"].as_str().unwrap_or("Guest")
                }
                .to_string();
                encoded.push('\n');
                encoded.push_str(&record(&name, reply["body"].as_str().unwrap_or("Reply")));
                reply["name"] = json!(name);
            }
        }
        encoded.push_str(suffix);
        insert(r, at, &encoded);
        c["source"] = relative(r, at + prefix.encode_utf16().count() as u32, Assoc::After);
    }
    if let Err(error) = commit(s, d, r, meta) {
        apply_text(r.awareness.doc(), &room_text(r), &original);
        return Err(error);
    }
    publish(s, d, r, &before);
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
    let d = s.doc(&id)?;
    s.access(&h, &d, &a)?;
    let room = s.room(&d)?;
    let mut r = room.lock().unwrap();
    let (_, _, rows) = load(&s, &d, &mut r)?;
    Ok(Json(json!({"comments":rows})))
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
    origin_check(&s, &h)?;
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
    let room = s.room(&d)?;
    if let Some(anchor) = &b.anchor {
        await_anchor(&room, anchor).await?;
    }
    let d = s.doc(&id)?;
    s.access(&h, &d, &a)?;
    let mut r = room.lock().unwrap();
    let (source, threads, rows) = load(&s, &d, &mut r)?;
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
    let (at_byte, line_prefix) = insertion_point(
        &source,
        byte(&source, at).ok_or_else(|| bad("Invalid comment anchor."))?,
    );
    let at = utf16(&source, at_byte);
    if threads.iter().any(|t| t.from < at_byte && at_byte < t.to) {
        return Err(bad("Reply to this conversation instead."));
    }
    let (encoded, prefix_len) =
        root_record(&source, &threads, at_byte, line_prefix, &b.name, &b.body)?;
    if source.len() + encoded.len() > 5 * MB {
        return Err(bad("Document exceeds 5 MB."));
    }
    let before = r.awareness.doc().transact().state_vector();
    insert(&r, at, &encoded);
    let c = json!({"id":uuid::Uuid::new_v4().to_string(),"body":b.body.trim(),"name":b.name.trim(),"guest":guest,"quote":b.quote.map(|v|v.chars().take(500).collect::<String>()),"anchor":b.anchor,"source":relative(&r,at+prefix_len as u32,Assoc::After),"created":now(),"resolved":false,"replies":[],"requestId":b.request_id});
    if let Err(error) = commit(&s, &d, &mut r, std::slice::from_ref(&c)) {
        apply_text(r.awareness.doc(), &room_text(&r), &source);
        return Err(error);
    }
    publish(&s, &d, &mut r, &before);
    Ok(Json(c))
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
    origin_check(&s, &h)?;
    let d = s.doc(&id)?;
    let (owner, editor) = s.access(&h, &d, &a)?;
    let guest = guest_id(&h)?;
    let room = s.room(&d)?;
    let mut r = room.lock().unwrap();
    let (source, threads, rows) = load(&s, &d, &mut r)?;
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
    let before = r.awareness.doc().transact().state_vector();
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
    if let Err(error) = commit(&s, &d, &mut r, std::slice::from_ref(&c)) {
        apply_text(r.awareness.doc(), &room_text(&r), &source);
        return Err(error);
    }
    publish(&s, &d, &mut r, &before);
    Ok(Json(c))
}

#[cfg(test)]
mod tests {
    use super::*;
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
