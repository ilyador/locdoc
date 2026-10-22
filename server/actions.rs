//! The owner's sidebar file actions over HTTP. Every route is owner-only;
//! the filesystem steps belong to documents.rs and namespace.rs.
use super::*;

#[derive(Deserialize)]
pub(super) struct Target {
    path: String,
}

/// A new private document holding a document's current accepted text,
/// from its collaboration state rather than its file, without comment
/// records.
pub(super) async fn duplicate(
    State(s): State<App>,
    AxPath(id): AxPath<String>,
    _owner: security::Owner,
    Json(target): Json<Target>,
) -> Result<Json<Value>> {
    doc_job(s, id.clone(), move |s| {
        let original = s.doc(&id)?;
        let room = s.room(&original)?;
        let (source, ending) = {
            let mut room = room.lock().unwrap();
            // Only what passed the durable commit barrier is accepted text.
            room.ensure_committed(s, &original)?;
            (room_text(&room), room.engine.ending().to_owned())
        };
        let copy = s.duplicate_document(
            &original,
            &target.path,
            &comments::without_records(&source),
            &ending,
        )?;
        Ok(Json(json!(copy)))
    })
    .await
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
