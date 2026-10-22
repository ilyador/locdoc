//! The router and the middleware every request passes through.
use super::media::{font_css, font_list, install_font, upload};
use super::sharing::{open_shared, share, shared};
use super::sockets::websocket;
use super::*;

async fn guard(
    State(s): State<App>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let parsed = url::Url::parse(&format!("http://{host}"));
    let hostname = parsed
        .as_ref()
        .ok()
        .and_then(|u| u.host_str())
        .unwrap_or("");
    let public = url::Url::parse(&s.public_url).ok();
    if !["localhost", "127.0.0.1", "[::1]"].contains(&hostname)
        && public.as_ref().and_then(|u| u.host_str()) != Some(hostname)
    {
        return denied().into_response();
    }
    let path = req.uri().path();
    let oauth_exchange = matches!(path, "/oauth/register" | "/oauth/token" | "/oauth/revoke");
    let mcp = path == "/mcp";
    if mcp
        && req.headers().contains_key(header::ORIGIN)
        && !security::origin_allowed(&s.public_url, &s.bind, req.headers())
        && !req.headers().get(header::ORIGIN).is_some_and(|origin| {
            matches!(
                origin.as_bytes(),
                b"https://chatgpt.com" | b"https://platform.openai.com"
            )
        })
    {
        return denied().into_response();
    }
    if (path.starts_with("/ws/")
        || !matches!(
            *req.method(),
            axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
        ))
        && !oauth_exchange
        && !mcp
        && let Err(error) = origin_check(&s, req.headers())
    {
        return error.into_response();
    }
    if path.starts_with("/api/")
        || path.starts_with("/ws/")
        || path.starts_with("/s/")
        || path.starts_with("/oauth/")
        || path.starts_with("/.well-known/")
        || mcp
    {
        let peer = req
            .extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|p| p.0.ip());
        let ip = peer
            .map(|peer| peers::address(req.headers(), peer).to_string())
            .unwrap_or_else(|| "local".into());
        let (method, limit) = if path == "/api/login"
            || path == "/api/redeem"
            || path == "/oauth/register"
            || path == "/oauth/authorize"
        {
            ("login", 15)
        } else if path == "/api/fonts" && req.method() == axum::http::Method::POST {
            ("fonts", 6)
        } else if path.ends_with("/link-preview") || path.starts_with("/s/") {
            ("previews", 30)
        } else if path.ends_with("/upload") {
            ("uploads", 40)
        } else if path.starts_with("/ws/") {
            ("socket", 80)
        } else {
            ("api", 600)
        };
        let owner = s.owner(req.headers());
        let mut rates = s.rates.lock().unwrap();
        let time = now();
        if rates.len() > 10_000 {
            rates.retain(|_, v| time - v.0 < 60);
        }
        let bucket = if owner {
            format!("owner:{method}")
        } else {
            format!("{ip}:{method}")
        };
        if rates.len() >= 20_000 && !owner && !rates.contains_key(&bucket) {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Server is busy. Try again shortly.".into(),
            )
            .into_response();
        }
        let entry = rates.entry(bucket).or_insert((time, 0));
        if time - entry.0 >= 60 {
            *entry = (time, 0)
        }
        entry.1 += 1;
        if entry.1 > limit {
            return ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests. Try again in a minute.".into(),
            )
            .into_response();
        }
    }
    if mcp
        && *req.method() != axum::http::Method::OPTIONS
        && let Err(error) = mcp_auth::authorize(&s, req.headers())
    {
        let mut response = error.into_response();
        if let Ok(challenge) = axum::http::HeaderValue::from_str(&format!(
            "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
            s.public_url
        )) {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, challenge);
        }
        mcp_cors(req.headers(), response.headers_mut());
        return response;
    }
    if *req.method() == axum::http::Method::OPTIONS
        && (mcp || oauth_exchange || path.starts_with("/.well-known/"))
    {
        let mut response = StatusCode::NO_CONTENT.into_response();
        mcp_cors(req.headers(), response.headers_mut());
        return response;
    }
    next.run(req).await
}
fn mcp_cors(request: &HeaderMap, response: &mut HeaderMap) {
    if let Some(origin) = request.get(header::ORIGIN) {
        response.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        response.insert(header::VARY, axum::http::HeaderValue::from_static("Origin"));
    }
    response.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    response.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static(
            "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
        ),
    );
    response.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        axum::http::HeaderValue::from_static(
            "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
        ),
    );
}
const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ",
    "font-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; ",
    "connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
);
async fn response_headers(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let cacheable = req.uri().path().starts_with("/assets/");
    let connector = req.uri().path() == "/mcp"
        || req.uri().path().starts_with("/oauth/")
        || req.uri().path().starts_with("/.well-known/");
    let request_headers = connector.then(|| req.headers().clone());
    let mut response = next.run(req).await;
    let ok = response.status().is_success();
    let headers = response.headers_mut();
    if let Some(request) = &request_headers {
        mcp_cors(request, headers);
    }
    let html = headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    let caching = if cacheable && ok {
        "public, max-age=31536000, immutable"
    } else if html {
        "no-store, no-transform"
    } else {
        "no-store"
    };
    headers.insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static(caching),
    );
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "SAMEORIGIN"),
        ("content-security-policy", CONTENT_SECURITY_POLICY),
    ] {
        headers.insert(name, axum::http::HeaderValue::from_static(value));
    }
    response
}
pub(super) fn router(s: App) -> Router {
    Router::new()
        .route_service("/mcp", mcp::service(s.clone()))
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(mcp_auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            get(mcp_auth::resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(mcp_auth::authorization_metadata),
        )
        .route(
            "/oauth/register",
            post(mcp_auth::register).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/oauth/authorize", get(mcp_auth::begin_authorization))
        .route(
            "/oauth/token",
            post(mcp_auth::exchange).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/oauth/revoke",
            post(mcp_auth::revoke_token).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route(
            "/api/mcp/authorize",
            get(mcp_auth::consent_preview).post(mcp_auth::consent),
        )
        .route("/api/mcp/connections", get(mcp_auth::connections))
        .route(
            "/api/mcp/connections/{id}/revoke",
            post(mcp_auth::disconnect),
        )
        .route("/api/recovery/removed", get(maintenance::removed))
        .route("/api/docs/{id}/recovery", get(maintenance::export))
        .route("/api/docs/{id}/rebuild", post(maintenance::rebuild))
        .route("/api/open/{token}", get(open_shared))
        .route("/api/docs/{id}/versions", get(versions))
        .route("/api/docs/{id}/versions/{revision}", get(version))
        .route("/api/docs/{id}/versions/{revision}/restore", post(restore))
        .route("/api/ticket", post(issue_ticket))
        .route("/api/redeem", post(redeem))
        .route("/api/config", get(config))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route(
            "/api/folders/share",
            get(folders::read).post(folders::share),
        )
        .route(
            "/api/folders/mcp",
            get(mcp_access::read_folder).post(mcp_access::change_folder),
        )
        .route(
            "/api/folders",
            patch(actions::move_folder).delete(actions::delete_folder),
        )
        .route("/api/trash", get(actions::trash))
        .route("/api/trash/{id}/restore", post(actions::restore))
        .route("/api/tree", get(tree))
        .route("/api/files", post(create))
        .route("/api/shared/{token}", get(shared))
        .route(
            "/api/docs/{id}",
            get(document).patch(rename).delete(actions::delete_document),
        )
        .route("/api/docs/{id}/duplicate", post(actions::duplicate))
        .route("/api/docs/{id}/share", post(share))
        .route(
            "/api/docs/{id}/mcp",
            get(mcp_access::read_document).post(mcp_access::change_document),
        )
        .route("/api/docs/{id}/link-preview", get(links::preview))
        .route(
            "/api/docs/{id}/comments",
            get(comments::list).post(comments::add),
        )
        .route("/api/docs/{id}/comments/{cid}", patch(comments::edit))
        .route(
            "/api/docs/{id}/upload",
            post(upload).layer(DefaultBodyLimit::max(21 * MB)),
        )
        .route("/api/docs/{id}/media", get(media::media))
        .route("/api/docs/{id}/media/share", post(media::share_media))
        .route("/api/fonts", get(font_list).post(install_font))
        .route("/api/fonts.css", get(font_css))
        .route("/ws/{id}", get(websocket))
        .nest_service("/fonts", ServeDir::new(s.data.join("fonts")))
        .route("/", get(web::shell))
        .route("/index.html", get(web::shell))
        .route("/d/{id}", get(web::shell))
        .route("/d/{id}/", get(web::shell))
        .route("/s/{token}", get(web::shell))
        .route("/s/{token}/", get(web::shell))
        .route("/s/{token}/preview.png", get(web::preview_image))
        .fallback_service(ServeDir::new(s.web_root.clone()))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::from_fn(response_headers))
        .layer(axum::middleware::from_fn_with_state(s.clone(), guard))
        .layer(axum::middleware::from_fn(web::observe_crawlers))
        .with_state(s)
}
