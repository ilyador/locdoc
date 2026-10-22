//! The owner's display name. LOCDOC_OWNER_NAME stays the default until the
//! owner chooses a name in Settings; the choice is stored with the workspace,
//! so every device shows it. Comment records already written keep their name.
use super::*;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    // A table of its own, so a build from before it still opens the database.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS owner_profile(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL);",
    )?;
    Ok(())
}

pub(super) struct OwnerName {
    configured: String,
    // Kept in memory so reading the name never waits for SQLite.
    chosen: Mutex<Option<String>>,
}

impl OwnerName {
    pub(super) fn load(db: &Connection, configured: Option<String>) -> Result<Self> {
        let chosen = db
            .query_row("SELECT name FROM owner_profile WHERE id=1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .filter(|name| sockets::valid_name(name));
        Ok(Self {
            configured: configured
                .filter(|name| !name.trim().is_empty())
                .map(|name| name.trim().chars().take(60).collect())
                .unwrap_or_else(|| "Owner".into()),
            chosen: Mutex::new(chosen),
        })
    }

    pub(super) fn get(&self) -> String {
        let chosen = self.chosen.lock().unwrap();
        chosen.clone().unwrap_or_else(|| self.configured.clone())
    }
}

#[derive(Deserialize)]
pub(super) struct Profile {
    name: String,
}

/// The owner chooses a display name, checked as presence names are.
pub(super) async fn update(
    State(s): State<App>,
    _owner: security::Owner,
    Json(profile): Json<Profile>,
) -> Result<Json<Value>> {
    if !sockets::valid_name(&profile.name) {
        return Err(bad("Enter a name (1–60 characters)."));
    }
    let name = profile.name.trim().to_owned();
    job(s, move |s| {
        let db = s.db.lock().unwrap();
        db.execute(
            "INSERT INTO owner_profile(id,name) VALUES(1,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name",
            [&name],
        )?;
        // Still holding SQLite, so concurrent choices reach memory in the
        // order they were stored.
        *s.owner_name.chosen.lock().unwrap() = Some(name.clone());
        Ok(Json(json!({ "name": name })))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(dir: &tempfile::TempDir) -> App {
        Store::open(
            dir.path().join("docs"),
            dir.path().join("state"),
            "http://localhost:3477".into(),
        )
        .unwrap()
    }

    fn owner_name(s: &App, configured: &str) -> String {
        let db = s.db.lock().unwrap();
        OwnerName::load(&db, Some(configured.into())).unwrap().get()
    }

    async fn choose(s: &App, name: &str) -> Result<Json<Value>> {
        let profile = Profile { name: name.into() };
        update(State(s.clone()), security::Owner, Json(profile)).await
    }

    #[tokio::test]
    async fn a_chosen_owner_name_replaces_the_configured_default_and_survives_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let s = open(&dir);
        assert_eq!(owner_name(&s, "  alex  "), "alex", "the configured default");
        assert_eq!(owner_name(&s, " "), "Owner");
        let saved = choose(&s, "  Ilya Dorman ").await.unwrap();
        assert_eq!(saved.0["name"], "Ilya Dorman");
        assert_eq!(s.owner_name.get(), "Ilya Dorman", "used at once");
        drop(s);
        let s = open(&dir);
        assert_eq!(
            owner_name(&s, "alex"),
            "Ilya Dorman",
            "stored, not configured"
        );
        assert_eq!(s.owner_name.get(), "Ilya Dorman");
    }

    #[tokio::test]
    async fn owner_names_follow_the_presence_rules() {
        let dir = tempfile::tempdir().unwrap();
        let s = open(&dir);
        let before = s.owner_name.get();
        for name in ["", "   ", "Tab\tname", "New\nline", &"x".repeat(61)] {
            let error = choose(&s, name).await.unwrap_err();
            assert_eq!(error.0, StatusCode::BAD_REQUEST, "{name:?}");
            assert_eq!(s.owner_name.get(), before, "{name:?} changes nothing");
            assert!(!sockets::valid_presence(
                &json!({"user": {"name": name}}).to_string()
            ));
        }
        let longest = "é".repeat(60);
        assert_eq!(choose(&s, &longest).await.unwrap().0["name"], longest);
        assert!(sockets::valid_presence(
            &json!({"user": {"name": longest}}).to_string()
        ));
        assert_eq!(owner_name(&s, "alex"), longest);
        // A row no presence could carry, as from a hand edit, is ignored.
        s.db.lock()
            .unwrap()
            .execute("UPDATE owner_profile SET name='bad\u{7}name'", [])
            .unwrap();
        assert_eq!(owner_name(&s, "alex"), "alex");
    }
}
