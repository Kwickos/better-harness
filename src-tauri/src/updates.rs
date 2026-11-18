//! Automatic updates: the app reads `latest.json` in the GitHub releases of Kwickos/better-harness.
//!
//! The new version downloads in the background (signature checked by the plugin), then
//! installs on a click on "Restart", or when the app quits: the next launch is up to date
//! even without a click.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// First check shortly after launch, so startup is not slowed down.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// A network that stops answering must not block the next checks.
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Default, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateState {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Downloading { version: String },
    Ready { version: String },
    Error { message: String },
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<UpdateState>,
    /// Package downloaded and verified, ready to replace the app.
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    /// One check at a time (automatic launch and the Settings button).
    running: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn state(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, app: &AppHandle, state: UpdateState) {
        *self.state.lock().unwrap() = state.clone();
        let _ = app.emit("update", state);
    }

    /// Looks for a newer version and downloads it. Returns the resulting state.
    pub async fn check(&self, app: &AppHandle) -> UpdateState {
        let Ok(_guard) = self.running.try_lock() else {
            return self.state();
        };
        let ready = self.pending.lock().unwrap().as_ref().map(|(u, _)| u.version.clone());
        self.set(app, UpdateState::Checking);
        let state = match self.fetch(app, ready).await {
            Ok(state) => state,
            Err(e) => UpdateState::Error { message: e.to_string() },
        };
        self.set(app, state.clone());
        state
    }

    async fn fetch(&self, app: &AppHandle, ready: Option<String>) -> tauri_plugin_updater::Result<UpdateState> {
        let Some(update) = app.updater_builder().timeout(TIMEOUT).build()?.check().await? else {
            return Ok(match ready {
                Some(version) => UpdateState::Ready { version },
                None => UpdateState::UpToDate,
            });
        };
        let version = update.version.clone();
        if ready.as_deref() == Some(version.as_str()) {
            return Ok(UpdateState::Ready { version });
        }
        self.set(app, UpdateState::Downloading { version: version.clone() });
        let bytes = update.download(|_, _| {}, || {}).await?;
        *self.pending.lock().unwrap() = Some((update, bytes));
        Ok(UpdateState::Ready { version })
    }

    /// Replaces the app with the downloaded version. `false` if there was nothing to install.
    pub fn install(&self) -> Result<bool, String> {
        let Some((update, bytes)) = self.pending.lock().unwrap().take() else {
            return Ok(false);
        };
        update.install(bytes).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

/// Checks at launch then every 6 hours. Nothing in development (`tauri dev`):
/// there is no bundle to replace.
pub async fn watch(app: AppHandle, updates: std::sync::Arc<Updates>) {
    if cfg!(debug_assertions) {
        return;
    }
    tokio::time::sleep(FIRST_CHECK).await;
    loop {
        updates.check(&app).await;
        tokio::time::sleep(EVERY).await;
    }
}
