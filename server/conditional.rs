//! Listings polled every few seconds usually have not changed. A caller that
//! names the copy it holds, by its ETag, is answered 304 with no body.
use super::*;
use axum::http::HeaderValue;

/// `value` as JSON, or 304 Not Modified when the request's If-None-Match
/// names it. The tag is made from the caller's view, `scope`, and the exact
/// body, so it never validates another caller's view; it is compared only
/// once the handler has authorized the caller for this one.
pub(super) fn json(h: &HeaderMap, scope: &str, value: &Value) -> Result<Response> {
    let body = serde_json::to_vec(value).map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The listing could not be prepared.".into(),
        )
    })?;
    let digest = Sha256::new()
        .chain_update(scope.as_bytes())
        .chain_update([0u8])
        .chain_update(&body)
        .finalize();
    // Weak: the same JSON is one representation, compressed or not.
    let tag = format!("W/\"{}\"", hex::encode(&digest[..16]));
    let etag = HeaderValue::from_str(&tag).expect("a hex tag is a header value");
    if names(h, &tag) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (header::ETAG, etag),
        ],
        body,
    )
        .into_response())
}

/// Whether If-None-Match names `tag`, compared weakly as RFC 9110 requires.
fn names(h: &HeaderMap, tag: &str) -> bool {
    let opaque = |value: &str| value.trim().trim_start_matches("W/").to_owned();
    let wanted = opaque(tag);
    h.get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|candidate| candidate.trim() == "*" || opaque(candidate) == wanted)
}
