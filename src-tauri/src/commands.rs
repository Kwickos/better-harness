use crate::events::{MetricsSnapshot, SessionInfo, UiEvent};
use crate::history::{self, HistoryEntry};
use crate::hub::{CreateOpts, Hub, KeptWorktree};
use crate::i18n::tr;
use crate::mcp::{self, McpEntry};
use crate::metrics::Metrics;
use crate::settings::Settings;
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

type H<'a> = State<'a, Arc<Hub>>;

#[tauri::command]
pub fn subscribe(hub: H<'_>, on_event: Channel<UiEvent>) {
    hub.set_channel(on_event);
}

#[tauri::command]
pub fn list_sessions(hub: H<'_>) -> Vec<SessionInfo> {
    hub.list()
}

#[tauri::command]
pub async fn create_session(hub: H<'_>, opts: CreateOpts) -> Result<SessionInfo, String> {
    hub.inner().clone().create_session(opts).await
}

#[tauri::command]
pub async fn send_message(hub: H<'_>, sid: String, text: String) -> Result<(), String> {
    hub.inner().clone().send(&sid, text).await
}

#[tauri::command]
pub async fn interrupt(hub: H<'_>, sid: String) -> Result<(), String> {
    hub.inner().clone().interrupt(&sid).await
}

#[tauri::command]
pub async fn respond_permission(
    hub: H<'_>,
    sid: String,
    request_id: String,
    decision: String,
    message: Option<String>,
    answers: Option<serde_json::Value>,
) -> Result<(), String> {
    hub.inner().clone().respond_permission(&sid, &request_id, &decision, message, answers).await
}

#[tauri::command]
pub async fn set_permission_mode(hub: H<'_>, sid: String, mode: String) -> Result<(), String> {
    hub.inner().clone().set_permission_mode(&sid, mode).await
}

#[tauri::command]
pub async fn set_model(hub: H<'_>, sid: String, model: Option<String>) -> Result<(), String> {
    hub.inner().clone().set_model(&sid, model).await
}

#[tauri::command]
pub fn suspend_session(hub: H<'_>, sid: String) {
    hub.suspend(&sid, tr("manual", "manuelle"));
}

#[tauri::command]
pub fn close_session(hub: H<'_>, sid: String) {
    hub.close(&sid);
}

#[tauri::command]
pub fn focus_session(hub: H<'_>, sid: Option<String>) {
    hub.inner().set_focus(sid);
}

#[tauri::command]
pub fn set_visible(hub: H<'_>, visible: bool) {
    hub.inner().set_visible(visible);
}

#[tauri::command]
pub async fn list_history(hub: H<'_>, limit: usize, query: Option<String>) -> Result<Vec<HistoryEntry>, String> {
    let hidden = hub.archived();
    tauri::async_runtime::spawn_blocking(move || history::list(limit.clamp(1, 500), query.as_deref(), &hidden))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_archived(hub: H<'_>) -> Result<Vec<HistoryEntry>, String> {
    let ids = hub.archived();
    tauri::async_runtime::spawn_blocking(move || history::entries(&ids)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_archived(hub: H<'_>, cli_id: String, archived: bool) -> Result<Option<KeptWorktree>, String> {
    hub.set_archived(&cli_id, archived).await
}

#[tauri::command]
pub async fn delete_conversation(hub: H<'_>, cli_id: String) -> Result<Option<KeptWorktree>, String> {
    hub.delete_conversation(&cli_id).await
}

// ---------------------------------------------------------------- worktrees

#[tauri::command]
pub fn list_worktrees(hub: H<'_>) -> Vec<crate::worktree::Worktree> {
    hub.worktrees()
}

#[tauri::command]
pub async fn worktree_states(hub: H<'_>) -> Result<Vec<crate::worktree::WorktreeState>, String> {
    Ok(hub.worktree_states().await)
}

#[tauri::command]
pub async fn remove_worktree(hub: H<'_>, path: String) -> Result<(), String> {
    hub.remove_worktree(&path).await
}

#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<crate::worktree::Branches, String> {
    crate::worktree::branches(crate::shellenv::path().await, &cwd).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    events: Vec<UiEvent>,
    has_more: bool,
}

#[tauri::command]
pub async fn load_transcript(sid: String, cli_id: String, limit: usize) -> Result<TranscriptPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (events, has_more) = history::load(&sid, &cli_id, limit.clamp(10, 20_000));
        TranscriptPage { events, has_more }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_mcp(cwd: String) -> Vec<McpEntry> {
    mcp::list(&cwd)
}

#[tauri::command]
pub fn get_metrics(hub: H<'_>, metrics: State<'_, Metrics>) -> MetricsSnapshot {
    metrics.snapshot(&hub.live_pids())
}

#[tauri::command]
pub fn get_settings(hub: H<'_>) -> Settings {
    hub.settings.lock().unwrap().clone()
}

/// Language the UI resolved from the settings, for the messages Rust sends it.
#[tauri::command]
pub fn set_language(lang: String) {
    crate::i18n::set(&lang);
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, hub: H<'_>, updates: Up<'_>, settings: Settings) -> Result<(), String> {
    let switched = hub.settings.lock().unwrap().update_channel != settings.update_channel;
    hub.save_settings(settings)?;
    if switched {
        let updates = updates.inner().clone();
        tauri::async_runtime::spawn(async move { updates.switch_channel(&app).await });
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    claude_path: Option<String>,
    claude_version: Option<String>,
    home: String,
}

#[tauri::command]
pub async fn app_info(app: tauri::AppHandle, hub: H<'_>) -> Result<AppInfo, String> {
    let explicit = hub.settings.lock().unwrap().claude_path.clone();
    let path = crate::shellenv::resolve_claude(explicit.as_deref()).await;
    let claude_version = match &path {
        Some(p) => crate::shellenv::claude_version(p).await,
        None => None,
    };
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        claude_path: path.map(|p| p.display().to_string()),
        claude_version,
        home: dirs::home_dir().map(|h| h.display().to_string()).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------- effort, context, MCP

#[tauri::command]
pub async fn set_effort(hub: H<'_>, sid: String, effort: Option<String>) -> Result<(), String> {
    hub.inner().clone().set_effort(&sid, effort).await
}

#[tauri::command]
pub async fn set_advisor(hub: H<'_>, sid: String, advisor: Option<String>) -> Result<(), String> {
    hub.inner().clone().set_advisor(&sid, advisor).await
}

#[tauri::command]
pub async fn context_usage(hub: H<'_>, sid: String) -> Result<Option<serde_json::Value>, String> {
    hub.inner().clone().request(&sid, serde_json::json!({ "subtype": "get_context_usage" })).await
}

#[tauri::command]
pub async fn mcp_status(hub: H<'_>, sid: String) -> Result<Option<serde_json::Value>, String> {
    hub.inner().clone().request(&sid, serde_json::json!({ "subtype": "mcp_status" })).await
}

#[tauri::command]
pub async fn mcp_toggle(hub: H<'_>, sid: String, name: String, enabled: bool) -> Result<(), String> {
    hub.inner().clone().request(&sid, serde_json::json!({ "subtype": "mcp_toggle", "serverName": name, "enabled": enabled })).await.map(|_| ())
}

#[tauri::command]
pub async fn mcp_reconnect(hub: H<'_>, sid: String, name: String) -> Result<(), String> {
    hub.inner().clone().request(&sid, serde_json::json!({ "subtype": "mcp_reconnect", "serverName": name })).await.map(|_| ())
}

// ---------------------------------------------------------------- dev servers

type S<'a> = State<'a, Arc<crate::servers::Servers>>;

#[tauri::command]
pub fn servers_list(servers: S<'_>, cwd: String) -> Vec<crate::servers::ServerInfo> {
    servers.list(&cwd)
}

#[tauri::command]
pub async fn server_start(servers: S<'_>, cwd: String, id: String) -> Result<crate::servers::ServerInfo, String> {
    servers.inner().clone().start(cwd, id).await
}

#[tauri::command]
pub fn server_stop(servers: S<'_>, key: String) {
    servers.inner().stop(&key);
}

#[tauri::command]
pub fn server_logs(servers: S<'_>, key: String) -> Vec<String> {
    servers.logs(&key)
}

// ---------------------------------------------------------------- built-in browser

type B<'a> = State<'a, crate::browser::Browser>;

#[tauri::command]
pub async fn browser_open(browser: B<'_>, url: String, x: f64, y: f64, w: f64, h: f64) -> Result<String, String> {
    browser.open(&url, x, y, w, h)
}

#[tauri::command]
pub fn browser_bounds(browser: B<'_>, x: f64, y: f64, w: f64, h: f64, visible: bool) {
    browser.bounds(x, y, w, h, visible);
}

#[tauri::command]
pub fn browser_nav(browser: B<'_>, action: String) -> Result<(), String> {
    browser.nav(&action)
}

#[tauri::command]
pub fn browser_close(browser: B<'_>) {
    browser.close();
}

#[tauri::command]
pub fn scratch_dir(hub: H<'_>) -> Result<String, String> {
    hub.scratch_dir()
}

#[tauri::command]
pub fn cli_defaults(cwd: Option<String>) -> crate::settings::CliDefaults {
    crate::settings::cli_defaults(cwd.as_deref())
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<crate::git::GitStatus, String> {
    crate::git::status(crate::shellenv::path().await, &cwd).await
}

#[tauri::command]
pub async fn git_diff(cwd: String, path: String) -> Result<crate::git::GitDiff, String> {
    crate::git::diff(crate::shellenv::path().await, &cwd, &path).await
}

#[tauri::command]
pub async fn git_discard(cwd: String, path: String) -> Result<(), String> {
    crate::git::discard(crate::shellenv::path().await, &cwd, &path, history::to_trash).await
}

/// Commands and skills the CLI knows in this folder (the composer's "/").
#[tauri::command]
pub async fn list_commands(hub: H<'_>, cwd: String) -> Result<serde_json::Value, String> {
    hub.commands(&cwd).await
}

/// Models of the installed CLI (its answer to `initialize`), asked without a session.
#[tauri::command]
pub async fn cli_models(hub: H<'_>, cwd: String) -> Result<serde_json::Value, String> {
    hub.models(&cwd).await
}

/// Files and folders suggested after "@".
#[tauri::command]
pub async fn mention_files(cwd: String, query: String, hidden: Option<bool>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::mentions::search(&cwd, &query, hidden.unwrap_or(false))).await.map_err(|e| e.to_string())
}

/// Clipboard through the system: depends neither on the web view's context nor on its permissions.
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or(tr("stdin unavailable", "stdin indisponible"))?;
    stdin.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(tr("pbcopy failed.", "pbcopy a échoué.").into())
    }
}

/// The UI is painted: the window can show without flashing a white background.
#[tauri::command]
pub fn app_ready(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- iOS simulator

type Sim<'a> = State<'a, Arc<crate::simulator::Simulator>>;

#[tauri::command]
pub async fn sim_devices() -> Result<Vec<crate::simulator::SimDevice>, String> {
    crate::simulator::devices().await
}

#[tauri::command]
pub async fn sim_boot(udid: String) -> Result<(), String> {
    crate::simulator::boot(&udid).await
}

#[tauri::command]
pub async fn sim_shutdown(sim: Sim<'_>, udid: String) -> Result<(), String> {
    sim.shutdown(&udid).await
}

#[tauri::command]
pub async fn sim_attach(sim: Sim<'_>, udid: String) -> Result<(), String> {
    sim.inner().attach_ui(udid).await
}

#[tauri::command]
pub fn sim_detach(sim: Sim<'_>) {
    sim.detach_ui();
}

/// The device shown by the panel: the one Claude uses by default.
#[tauri::command]
pub fn sim_select(sim: Sim<'_>, udid: Option<String>) {
    sim.select(udid);
}

/// Binary: a JPEG image, or nothing if the screen has not changed since.
#[tauri::command]
pub async fn sim_frame(sim: Sim<'_>) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(sim.next_frame().await))
}

#[tauri::command]
pub fn sim_input(sim: Sim<'_>, line: String) {
    sim.input(line);
}

#[tauri::command]
pub async fn sim_screenshot(sim: Sim<'_>, udid: String) -> Result<String, String> {
    sim.screenshot(&udid).await
}

#[tauri::command]
pub async fn sim_appearance(udid: String, value: Option<String>) -> Result<String, String> {
    crate::simulator::appearance(&udid, value.as_deref()).await
}

// ---------------------------------------------------------------- artifacts

type Art<'a> = State<'a, crate::artifacts::ArtifactView>;

/// `false`: the file is gone, the UI offers claude.ai.
#[tauri::command]
pub fn artifact_show(view: Art<'_>, path: String, w: f64, h: f64) -> Result<bool, String> {
    view.show(&path, w, h)
}

#[tauri::command]
pub fn artifact_bounds(view: Art<'_>, x: f64, y: f64, w: f64, h: f64, visible: bool) {
    view.bounds(x, y, w, h, visible);
}

#[tauri::command]
pub fn artifact_reload(view: Art<'_>) {
    view.reload();
}

#[tauri::command]
pub fn artifact_close(view: Art<'_>) {
    view.close();
}

/// Call only after the user has confirmed: the deletion is permanent.
#[tauri::command]
pub async fn artifact_delete(view: Art<'_>, url: String) -> Result<bool, String> {
    view.delete(&url).await
}

// ---------------------------------------------------------------- files attached by Claude

/// What the UI shows of attached files. Images become readable through the `asset` protocol,
/// one by one: only the files Claude showed get in, never a whole folder.
#[tauri::command]
pub fn attachments(app: tauri::AppHandle, cwd: String, paths: Vec<String>) -> Vec<crate::files_tool::Attachment> {
    use tauri::Manager;
    paths
        .iter()
        .take(20)
        .map(|p| {
            let a = crate::files_tool::describe(&cwd, p);
            if a.image {
                let _ = app.asset_protocol_scope().allow_file(&a.path);
            }
            a
        })
        .collect()
}

/// `false`: the file could run (script, shortcut, executable); the UI shows it in the Finder.
#[tauri::command]
pub fn open_attachment(path: String) -> Result<bool, String> {
    let path = std::path::PathBuf::from(path);
    if !crate::files_tool::safe_to_open(&path) {
        return Ok(false);
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---------------------------------------------------------------- "File" tab

/// A file to preview or edit. Images, PDFs and media become readable through the `asset`
/// protocol, that file only.
#[tauri::command]
pub async fn file_open(app: tauri::AppHandle, cwd: String, path: String) -> Result<crate::file_view::FileView, String> {
    use tauri::Manager;
    let view = tauri::async_runtime::spawn_blocking(move || crate::file_view::open(&cwd, &path)).await.map_err(|e| e.to_string())??;
    if view.text.is_none() && matches!(view.kind, "image" | "pdf" | "video" | "audio") {
        let _ = app.asset_protocol_scope().allow_file(&view.path);
    }
    Ok(view)
}

/// `"conflict"` as the error: the file changed on disk since `expected`.
#[tauri::command]
pub fn file_save(path: String, text: String, expected: Option<u64>) -> Result<u64, String> {
    crate::file_view::save(&path, &text, expected)
}

// ---------------------------------------------------------------- updates

type Up<'a> = State<'a, Arc<crate::updates::Updates>>;

#[tauri::command]
pub fn update_status(updates: Up<'_>) -> crate::updates::UpdateState {
    updates.state()
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, updates: Up<'_>) -> Result<crate::updates::UpdateState, String> {
    Ok(updates.check(&app).await)
}

/// Installs the downloaded version then restarts the app (claude processes are stopped cleanly).
#[tauri::command]
pub fn update_install(app: tauri::AppHandle, updates: Up<'_>) -> Result<(), String> {
    if updates.install()? {
        app.request_restart();
    }
    Ok(())
}

// ---------------------------------------------------------------- claude CLI updates

type CliUp<'a> = State<'a, Arc<crate::cli_updates::CliUpdates>>;

#[tauri::command]
pub fn cli_update_status(cli: CliUp<'_>) -> crate::cli_updates::CliUpdateState {
    cli.state()
}

/// Runs `claude update` now.
#[tauri::command]
pub async fn cli_update_check(app: tauri::AppHandle, cli: CliUp<'_>) -> Result<crate::cli_updates::CliUpdateState, String> {
    Ok(cli.check(&app).await)
}
