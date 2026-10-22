//! Document share links and the page a share or folder link opens.
use super::*;

pub(super) fn shared_document(s: &Store, token: &str) -> Result<Document> {
    let id: Option<String> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT id FROM docs WHERE token=? AND permission!='private'",
                [token],
                |r| r.get(0),
            )
            .optional()?;
    let id = id.ok_or(ApiError(
        StatusCode::NOT_FOUND,
        "This link has been turned off or does not exist.".into(),
    ))?;
    s.doc(&id)
}
pub(super) async fn shared(
    State(s): State<App>,
    AxPath(token): AxPath<String>,
) -> Result<Json<Value>> {
    if let Ok(folder) = folders::grant(&s, &token) {
        return Ok(Json(
            json!({"id":folders::document(&s,&folder,None)?.map(|doc|doc.id)}),
        ));
    }
    Ok(Json(json!({"id":shared_document(&s, &token)?.id})))
}
pub(super) async fn open_shared(
    State(s): State<App>,
    AxPath(token): AxPath<String>,
    h: HeaderMap,
    Query(selection): Query<folders::Selection>,
) -> Result<Response> {
    let (document, folder, token) = job(s.clone(), move |s| {
        if let Ok(folder) = folders::grant(s, &token) {
            let entries = folders::entries(s, &folder)?;
            let selected = selection
                .doc
                .as_deref()
                .or_else(|| entries.iter().find_map(|entry| entry.id.as_deref()));
            let document = folders::document(s, &folder, selected)?;
            Ok((document, Some((folder.value(s), json!(entries))), token))
        } else {
            Ok((Some(shared_document(s, &token)?), None, token))
        }
    })
    .await?;
    let headers = h.clone();
    let document = if let Some(document) = document {
        Some(
            doc_job(s.clone(), document.id.clone(), move |s| {
                document_payload(
                    s,
                    &headers,
                    &document,
                    &Access {
                        token: Some(token),
                        ..Access::default()
                    },
                )
            })
            .await?,
        )
    } else {
        None
    };
    job(s, move |s| {
        Ok(match folder {
            Some((folder, entries)) => configuration_extra(
                s,
                &h,
                json!({"folder":folder,"entries":entries,"document":document}),
            ),
            None => configuration(s, &h, document),
        })
    })
    .await
}
#[derive(Deserialize)]
pub(super) struct Share {
    pub(super) permission: String,
    #[serde(default)]
    pub(super) rotate: bool,
}
pub(super) async fn share(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(b): Json<Share>,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| share_document(s, id, b))
        .await
        .map(Json)
}
pub(super) fn share_document(s: &Store, id: String, b: Share) -> Result<Value> {
    if !["private", "view", "edit"].contains(&b.permission.as_str()) {
        return Err(bad("Choose private, view, or edit."));
    }
    let d = s.doc(&id)?;
    let t = if b.permission == "private" {
        None
    } else {
        Some(match (b.rotate, d.permission.as_str(), d.token) {
            (false, permission, Some(existing)) if permission != "private" => existing,
            _ => token(),
        })
    };
    s.db.lock().unwrap().execute(
        "UPDATE docs SET permission=?,token=? WHERE id=?",
        params![b.permission, t, id],
    )?;
    s.permissions.invalidate();
    // Existing visitors reconnect with the new mode. Cached passive checks
    // are invalidated even if a busy room cannot be notified immediately.
    let room = s.rooms.lock().unwrap().get(&id).cloned();
    if let Some(room) = room {
        let _ = room.lock().unwrap().tx.send(vec![126]);
    }
    let share_url = t.map(|token| format!("{}/s/{token}", s.public_url));
    Ok(json!({
        "permission": b.permission,
        "shareUrl": share_url,
    }))
}
