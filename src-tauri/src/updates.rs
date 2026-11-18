//! Automatic updates: the app reads `latest.json` in the GitHub releases of Kwickos/better-harness.
//!
//! The new version downloads in the background (signature checked by the plugin), then
//! installs on a click on "Restart", or when the app quits: the next launch is up to date
//! even without a click.
//!
//! Two channels (Settings → About): stable reads the manifest of the "latest" release, which
//! GitHub never points at a pre-release; beta takes the newest release, beta or stable.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::i18n::tr;

const RELEASES: &str = "https://api.github.com/repos/Kwickos/better-harness/releases?per_page=30";

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
            Err(message) => UpdateState::Error { message },
        };
        self.set(app, state.clone());
        state
    }

    async fn fetch(&self, app: &AppHandle, ready: Option<String>) -> Result<UpdateState, String> {
        let s = |e: tauri_plugin_updater::Error| e.to_string();
        let mut builder = app.updater_builder().timeout(TIMEOUT);
        // Stable keeps the endpoint of tauri.conf.json.
        if beta(app) {
            builder = builder.endpoints(vec![beta_manifest().await?]).map_err(s)?;
        }
        let Some(update) = builder.build().map_err(s)?.check().await.map_err(s)? else {
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
        let bytes = update.download(|_, _| {}, || {}).await.map_err(s)?;
        *self.pending.lock().unwrap() = Some((update, bytes));
        Ok(UpdateState::Ready { version })
    }

    /// The version downloaded for the other channel is dropped, so leaving beta never installs
    /// a beta when the app quits, then the new channel is checked.
    pub async fn switch_channel(&self, app: &AppHandle) {
        {
            // A check in progress finishes on the old channel first.
            let _wait = self.running.lock().await;
            self.pending.lock().unwrap().take();
            self.set(app, UpdateState::Idle);
        }
        if !cfg!(debug_assertions) {
            self.check(app).await;
        }
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

fn beta(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::hub::Hub>>()
        .is_some_and(|hub| hub.settings.lock().unwrap().update_channel == "beta")
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// GitHub has no link to the newest pre-release: the API lists the releases, and the
/// highest version (beta or stable) gives the manifest to read.
async fn beta_manifest() -> Result<tauri::Url, String> {
    // As the updater does: reqwest is built here without a crypto provider of its own.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let s = |e: reqwest::Error| e.to_string();
    let releases: Vec<Release> = reqwest::Client::builder()
        .user_agent("better-harness")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(s)?
        .get(RELEASES)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(s)?
        .json()
        .await
        .map_err(s)?;
    let url = newest_manifest(releases).ok_or_else(|| tr("No release found on GitHub.", "Aucune version trouvée sur GitHub.").to_string())?;
    tauri::Url::parse(&url).map_err(|e| e.to_string())
}

fn newest_manifest(releases: Vec<Release>) -> Option<String> {
    releases
        .into_iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version = semver::Version::parse(r.tag_name.trim_start_matches('v')).ok()?;
            let manifest = r.assets.into_iter().find(|a| a.name == "latest.json")?;
            Some((version, manifest.browser_download_url))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, url)| url)
}

/// Checks at launch then every 6 hours. Nothing in development (`tauri dev`):
/// there is no bundle to replace.
pub async fn watch(app: AppHandle, updates: Arc<Updates>) {
    if cfg!(debug_assertions) {
        return;
    }
    tokio::time::sleep(FIRST_CHECK).await;
    loop {
        updates.check(&app).await;
        tokio::time::sleep(EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, manifest: bool) -> Release {
        let mut assets = vec![Asset { name: "Better-Harness.dmg".into(), browser_download_url: format!("{tag}/dmg") }];
        if manifest {
            assets.push(Asset { name: "latest.json".into(), browser_download_url: format!("{tag}/latest.json") });
        }
        Release { tag_name: tag.into(), draft, assets }
    }

    #[test]
    fn beta_takes_the_highest_version() {
        let pick = |list| newest_manifest(list);
        // A stable comes after its betas; beta.10 after beta.9.
        assert_eq!(pick(vec![release("v0.2.0-beta.2", false, true), release("v0.2.0", false, true), release("v0.1.0", false, true)]).as_deref(), Some("v0.2.0/latest.json"));
        assert_eq!(pick(vec![release("v0.3.0-beta.9", false, true), release("v0.3.0-beta.10", false, true), release("v0.2.0", false, true)]).as_deref(), Some("v0.3.0-beta.10/latest.json"));
        // Drafts, releases without a manifest and odd tags are skipped.
        assert_eq!(pick(vec![release("v0.4.0", true, true), release("v0.3.0", false, false), release("nightly", false, true), release("v0.2.0", false, true)]).as_deref(), Some("v0.2.0/latest.json"));
        assert_eq!(pick(vec![]), None);
    }
}
