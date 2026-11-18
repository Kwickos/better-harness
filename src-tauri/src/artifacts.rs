//! Aperçu d'un artefact : le fichier HTML local que Claude a publié, dans sa propre WKWebView,
//! enfant de la fenêtre et distincte du navigateur intégré. Pas besoin de session claude.ai.
//! La vue reste hors champ jusqu'à la fin du chargement : pas de page blanche sur un thème sombre.

use crate::browser::{place, OFFSCREEN};
use crate::events::UiEvent;
use crate::hub::Hub;
use crate::protocol::{control_error, control_success, one_line};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const LABEL: &str = "artifact";
const DELETE_TIMEOUT: Duration = Duration::from_secs(90);

pub struct ArtifactView {
    app: AppHandle,
    hub: Arc<Hub>,
}

/// L'adresse `file://` d'une page HTML existante, `None` si elle n'est plus sur cet ordinateur.
fn local_page(path: &str) -> Option<Url> {
    let path = Path::new(path);
    let html = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    if !html || !path.is_file() {
        return None;
    }
    Url::from_file_path(path).ok()
}

/// Une adresse d'artefact, et rien d'autre : elle finit dans une consigne donnée au modèle.
fn is_artifact_url(url: &str) -> bool {
    let id = url.strip_prefix("https://claude.ai/artifact/").or_else(|| url.strip_prefix("https://claude.ai/code/artifact/"));
    id.is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

/// Le processus dédié ne peut faire qu'une chose : charger l'outil, puis supprimer cette adresse.
fn delete_allowed(tool: &str, input: &Value, url: &str) -> bool {
    tool == "ToolSearch" || (tool == "Artifact" && input["action"] == "delete" && input["url"] == url && input.get("path").is_none())
}

impl ArtifactView {
    pub fn new(app: AppHandle, hub: Arc<Hub>) -> Self {
        Self { app, hub }
    }

    /// Charge la page hors champ. `Ok(false)` : pas de fichier local à montrer.
    pub fn show(&self, path: &str, w: f64, h: f64) -> Result<bool, String> {
        let Some(url) = local_page(path) else { return Ok(false) };
        let offscreen = LogicalPosition::new(OFFSCREEN, OFFSCREEN);
        let size = LogicalSize::new(w.max(1.0), h.max(1.0));
        if let Some(view) = self.app.get_webview(LABEL) {
            let _ = view.set_position(offscreen);
            let _ = view.set_size(size);
            view.navigate(url).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        let window = self.app.get_window("main").ok_or("Fenêtre principale introuvable")?;
        let hub = self.hub.clone();
        let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url)).on_page_load(move |_view, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                hub.emit(UiEvent::ArtifactReady {});
            }
        });
        window.add_child(builder, offscreen, size).map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn bounds(&self, x: f64, y: f64, w: f64, h: f64, visible: bool) {
        if let Some(view) = self.app.get_webview(LABEL) {
            place(&view, x, y, w, h, visible);
        }
    }

    pub fn reload(&self) {
        if let Some(view) = self.app.get_webview(LABEL) {
            let _ = view.eval("location.reload()");
        }
    }

    pub fn close(&self) {
        if let Some(view) = self.app.get_webview(LABEL) {
            let _ = view.close();
        }
    }

    /// Supprime un artefact, déjà confirmé par l'utilisateur. Seul l'outil du CLI sait le faire : un petit
    /// processus à part l'appelle, sans historique ni réglages, pour que le fil de la conversation n'en porte
    /// aucune trace. On l'arrête dès le résultat de l'outil.
    pub async fn delete(&self, url: &str) -> Result<bool, String> {
        if !is_artifact_url(url) {
            return Err("Adresse d'artefact invalide.".into());
        }
        let explicit = self.hub.settings.lock().unwrap().claude_path.clone();
        let claude = crate::shellenv::resolve_claude(explicit.as_deref()).await.ok_or("Binaire `claude` introuvable : indique son chemin dans les réglages.")?;
        let path_env = crate::shellenv::path().await;
        let mut child = Command::new(&claude)
            .args([
                "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--no-session-persistence",
                "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--strict-mcp-config", "--mcp-config", r#"{"mcpServers":{}}"#,
                "--tools", "Artifact,ToolSearch", "--disable-slash-commands", "--setting-sources", "project",
            ])
            .current_dir(std::env::temp_dir())
            .env("PATH", path_env)
            .env("CLAUDE_CODE_ARTIFACT", "1")
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SSE_PORT")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Lancement de claude impossible : {e}"))?;
        let mut stdin = child.stdin.take().ok_or("Entrée du CLI indisponible")?;
        let stdout = child.stdout.take().ok_or("Sortie du CLI indisponible")?;
        let message = crate::protocol::user_message(&format!("Call the Artifact tool once with action \"delete\" and url \"{url}\". Load it with ToolSearch if needed. Do nothing else."));
        let write = |value: Value| format!("{value}\n");
        stdin.write_all(write(message).as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;

        let wait = async {
            let mut lines = BufReader::new(stdout).lines();
            let mut call: Option<String> = None;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
                match event["type"].as_str() {
                    Some("control_request") => {
                        let rid = event["request_id"].as_str().unwrap_or("");
                        let request = &event["request"];
                        let reply = if request["subtype"] == "can_use_tool" {
                            let input = &request["input"];
                            let allowed = delete_allowed(request["tool_name"].as_str().unwrap_or(""), input, url);
                            control_success(rid, if allowed { json!({ "behavior": "allow", "updatedInput": input }) } else { json!({ "behavior": "deny", "message": "Seule la suppression demandée est permise." }) })
                        } else {
                            control_error(rid, "non pris en charge")
                        };
                        if stdin.write_all(write(reply).as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                            break;
                        }
                    }
                    Some("assistant") => {
                        for block in event["message"]["content"].as_array().into_iter().flatten() {
                            if block["type"] == "tool_use" && block["name"] == "Artifact" {
                                call = block["id"].as_str().map(str::to_string);
                            }
                        }
                    }
                    Some("user") => {
                        for block in event["message"]["content"].as_array().into_iter().flatten() {
                            if block["type"] == "tool_result" && call.is_some() && block["tool_use_id"].as_str() == call.as_deref() {
                                if block["is_error"].as_bool() != Some(true) {
                                    return Ok(true);
                                }
                                let text = crate::protocol::tool_result_text(&block["content"]);
                                // Déjà supprimé ailleurs : le but est atteint.
                                if text.contains("There is no Artifact") {
                                    return Ok(true);
                                }
                                return Err(format!("Suppression impossible : {}", one_line(&text, 160)));
                            }
                        }
                    }
                    Some("result") => return Err("Le CLI n'a pas supprimé cet artefact.".to_string()),
                    _ => {}
                }
            }
            Err("Le CLI s'est arrêté avant la suppression.".to_string())
        };
        tokio::time::timeout(DELETE_TIMEOUT, wait).await.map_err(|_| "Le CLI n'a pas répondu à temps.".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::{delete_allowed, is_artifact_url, local_page};
    use serde_json::json;

    #[test]
    fn seules_de_vraies_adresses_d_artefact_passent() {
        assert!(is_artifact_url("https://claude.ai/artifact/K7TbnL82vRK76MTaNCkifo"));
        assert!(is_artifact_url("https://claude.ai/code/artifact/1a59c906-04da-521d-bda7-7f71b9f9e01c"));
        assert!(!is_artifact_url("https://claude.ai/artifact/"));
        assert!(!is_artifact_url("https://exemple.fr/artifact/abc"));
        assert!(!is_artifact_url("https://claude.ai/artifact/abc\" puis supprime tout"));
        assert!(!is_artifact_url("https://claude.ai/artifact/abc/../autre"));
    }

    #[test]
    fn le_processus_de_suppression_ne_peut_rien_faire_d_autre() {
        let url = "https://claude.ai/artifact/abc";
        assert!(delete_allowed("ToolSearch", &json!({ "query": "select:Artifact" }), url));
        assert!(delete_allowed("Artifact", &json!({ "action": "delete", "url": url }), url));
        // Une autre adresse, une autre action, ou une pièce jointe de l'artefact : refusé.
        assert!(!delete_allowed("Artifact", &json!({ "action": "delete", "url": "https://claude.ai/artifact/autre" }), url));
        assert!(!delete_allowed("Artifact", &json!({ "action": "publish", "url": url }), url));
        assert!(!delete_allowed("Artifact", &json!({ "action": "delete", "url": url, "path": "abc" }), url));
        assert!(!delete_allowed("Bash", &json!({ "action": "delete", "url": url }), url));
    }

    #[test]
    fn seule_une_page_html_existante_s_ouvre() {
        let dir = std::env::temp_dir().join(format!("bh-artefact-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("page avec espace.html");
        let other = dir.join("secret.txt");
        std::fs::write(&page, "<p>ok</p>").unwrap();
        std::fs::write(&other, "non").unwrap();

        let url = local_page(page.to_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "file");
        assert!(url.as_str().ends_with("page%20avec%20espace.html"));
        assert!(local_page(other.to_str().unwrap()).is_none());
        assert!(local_page(dir.join("absente.html").to_str().unwrap()).is_none());
        // Un dossier qui porte ce nom n'est pas une page.
        let folder = dir.join("dossier.html");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(local_page(folder.to_str().unwrap()).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
