//! `locdoc --restored`: the owner's one-shot pass after a backup's state files
//! and documents folder were copied back into place. It binds no port and
//! takes the same state-folder lock as the server. Only a completed pass
//! records the copy as this state's documents folder, so normal startup keeps
//! refusing an unfinished restore.
use super::*;

pub(super) const REPORT: &str = "restore-report.json";

/// Run the restore pass, record the restored folder once it completes and
/// write the owner's report into the state folder.
pub(super) fn restore(store: &Store) -> Result<Value> {
    // A backup without root.identity would otherwise let normal startup
    // accept the folder before this pass completes.
    documents::hold_root(&store.data)?;
    let outcome = store.restore_documents()?;
    let mut problem = outcome.problem;
    if problem.is_none()
        && let Err(error) = documents::record_root(&store.data, &store.root_identity)
    {
        problem = Some(format!(
            "Could not record the restored documents folder: {error}"
        ));
    }
    let documents: Vec<Value> = outcome
        .documents
        .iter()
        .map(|document| {
            json!({
                "id": document.id,
                "recordedPath": document.recorded,
                "restoredPath": document.restored,
                "evidence": document.evidence,
            })
        })
        .collect();
    let report = json!({
        "format": "locdoc-restore-v1",
        "completed": problem.is_none(),
        "problem": problem,
        "created": now(),
        "documentsFolder": store.root,
        "documents": documents,
        "unclaimedFiles": outcome.unclaimed,
        "folderLinks": folders::unmatched(store)?,
        "mcpFolders": mcp_access::unmatched_folders(store)?,
    });
    write_report(&store.data, &report)?;
    Ok(report)
}

fn write_report(data: &Path, report: &Value) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = data.join(format!(".restore-report-{}.tmp", uuid::Uuid::new_v4()));
    let result: Result<()> = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, report)
            .map_err(|_| bad("Could not write the restore report."))?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, data.join(REPORT))?;
        fs::File::open(data)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// The command line entry point; fails unless the pass completed.
pub(super) fn run(root: PathBuf, data: PathBuf, public_url: String) -> std::process::ExitCode {
    let result = Store::open_restored(root, data, public_url).and_then(|store| {
        let report = restore(&store)?;
        Ok((store.data.join(REPORT), report))
    });
    match result {
        Ok((path, report)) => {
            print!("{}", summary(&report, &path));
            if report["completed"] == true {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!("locdoc --restored: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn summary(report: &Value, path: &Path) -> String {
    let list = |key: &str| -> Vec<&str> {
        report[key]
            .as_array()
            .map(|values| values.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    };
    let mut lines = vec![match report["problem"].as_str() {
        None => format!(
            "Restore pass completed for {}.",
            report["documentsFolder"].as_str().unwrap_or_default()
        ),
        Some(problem) => format!(
            "Restore pass incomplete: {problem}\nUntil a pass completes, normal startup refuses the restored folder."
        ),
    }];
    let documents = report["documents"].as_array().cloned().unwrap_or_default();
    let counts: Vec<String> = ["identity", "content", "path", "retired", "undecided"]
        .into_iter()
        .filter_map(|evidence| {
            let count = documents
                .iter()
                .filter(|document| document["evidence"] == evidence)
                .count();
            (count > 0).then(|| format!("{count} {evidence}"))
        })
        .collect();
    lines.push(format!(
        "Documents by evidence: {}.",
        if counts.is_empty() {
            "none".into()
        } else {
            counts.join(", ")
        }
    ));
    let unclaimed = list("unclaimedFiles");
    if !unclaimed.is_empty() {
        lines.push(format!(
            "{} restored files belong to no document and open as new private documents.",
            unclaimed.len()
        ));
    }
    let links = list("folderLinks");
    if !links.is_empty() {
        lines.push(format!(
            "Folder links that no longer open their folder, to share again: {}.",
            links.join(", ")
        ));
    }
    let mcp = list("mcpFolders");
    if !mcp.is_empty() {
        lines.push(format!(
            "Folders whose MCP access to allow again: {}.",
            mcp.join(", ")
        ));
    }
    lines.push(format!("Report: {}", path.display()));
    lines.join("\n") + "\n"
}

#[cfg(test)]
#[path = "restored_tests.rs"]
mod tests;
