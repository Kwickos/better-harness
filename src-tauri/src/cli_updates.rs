//! Keeps the `claude` CLI up to date: the app runs `claude update` shortly after launch,
//! then every 6 hours, so the CLI stays current even when only the app ever starts it.
//!
//! `claude update` knows how the CLI was installed (native installer, npm, Homebrew…)
//! and follows its update channel (`autoUpdatesChannel`). Live conversations keep the
//! version they started with; the new one applies from their next start.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

use crate::hub::Hub;
use crate::i18n::tr;

/// After the app's own check (20 s), so both do not start at once.
const FIRST_CHECK: Duration = Duration::from_secs(40);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// The download weighs about a hundred MB; a network that stops answering must not block the next checks.
const TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CliUpdateState {
    #[default]
    Idle,
    Checking,
    UpToDate { version: String },
    Updated { from: String, version: String },
    Error { message: String },
}

pub struct CliUpdates {
    hub: Arc<Hub>,
    state: Mutex<CliUpdateState>,
    /// One `claude update` at a time (automatic check and the Settings button).
    running: tokio::sync::Mutex<()>,
}

impl CliUpdates {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self { hub, state: Mutex::default(), running: tokio::sync::Mutex::new(()) }
    }

    pub fn state(&self) -> CliUpdateState {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, app: &AppHandle, state: CliUpdateState) {
        *self.state.lock().unwrap() = state.clone();
        let _ = app.emit("cli-update", state);
    }

    fn enabled(&self) -> bool {
        self.hub.settings.lock().unwrap().cli_auto_update
    }

    /// Runs `claude update`. Returns the resulting state.
    pub async fn check(&self, app: &AppHandle) -> CliUpdateState {
        let Ok(_guard) = self.running.try_lock() else {
            return self.state();
        };
        self.set(app, CliUpdateState::Checking);
        let state = self.run().await.unwrap_or_else(|message| CliUpdateState::Error { message });
        self.set(app, state.clone());
        state
    }

    async fn run(&self) -> Result<CliUpdateState, String> {
        let explicit = self.hub.settings.lock().unwrap().claude_path.clone();
        let claude = crate::shellenv::resolve_claude(explicit.as_deref())
            .await
            .ok_or(tr("claude CLI not found.", "CLI claude introuvable."))?;
        update(&claude).await
    }
}

async fn update(claude: &Path) -> Result<CliUpdateState, String> {
    // A binary that does not answer `--version` like the CLI is not asked to update itself.
    let from = version(claude).await.ok_or(tr("Couldn't read the claude version.", "Version de claude illisible."))?;
    let mut cmd = Command::new(claude);
    cmd.arg("update")
        .env("PATH", crate::shellenv::path().await)
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .env_remove("CLAUDE_CODE_SSE_PORT")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(TIMEOUT, cmd.output())
        .await
        .map_err(|_| tr("claude update took too long.", "claude update a pris trop de temps.").to_string())?
        .map_err(|e| tr(format!("Could not start claude update: {e}"), format!("Lancement de claude update impossible : {e}")))?;
    if !out.status.success() {
        return Err(failure(&out.stderr, &out.stdout).unwrap_or_else(|| {
            let code = out.status.code().unwrap_or(-1);
            tr(format!("claude update failed (code {code})."), format!("claude update a échoué (code {code})."))
        }));
    }
    // Compared rather than read from the output, whose wording changes with the install method.
    let version = version(claude).await.unwrap_or_else(|| from.clone());
    Ok(if version == from { CliUpdateState::UpToDate { version } } else { CliUpdateState::Updated { from, version } })
}

/// `2.1.327` from `2.1.327 (Claude Code)`.
fn number(raw: &str) -> Option<String> {
    raw.split_whitespace().next().map(str::to_string)
}

async fn version(claude: &Path) -> Option<String> {
    number(&crate::shellenv::claude_version(claude).await?)
}

/// The last line `claude update` printed on error, which says what went wrong.
fn failure(stderr: &[u8], stdout: &[u8]) -> Option<String> {
    [stderr, stdout].into_iter().find_map(|bytes| {
        String::from_utf8_lossy(bytes).lines().map(str::trim).rfind(|l| !l.is_empty()).map(str::to_string)
    })
}

/// Updates at launch, then every 6 hours, unless the setting is off.
pub async fn watch(app: AppHandle, cli: Arc<CliUpdates>) {
    tokio::time::sleep(FIRST_CHECK).await;
    loop {
        if cli.enabled() {
            cli.check(&app).await;
        }
        tokio::time::sleep(EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_number() {
        assert_eq!(number("2.1.327 (Claude Code)").as_deref(), Some("2.1.327"));
        assert_eq!(number("  "), None);
    }

    #[test]
    fn keeps_the_last_error_line() {
        assert_eq!(failure(b"Checking...\nError: EACCES\n\n", b"").as_deref(), Some("Error: EACCES"));
        assert_eq!(failure(b"", b"Current version: 2.1.327\nNo write access\n").as_deref(), Some("No write access"));
        assert_eq!(failure(b"\n", b""), None);
    }

    /// A `claude` that prints the version stored in the file `$V`, and whose `update` runs `on_update`.
    fn fake_claude(on_update: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("bh-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("v"), "2.1.1\n").unwrap();
        let bin = dir.join("claude");
        let script = format!(
            "#!/bin/sh\nV='{}'\nif [ \"$1\" = update ]; then {on_update}; fi\nprintf '%s (Claude Code)\\n' \"$(cat \"$V\")\"\n",
            dir.join("v").display()
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (bin, dir)
    }

    #[tokio::test]
    async fn reports_the_new_version_then_up_to_date() {
        let (bin, dir) = fake_claude("echo 2.1.2 > \"$V\"; exit 0");
        let updated = CliUpdateState::Updated { from: "2.1.1".into(), version: "2.1.2".into() };
        assert_eq!(update(&bin).await, Ok(updated));
        assert_eq!(update(&bin).await, Ok(CliUpdateState::UpToDate { version: "2.1.2".into() }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn reports_why_the_update_failed() {
        let (bin, dir) = fake_claude("echo 'Checking...'; echo 'Error: EACCES' >&2; exit 1");
        assert_eq!(update(&bin).await, Err("Error: EACCES".into()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
