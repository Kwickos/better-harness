//! Mises à jour automatiques : l'app lit `latest.json` dans les releases GitHub de Kwickos/better-harness.
//!
//! La nouvelle version se télécharge en arrière-plan (signature vérifiée par le plugin), puis
//! s'installe quand on clique sur « Redémarrer », ou à la fermeture de l'app : le lancement
//! suivant est à jour même sans clic.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Premier contrôle peu après le lancement, pour ne pas ralentir le démarrage.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Un réseau qui ne répond plus ne doit pas bloquer les vérifications suivantes.
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
    /// Paquet téléchargé et vérifié, prêt à remplacer l'app.
    pending: Mutex<Option<(Update, Vec<u8>)>>,
    /// Une seule vérification à la fois (lancement automatique et bouton des Réglages).
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

    /// Cherche une version plus récente et la télécharge. Renvoie l'état obtenu.
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

    /// Remplace l'app par la version téléchargée. `false` s'il n'y avait rien à installer.
    pub fn install(&self) -> Result<bool, String> {
        let Some((update, bytes)) = self.pending.lock().unwrap().take() else {
            return Ok(false);
        };
        update.install(bytes).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

/// Contrôle au lancement puis toutes les 6 heures. Rien en développement (`tauri dev`) :
/// il n'y a pas de bundle à remplacer.
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
