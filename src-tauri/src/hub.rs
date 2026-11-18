//! Gestion des sessions : un processus `claude` (stream-json) par session vivante.
//!
//! Optimisations par rapport à Claude Desktop :
//! - spawn paresseux : aucun processus tant qu'aucun message n'est envoyé ;
//! - au plus `max_live` processus vivants ; au-delà, ou après `idle_minutes`
//!   d'inactivité, une session est suspendue (processus arrêté, reprise
//!   transparente via `--resume`) ;
//! - kill du groupe de processus entier (CLI + serveurs MCP enfants) ;
//! - texte en streaming coalescé (≈25 envois/s max) et envoyé uniquement pour la
//!   session affichée quand la fenêtre est visible.

use crate::events::{McpStatus, SessionInfo, UiEvent};
use crate::protocol::{
    assistant_blocks, control_error, control_request, control_success, one_line, tool_result_text,
    truncate_middle, user_message, TOOL_RESULT_MAX,
};
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};

type Stdin = Arc<tokio::sync::Mutex<Option<ChildStdin>>>;

/// Période de coalescence du streaming : 20 rafraîchissements/s suffisent à l'œil.
const STREAM_FLUSH: Duration = Duration::from_millis(50);
const STDERR_LINES: usize = 40;
/// Liste des commandes : relue au plus toutes les 5 minutes, car il faut lancer le CLI pour l'obtenir.
const COMMANDS_TTL: Duration = Duration::from_secs(300);
const COMMANDS_TIMEOUT: Duration = Duration::from_secs(25);
const COMMAND_DESCRIPTION_MAX: usize = 400;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Proc {
    pid: u32,
    gen: u64,
    stdin: Stdin,
    exited: Arc<AtomicBool>,
}

struct PendingPerm {
    input: Value,
    suggestions: Option<Value>,
    tool_use_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    sid: String,
    cli_id: Option<String>,
    cwd: String,
    title: String,
    model: Option<String>,
    permission_mode: String,
    mcp: Option<Vec<String>>,
    #[serde(default)]
    effort: Option<String>,
    /// Modèle que Claude consulte aux moments clés (`--advisor`) ; None = pas de conseiller.
    #[serde(default)]
    advisor: Option<String>,
    /// Dernière vraie activité (message envoyé/reçu). Ouvrir une conversation ne la change pas.
    #[serde(default)]
    last_active_ms: u64,
}

struct Session {
    p: Persisted,
    title_auto: bool,
    proc: Option<Proc>,
    busy: bool,
    stopping: bool,
    last_active: Instant,
    last_active_ms: u64,
    perms: HashMap<String, PendingPerm>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    spawn_lock: Arc<tokio::sync::Mutex<()>>,
}

impl Session {
    fn new(mut p: Persisted, title_auto: bool) -> Self {
        if p.last_active_ms == 0 {
            p.last_active_ms = now_ms();
        }
        let last_active_ms = p.last_active_ms;
        Self {
            p,
            title_auto,
            proc: None,
            busy: false,
            stopping: false,
            last_active: Instant::now(),
            last_active_ms,
            perms: HashMap::new(),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            spawn_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn info(&self) -> SessionInfo {
        let state = match (&self.proc, self.busy) {
            (Some(_), true) => "busy",
            (Some(_), false) => "ready",
            (None, _) if self.p.cli_id.is_some() => "suspended",
            (None, _) => "idle",
        };
        SessionInfo {
            sid: self.p.sid.clone(),
            cli_id: self.p.cli_id.clone(),
            cwd: self.p.cwd.clone(),
            title: self.p.title.clone(),
            model: self.p.model.clone(),
            permission_mode: self.p.permission_mode.clone(),
            state: state.into(),
            pid: self.proc.as_ref().map(|p| p.pid),
            mcp_label: match &self.p.mcp {
                None => "tous".into(),
                Some(v) if v.is_empty() => "aucun".into(),
                Some(v) => v.join(", "),
            },
            effort: self.p.effort.clone(),
            advisor: self.p.advisor.clone(),
            last_active_ms: self.last_active_ms,
            pending_permissions: self.perms.len(),
        }
    }

    fn touch(&mut self) {
        self.last_active = Instant::now();
        self.last_active_ms = now_ms();
        self.p.last_active_ms = self.last_active_ms;
    }
}

#[derive(Default)]
struct StreamBuf {
    text: String,
    thinking: bool,
    sent: usize,
    scheduled: bool,
}

#[derive(Default)]
struct Out {
    channel: Option<Channel<UiEvent>>,
    focused: Option<String>,
    visible: bool,
    streams: HashMap<String, StreamBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpts {
    pub cwd: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// None = config MCP standard ; Some(liste) = uniquement ces serveurs.
    pub mcp: Option<Vec<String>>,
    pub resume: Option<String>,
    pub title: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub advisor: Option<String>,
}

/// Assez pour comprendre le sujet : le CLI n'a pas besoin d'un long collage entier pour nommer.
const TITLE_INPUT_MAX: usize = 2000;

pub struct Hub {
    app: AppHandle,
    sessions: Mutex<HashMap<String, Session>>,
    out: Mutex<Out>,
    pub settings: Mutex<Settings>,
    /// Identifiants des conversations archivées (transcripts intacts, masqués de la liste).
    archived: Mutex<BTreeSet<String>>,
    /// Commandes du CLI par dossier de travail, avec l'instant où elles ont été lues.
    commands: Mutex<HashMap<String, (Instant, Value)>>,
    config_dir: PathBuf,
    cache_dir: PathBuf,
    gen: AtomicU64,
    req: AtomicU64,
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
}

impl Hub {
    pub fn new(app: AppHandle, config_dir: PathBuf, cache_dir: PathBuf) -> Arc<Self> {
        let settings = Settings::load(&config_dir.join("settings.json"));
        let archived = std::fs::read(config_dir.join("archived.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Arc::new(Self {
            app,
            sessions: Mutex::new(HashMap::new()),
            out: Mutex::new(Out { visible: true, ..Default::default() }),
            settings: Mutex::new(settings),
            archived: Mutex::new(archived),
            commands: Mutex::new(HashMap::new()),
            config_dir,
            cache_dir,
            gen: AtomicU64::new(1),
            req: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        })
    }

    // ---------- persistance des sessions ouvertes ----------

    fn open_path(&self) -> PathBuf {
        self.config_dir.join("open-sessions.json")
    }

    /// Recharge les sessions ouvertes au dernier lancement (toutes suspendues).
    pub fn restore(&self) {
        let Ok(bytes) = std::fs::read(self.open_path()) else { return };
        let Ok(list) = serde_json::from_slice::<Vec<Persisted>>(&bytes) else { return };
        let mut map = self.sessions.lock().unwrap();
        for p in list {
            map.insert(p.sid.clone(), Session::new(p, false));
        }
    }

    fn persist(&self) {
        let list: Vec<Persisted> = self.sessions.lock().unwrap().values().map(|s| s.p.clone()).collect();
        let _ = std::fs::create_dir_all(&self.config_dir);
        let _ = std::fs::write(self.open_path(), serde_json::to_vec(&list).unwrap_or_default());
    }

    pub fn save_settings(&self, s: Settings) -> Result<(), String> {
        s.save(&self.config_dir.join("settings.json")).map_err(|e| e.to_string())?;
        *self.settings.lock().unwrap() = s;
        Ok(())
    }

    // ---------- sortie vers l'UI ----------

    pub fn set_channel(&self, ch: Channel<UiEvent>) {
        self.out.lock().unwrap().channel = Some(ch);
    }

    pub fn emit(&self, ev: UiEvent) {
        if let Some(ch) = &self.out.lock().unwrap().channel {
            let _ = ch.send(ev);
        }
    }

    fn emit_session(&self, sid: &str) {
        let info = self.sessions.lock().unwrap().get(sid).map(Session::info);
        if let Some(session) = info {
            self.emit(UiEvent::SessionUpdate { session });
        }
    }

    fn notice(&self, sid: Option<&str>, level: &str, text: impl Into<String>) {
        self.emit(UiEvent::Notice { sid: sid.map(str::to_string), level: level.into(), text: text.into() });
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut v: Vec<SessionInfo> = self.sessions.lock().unwrap().values().map(Session::info).collect();
        v.sort_by(|a, b| b.last_active_ms.cmp(&a.last_active_ms));
        v
    }

    pub fn live_pids(&self) -> Vec<(String, u32)> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(|s| s.proc.as_ref().map(|p| (s.p.sid.clone(), p.pid)))
            .collect()
    }

    // ---------- streaming coalescé ----------

    fn push_delta(self: &Arc<Self>, sid: &str, text: &str, thinking: bool) {
        let mut out = self.out.lock().unwrap();
        let live = out.visible && out.focused.as_deref() == Some(sid);
        let buf = out.streams.entry(sid.to_string()).or_default();
        if buf.thinking != thinking {
            buf.text.clear();
            buf.sent = 0;
            buf.thinking = thinking;
        }
        buf.text.push_str(text);
        if live && !buf.scheduled {
            buf.scheduled = true;
            let hub = self.clone();
            let sid = sid.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(STREAM_FLUSH).await;
                hub.flush(&sid);
            });
        }
    }

    fn flush(&self, sid: &str) {
        let mut out = self.out.lock().unwrap();
        let live = out.visible && out.focused.as_deref() == Some(sid);
        let Out { channel, streams, .. } = &mut *out;
        let Some(buf) = streams.get_mut(sid) else { return };
        buf.scheduled = false;
        if !live || buf.sent >= buf.text.len() {
            return;
        }
        let ev = UiEvent::Delta {
            sid: sid.to_string(),
            text: buf.text[buf.sent..].to_string(),
            thinking: buf.thinking,
            replace: buf.sent == 0,
        };
        buf.sent = buf.text.len();
        if let Some(ch) = channel {
            let _ = ch.send(ev);
        }
    }

    fn clear_stream(&self, sid: &str) {
        self.out.lock().unwrap().streams.remove(sid);
    }

    /// Renvoie tout le texte en cours de la session affichée (après changement de focus).
    fn resend_stream(self: &Arc<Self>) {
        let sid = {
            let mut out = self.out.lock().unwrap();
            let Some(sid) = out.focused.clone() else { return };
            if !out.visible {
                return;
            }
            match out.streams.get_mut(&sid) {
                Some(buf) if !buf.text.is_empty() => buf.sent = 0,
                _ => return,
            }
            sid
        };
        self.flush(&sid);
    }

    pub fn set_focus(self: &Arc<Self>, sid: Option<String>) {
        self.out.lock().unwrap().focused = sid;
        self.resend_stream();
    }

    pub fn set_visible(self: &Arc<Self>, visible: bool) {
        self.out.lock().unwrap().visible = visible;
        if visible {
            self.resend_stream();
        }
    }

    // ---------- cycle de vie ----------

    pub fn create(&self, o: CreateOpts) -> Result<SessionInfo, String> {
        let cwd = o.cwd.trim().trim_end_matches('/').to_string();
        let cwd = if cwd.is_empty() { "/".to_string() } else { cwd };
        if !std::path::Path::new(&cwd).is_dir() {
            return Err(format!("Dossier introuvable : {cwd}"));
        }
        let (model, mode, mcp, effort) = {
            let mut s = self.settings.lock().unwrap();
            s.remember_dir(&cwd);
            let _ = s.save(&self.config_dir.join("settings.json"));
            let mcp = match o.mcp {
                Some(v) => Some(v),
                None if s.mcp_mode == "selected" => Some(s.mcp_selected.clone()),
                None => None,
            };
            (
                o.model.filter(|m| !m.is_empty()).or_else(|| s.default_model.clone()),
                o.permission_mode.unwrap_or_else(|| s.default_permission_mode.clone()),
                mcp,
                o.effort.filter(|e| !e.is_empty()).or_else(|| s.default_effort.clone()),
            )
        };
        let sid = uuid::Uuid::new_v4().to_string();
        let title_auto = o.title.is_none();
        // Rouvrir une conversation ne doit pas la faire remonter : on garde la date du transcript.
        let last_active_ms = o.resume.as_deref().and_then(crate::history::mtime_ms).unwrap_or(0);
        let p = Persisted {
            sid: sid.clone(),
            cli_id: o.resume,
            cwd,
            title: o.title.unwrap_or_else(|| "Nouvelle session".into()),
            model,
            permission_mode: mode,
            mcp,
            effort,
            advisor: o.advisor.filter(|a| !a.is_empty()),
            last_active_ms,
        };
        let session = Session::new(p, title_auto);
        let info = session.info();
        self.sessions.lock().unwrap().insert(sid, session);
        self.persist();
        self.emit(UiEvent::SessionUpdate { session: info.clone() });
        Ok(info)
    }

    /// Retourne le stdin d'un processus vivant, en le lançant si besoin.
    async fn ensure_live(self: &Arc<Self>, sid: &str) -> Result<Stdin, String> {
        let lock = {
            let map = self.sessions.lock().unwrap();
            let s = map.get(sid).ok_or("Session inconnue")?;
            if let Some(p) = &s.proc {
                return Ok(p.stdin.clone());
            }
            s.spawn_lock.clone()
        };
        let _guard = lock.lock().await;
        if let Some(stdin) = self.sessions.lock().unwrap().get(sid).and_then(|s| s.proc.as_ref().map(|p| p.stdin.clone())) {
            return Ok(stdin);
        }

        // Limite de processus vivants : on suspend la session inactive la plus ancienne.
        let (max_live, partial, claude_path, all_tools) = {
            let s = self.settings.lock().unwrap();
            (s.max_live.max(1), s.partial_messages, s.claude_path.clone(), s.all_tools)
        };
        let victim = {
            let map = self.sessions.lock().unwrap();
            let live = map.values().filter(|s| s.proc.is_some()).count();
            if live >= max_live {
                map.values()
                    .filter(|s| s.proc.is_some() && !s.busy && s.perms.is_empty() && s.p.sid != sid)
                    .min_by_key(|s| s.last_active)
                    .map(|s| s.p.sid.clone())
            } else {
                None
            }
        };
        if let Some(v) = victim {
            self.suspend(&v, "limite de sessions actives");
        }

        let claude = crate::shellenv::resolve_claude(claude_path.as_deref())
            .await
            .ok_or("Binaire `claude` introuvable : indique son chemin dans les réglages.")?;
        let path_env = crate::shellenv::path().await;

        let p = self.sessions.lock().unwrap().get(sid).map(|s| s.p.clone()).ok_or("Session fermée")?;
        let mut cmd = Command::new(&claude);
        cmd.args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-prompt-tool",
            "stdio",
            "--permission-mode",
            &p.permission_mode,
        ]);
        if partial {
            cmd.arg("--include-partial-messages");
        }
        if !all_tools {
            cmd.arg("--disallowedTools").args(crate::settings::HEAVY_TOOLS);
        }
        if let Some(id) = &p.cli_id {
            cmd.args(["--resume", id]);
        }
        if let Some(m) = &p.model {
            cmd.args(["--model", m]);
        }
        if let Some(e) = &p.effort {
            cmd.args(["--effort", e]);
        }
        if let Some(a) = &p.advisor {
            cmd.args(["--advisor", a]);
        }
        if let Some(names) = &p.mcp {
            let file = self.cache_dir.join(format!("mcp-{sid}.json"));
            crate::mcp::write_config(&p.cwd, names, &file).map_err(|e| format!("Config MCP : {e}"))?;
            cmd.arg("--strict-mcp-config").arg("--mcp-config").arg(&file);
        }
        if crate::simulator::available() {
            cmd.arg("--mcp-config").arg(crate::simulator_tool::CONFIG);
        }
        cmd.arg("--mcp-config").arg(crate::files_tool::CONFIG);
        cmd.arg("--append-system-prompt").arg(crate::files_tool::PROMPT);
        cmd.current_dir(&p.cwd)
            .env("PATH", path_env)
            // En mode SDK, le CLI ne propose l'outil `Artifact` que si l'hôte le demande.
            .env("CLAUDE_CODE_ARTIFACT", "1")
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SSE_PORT")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);

        let mut child = cmd.spawn().map_err(|e| format!("Lancement de claude impossible : {e}"))?;
        let pid = child.id().unwrap_or(0);
        let gen = self.gen.fetch_add(1, Ordering::Relaxed);
        let stdin: Stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take()));
        let exited = Arc::new(AtomicBool::new(false));
        let stdout = child.stdout.take().ok_or("stdout indisponible")?;
        let stderr = child.stderr.take().ok_or("stderr indisponible")?;

        let stderr_ring = {
            let mut map = self.sessions.lock().unwrap();
            let s = map.get_mut(sid).ok_or("Session fermée")?;
            s.proc = Some(Proc { pid, gen, stdin: stdin.clone(), exited: exited.clone() });
            s.stopping = false;
            s.stderr.lock().unwrap().clear();
            s.stderr.clone()
        };

        let got_output = Arc::new(AtomicBool::new(false));
        let hub = self.clone();
        let sid_out = sid.to_string();
        let seen = got_output.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::with_capacity(64 * 1024, stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                seen.store(true, Ordering::Relaxed);
                protocol_log(&sid_out, "←", &line);
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    hub.handle_line(&sid_out, v);
                }
            }
        });
        // Chien de garde : un CLI muet 20 s après son lancement est signalé (sans être tué).
        let hub = self.clone();
        let sid_dog = sid.to_string();
        let exited_dog = exited.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(20)).await;
            if !got_output.load(Ordering::Relaxed) && !exited_dog.load(Ordering::SeqCst) {
                let tail = hub.stderr_tail(&sid_dog);
                hub.notice(
                    Some(&sid_dog),
                    "warn",
                    format!(
                        "Le CLI n'a rien envoyé depuis 20 s (pid {pid}). Si macOS affiche une demande d'accès \
                         (Documents, Bureau…) pour Better Harness, accepte-la : le processus attend cette réponse.{tail}"
                    ),
                );
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut r = stderr_ring.lock().unwrap();
                if r.len() >= STDERR_LINES {
                    r.pop_front();
                }
                r.push_back(line);
            }
        });
        let hub = self.clone();
        let sid_wait = sid.to_string();
        tauri::async_runtime::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code());
            exited.store(true, Ordering::SeqCst);
            hub.on_exit(&sid_wait, gen, code);
        });

        let init = control_request(&self.next_req(), json!({ "subtype": "initialize" }));
        write_line(&stdin, &init).await?;
        self.emit_session(sid);
        Ok(stdin)
    }

    fn stderr_tail(&self, sid: &str) -> String {
        let map = self.sessions.lock().unwrap();
        let Some(s) = map.get(sid) else { return String::new() };
        let tail: Vec<String> = s.stderr.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() {
            String::new()
        } else {
            format!("\n{}", tail.join("\n"))
        }
    }

    fn next_req(&self) -> String {
        format!("bh-{}", self.req.fetch_add(1, Ordering::Relaxed))
    }

    fn on_exit(&self, sid: &str, gen: u64, code: Option<i32>) {
        let mut done_perms = Vec::new();
        let report = {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(sid) else { return };
            match s.proc.as_ref().map(|p| p.gen) {
                // Ancien processus (suspendu puis remplacé) : l'état appartient au nouveau.
                Some(current) if current != gen => return,
                Some(_) => s.proc = None,
                None => {}
            }
            let was_busy = std::mem::take(&mut s.busy);
            done_perms.extend(s.perms.drain().map(|(k, _)| k));
            let expected = std::mem::take(&mut s.stopping);
            if !expected && (code != Some(0) || was_busy) {
                let tail: Vec<String> = s.stderr.lock().unwrap().iter().cloned().collect();
                Some(format!(
                    "Le processus claude s'est arrêté (code {}).{}",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
                    if tail.is_empty() { String::new() } else { format!("\n{}", tail.join("\n")) }
                ))
            } else {
                None
            }
        };
        for rid in done_perms {
            self.emit(UiEvent::PermissionDone { sid: sid.into(), request_id: rid });
        }
        if let Some(text) = report {
            self.notice(Some(sid), "error", text);
        }
        self.clear_stream(sid);
        self.emit_session(sid);
    }

    /// Arrête le processus d'une session (fermeture de stdin, puis SIGTERM/SIGKILL
    /// du groupe). La session reste ouverte et reprendra via --resume.
    pub fn suspend(&self, sid: &str, reason: &str) {
        let proc = {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(sid) else { return };
            let Some(p) = s.proc.take() else { return };
            s.stopping = true;
            s.busy = false;
            p
        };
        if !reason.is_empty() {
            self.notice(Some(sid), "info", format!("Processus suspendu ({reason}) ; reprise automatique au prochain message."));
        }
        tauri::async_runtime::spawn(stop_process(proc));
        self.emit_session(sid);
    }

    pub fn close(&self, sid: &str) {
        if let Some(proc) = self.remove_session(sid) {
            tauri::async_runtime::spawn(stop_process(proc));
        }
    }

    /// Retire la session et rend son processus, que l'appelant doit arrêter.
    fn remove_session(&self, sid: &str) -> Option<Proc> {
        let proc = self.sessions.lock().unwrap().remove(sid).and_then(|mut s| s.proc.take());
        let _ = std::fs::remove_file(self.cache_dir.join(format!("mcp-{sid}.json")));
        self.clear_stream(sid);
        self.persist();
        self.emit(UiEvent::SessionRemoved { sid: sid.into() });
        proc
    }

    /// Dossier des conversations lancées sans projet : le CLI a toujours besoin d'un dossier de travail.
    pub fn scratch_dir(&self) -> Result<String, String> {
        let dir = self.config_dir.join("sans-dossier");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.to_string_lossy().into_owned())
    }

    // ---------- commandes du CLI ----------

    fn remember_commands(&self, cwd: &str, commands: &Value) -> Value {
        let list: Vec<Value> = commands
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let name = c["name"].as_str()?;
                        let description = c["description"].as_str().map(|d| one_line(d, COMMAND_DESCRIPTION_MAX)).filter(|d| !d.is_empty());
                        Some(json!({ "name": name, "description": description }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let value = Value::Array(list);
        self.commands.lock().unwrap().insert(cwd.to_string(), (Instant::now(), value.clone()));
        value
    }

    /// Le CLI sait ce qu'il a chargé (skills de l'utilisateur, du projet, des plugins) : on le lui demande,
    /// sans lui envoyer de message. Une session vivante alimente aussi ce cache à son démarrage.
    pub async fn commands(&self, cwd: &str) -> Result<Value, String> {
        if let Some((at, value)) = self.commands.lock().unwrap().get(cwd) {
            if at.elapsed() < COMMANDS_TTL {
                return Ok(value.clone());
            }
        }
        if !std::path::Path::new(cwd).is_dir() {
            return Ok(json!([]));
        }
        let explicit = self.settings.lock().unwrap().claude_path.clone();
        let claude = crate::shellenv::resolve_claude(explicit.as_deref()).await.ok_or("CLI claude introuvable.")?;
        let mut cmd = Command::new(&claude);
        cmd.args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-prompt-tool",
            "stdio",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
        ])
        .current_dir(cwd)
        .env("PATH", crate::shellenv::path().await)
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .env_remove("CLAUDE_CODE_SSE_PORT")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
        let mut child = cmd.spawn().map_err(|e| format!("Lancement de claude impossible : {e}"))?;
        let pid = child.id().unwrap_or(0);
        let mut stdin = child.stdin.take().ok_or("stdin indisponible")?;
        let stdout = child.stdout.take().ok_or("stdout indisponible")?;
        let read = async {
            let request = json!({ "type": "control_request", "request_id": "commands", "request": { "subtype": "initialize" } });
            stdin.write_all(format!("{request}\n").as_bytes()).await.map_err(|e| e.to_string())?;
            let mut lines = BufReader::new(stdout).lines();
            while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["type"] == "control_response" && v["response"]["request_id"] == "commands" {
                    return Ok(v["response"]["response"]["commands"].clone());
                }
            }
            Err("Le CLI s'est arrêté sans répondre.".to_string())
        };
        let answer = tokio::time::timeout(COMMANDS_TIMEOUT, read).await;
        // Le processus ne servait qu'à ça, avec ses éventuels enfants.
        kill_group(pid, libc::SIGTERM);
        let commands = answer.map_err(|_| "Le CLI met trop de temps à répondre.".to_string())??;
        Ok(self.remember_commands(cwd, &commands))
    }

    // ---------- archives et suppression ----------

    fn sid_of(&self, cli_id: &str) -> Option<String> {
        let map = self.sessions.lock().unwrap();
        map.iter().find(|(_, s)| s.p.cli_id.as_deref() == Some(cli_id)).map(|(sid, _)| sid.clone())
    }

    pub fn archived(&self) -> HashSet<String> {
        self.archived.lock().unwrap().iter().cloned().collect()
    }

    /// Archive (en fermant la session ouverte dessus) ou restaure une conversation.
    pub fn set_archived(&self, cli_id: &str, on: bool) -> Result<(), String> {
        let ids = {
            let mut set = self.archived.lock().unwrap();
            if on {
                set.insert(cli_id.to_string());
            } else {
                set.remove(cli_id);
            }
            set.clone()
        };
        let path = self.config_dir.join("archived.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::create_dir_all(&self.config_dir)
            .and_then(|_| std::fs::write(&tmp, serde_json::to_vec_pretty(&ids).unwrap_or_default()))
            .and_then(|_| std::fs::rename(&tmp, &path))
            .map_err(|e| e.to_string())?;
        if on {
            if let Some(sid) = self.sid_of(cli_id) {
                self.close(&sid);
            }
        }
        Ok(())
    }

    /// Met une conversation à la corbeille. Son processus est d'abord arrêté pour de bon :
    /// sinon sa dernière écriture recréerait le transcript.
    pub async fn delete_conversation(&self, cli_id: &str) -> Result<(), String> {
        if let Some(sid) = self.sid_of(cli_id) {
            if let Some(proc) = self.remove_session(&sid) {
                stop_process(proc).await;
            }
        }
        let id = cli_id.to_string();
        tauri::async_runtime::spawn_blocking(move || crate::history::trash(&id)).await.map_err(|e| e.to_string())??;
        self.set_archived(cli_id, false)
    }

    /// Fermeture de l'app : on tue tous les groupes de processus immédiatement.
    pub fn shutdown_all(&self) {
        let map = self.sessions.lock().unwrap();
        for s in map.values() {
            if let Some(p) = &s.proc {
                kill_group(p.pid, libc::SIGTERM);
            }
        }
    }

    pub async fn supervise(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            let idle = self.settings.lock().unwrap().idle_minutes;
            if idle == 0 {
                continue;
            }
            let limit = Duration::from_secs(idle * 60);
            let victims: Vec<String> = self
                .sessions
                .lock()
                .unwrap()
                .values()
                .filter(|s| s.proc.is_some() && !s.busy && s.perms.is_empty() && s.last_active.elapsed() > limit)
                .map(|s| s.p.sid.clone())
                .collect();
            for v in victims {
                self.suspend(&v, "inactivité");
            }
        }
    }

    // ---------- actions ----------

    pub async fn send(self: &Arc<Self>, sid: &str, text: String) -> Result<(), String> {
        let stdin = self.ensure_live(sid).await?;
        let first_message = {
            let mut map = self.sessions.lock().unwrap();
            let s = map.get_mut(sid).ok_or("Session fermée")?;
            s.busy = true;
            s.touch();
            let first = s.title_auto;
            if first {
                s.title_auto = false;
                s.p.title = one_line(&text, 60);
            }
            first
        };
        self.persist();
        self.emit_session(sid);
        write_line(&stdin, &user_message(&text)).await?;
        if first_message {
            self.name_session(sid, &text);
        }
        Ok(())
    }

    /// Le CLI résume le premier message en un titre court et l'écrit dans son transcript : il restera à la
    /// réouverture. En cas d'échec, la conversation garde le début du message comme titre.
    fn name_session(self: &Arc<Self>, sid: &str, first_message: &str) {
        let hub = self.clone();
        let sid = sid.to_string();
        let description: String = first_message.chars().take(TITLE_INPUT_MAX).collect();
        tauri::async_runtime::spawn(async move {
            let request = json!({ "subtype": "generate_session_title", "description": description, "persist": true });
            let Ok(Some(response)) = hub.request(&sid, request).await else { return };
            let Some(title) = response["title"].as_str().map(str::trim).filter(|t| !t.is_empty()) else { return };
            match hub.sessions.lock().unwrap().get_mut(&sid) {
                Some(session) => session.p.title = one_line(title, 80),
                None => return,
            }
            hub.persist();
            hub.emit_session(&sid);
        });
    }

    async fn control(self: &Arc<Self>, sid: &str, request: Value) -> Result<(), String> {
        let stdin = {
            let map = self.sessions.lock().unwrap();
            map.get(sid).and_then(|s| s.proc.as_ref().map(|p| p.stdin.clone()))
        };
        match stdin {
            Some(stdin) => write_line(&stdin, &control_request(&self.next_req(), request)).await,
            None => Ok(()),
        }
    }

    /// Requête de contrôle dont on attend la réponse (contexte, état MCP…).
    /// Renvoie `None` si aucun processus ne tourne pour cette session.
    pub async fn request(self: &Arc<Self>, sid: &str, request: Value) -> Result<Option<Value>, String> {
        let stdin = {
            let map = self.sessions.lock().unwrap();
            map.get(sid).and_then(|s| s.proc.as_ref().map(|p| p.stdin.clone()))
        };
        let Some(stdin) = stdin else { return Ok(None) };
        let id = self.next_req();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(e) = write_line(&stdin, &control_request(&id, request)).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(Ok(v))) => Ok(Some(v)),
            Ok(Ok(Err(e))) => Err(e),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err("Le CLI n'a pas répondu.".into())
            }
        }
    }

    pub async fn set_effort(self: &Arc<Self>, sid: &str, effort: Option<String>) -> Result<(), String> {
        let effort = effort.filter(|e| !e.is_empty());
        if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
            s.p.effort = effort.clone();
        }
        self.persist();
        self.emit_session(sid);
        // Même mécanisme que Claude Desktop : réglage appliqué à chaud, sans relancer le CLI.
        self.control(sid, json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": effort } })).await
    }

    /// Conseiller appliqué à chaud (vérifié sur le CLI 2.1.319 : `/advisor` reflète le changement
    /// sans relance ni consommation) ; `--advisor` le reprend au prochain lancement.
    pub async fn set_advisor(self: &Arc<Self>, sid: &str, advisor: Option<String>) -> Result<(), String> {
        let advisor = advisor.filter(|a| !a.is_empty());
        if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
            s.p.advisor = advisor.clone();
        }
        self.persist();
        self.emit_session(sid);
        self.control(sid, json!({ "subtype": "apply_flag_settings", "settings": { "advisorModel": advisor } })).await
    }

    pub async fn interrupt(self: &Arc<Self>, sid: &str) -> Result<(), String> {
        self.control(sid, json!({ "subtype": "interrupt" })).await
    }

    pub async fn set_permission_mode(self: &Arc<Self>, sid: &str, mode: String) -> Result<(), String> {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
            s.p.permission_mode = mode.clone();
        }
        self.persist();
        self.emit_session(sid);
        self.control(sid, json!({ "subtype": "set_permission_mode", "mode": mode })).await
    }

    pub async fn set_model(self: &Arc<Self>, sid: &str, model: Option<String>) -> Result<(), String> {
        let model = model.filter(|m| !m.is_empty());
        if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
            s.p.model = model.clone();
        }
        self.persist();
        self.emit_session(sid);
        self.control(sid, json!({ "subtype": "set_model", "model": model })).await
    }

    pub async fn respond_permission(
        self: &Arc<Self>,
        sid: &str,
        request_id: &str,
        decision: &str,
        message: Option<String>,
        answers: Option<Value>,
    ) -> Result<(), String> {
        let (mut perm, stdin) = {
            let mut map = self.sessions.lock().unwrap();
            let s = map.get_mut(sid).ok_or("Session fermée")?;
            s.touch();
            let perm = s.perms.remove(request_id).ok_or("Demande déjà traitée")?;
            (perm, s.proc.as_ref().map(|p| p.stdin.clone()).ok_or("Processus arrêté")?)
        };
        // Réponses à `AskUserQuestion` : le CLI les lit dans l'entrée de l'outil.
        if let Some(a) = answers {
            perm.input["answers"] = a;
        }
        let mut resp = match decision {
            "deny" => json!({
                "behavior": "deny",
                "message": message.unwrap_or_else(|| "L'utilisateur a refusé cette action.".into()),
            }),
            _ => json!({ "behavior": "allow", "updatedInput": perm.input }),
        };
        if decision == "always" {
            if let Some(sug) = perm.suggestions {
                resp["updatedPermissions"] = sug;
            }
        }
        if let Some(id) = perm.tool_use_id {
            resp["toolUseID"] = json!(id);
        }
        self.emit(UiEvent::PermissionDone { sid: sid.into(), request_id: request_id.into() });
        self.emit_session(sid);
        write_line(&stdin, &control_success(request_id, resp)).await
    }

    // ---------- protocole entrant ----------

    fn reply_async(self: &Arc<Self>, sid: &str, msg: Value) {
        let stdin = {
            let map = self.sessions.lock().unwrap();
            map.get(sid).and_then(|s| s.proc.as_ref().map(|p| p.stdin.clone()))
        };
        if let Some(stdin) = stdin {
            tauri::async_runtime::spawn(async move {
                let _ = write_line(&stdin, &msg).await;
            });
        }
    }

    fn handle_line(self: &Arc<Self>, sid: &str, v: Value) {
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        let parent = v.get("parent_tool_use_id").and_then(Value::as_str).map(str::to_string);
        match ty {
            "stream_event" => {
                if parent.is_some() {
                    return;
                }
                let ev = &v["event"];
                if ev["type"] == "content_block_delta" {
                    let d = &ev["delta"];
                    match d["type"].as_str() {
                        Some("text_delta") => self.push_delta(sid, d["text"].as_str().unwrap_or(""), false),
                        Some("thinking_delta") => self.push_delta(sid, d["thinking"].as_str().unwrap_or(""), true),
                        _ => {}
                    }
                }
            }
            "assistant" => {
                let msg = &v["message"];
                if parent.is_none() {
                    self.clear_stream(sid);
                }
                let blocks = assistant_blocks(&msg["content"]);
                if !blocks.is_empty() {
                    self.emit(UiEvent::Assistant {
                        sid: sid.into(),
                        id: msg["id"].as_str().unwrap_or("").into(),
                        parent,
                        blocks,
                    });
                }
            }
            "user" => {
                let Some(arr) = v["message"]["content"].as_array() else { return };
                let artifact = crate::protocol::artifact_ref(v.get("tool_use_result"));
                for b in arr {
                    if b["type"] != "tool_result" {
                        continue;
                    }
                    let raw = tool_result_text(&b["content"]);
                    let (text, truncated) = truncate_middle(&raw, TOOL_RESULT_MAX);
                    self.emit(UiEvent::ToolResult {
                        sid: sid.into(),
                        tool_use_id: b["tool_use_id"].as_str().unwrap_or("").into(),
                        parent: parent.clone(),
                        is_error: b["is_error"].as_bool().unwrap_or(false),
                        text,
                        truncated,
                        artifact: artifact.clone(),
                    });
                }
            }
            "result" => {
                if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
                    s.busy = false;
                    s.touch();
                }
                self.clear_stream(sid);
                let u = &v["usage"];
                let tokens_in = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                    .iter()
                    .map(|k| u[k].as_u64().unwrap_or(0))
                    .sum();
                self.emit(UiEvent::Result {
                    sid: sid.into(),
                    is_error: v["is_error"].as_bool().unwrap_or(false),
                    subtype: v["subtype"].as_str().unwrap_or("").into(),
                    text: v["result"].as_str().map(str::to_string),
                    duration_ms: v["duration_ms"].as_u64().unwrap_or(0),
                    cost_usd: v["total_cost_usd"].as_f64().unwrap_or(0.0),
                    turns: v["num_turns"].as_u64().unwrap_or(0),
                    input_tokens: tokens_in,
                    output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                });
                self.persist();
                self.emit_session(sid);
            }
            "system" => match v["subtype"].as_str().unwrap_or("") {
                "init" => {
                    let cli_id = v["session_id"].as_str().map(str::to_string);
                    let model = v["model"].as_str().unwrap_or("").to_string();
                    let changed = {
                        let mut map = self.sessions.lock().unwrap();
                        match map.get_mut(sid) {
                            Some(s) if s.p.cli_id != cli_id && cli_id.is_some() => {
                                s.p.cli_id = cli_id;
                                true
                            }
                            _ => false,
                        }
                    };
                    if changed {
                        self.persist();
                    }
                    let mcp = v["mcp_servers"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .map(|m| McpStatus {
                                    name: m["name"].as_str().unwrap_or("").into(),
                                    status: m["status"].as_str().unwrap_or("").into(),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let tools = v["tools"].as_array().map(Vec::len).unwrap_or(0);
                    self.emit(UiEvent::Init { sid: sid.into(), model, tools, mcp });
                    self.emit_session(sid);
                }
                "status" => self.emit(UiEvent::Status {
                    sid: sid.into(),
                    status: v["status"].as_str().map(str::to_string),
                }),
                "compact_boundary" => self.notice(Some(sid), "info", "Contexte compacté par le CLI."),
                "api_retry" | "api_error" => self.notice(
                    Some(sid),
                    "warn",
                    format!("Erreur API, nouvelle tentative : {}", one_line(&v.to_string(), 200)),
                ),
                _ => {}
            },
            "control_request" => {
                let rid = v["request_id"].as_str().unwrap_or("").to_string();
                let req = &v["request"];
                if req["subtype"] == "can_use_tool" {
                    let tool_name = req["tool_name"].as_str().unwrap_or("?").to_string();
                    let input = req["input"].clone();
                    // Montrer un fichier dans la conversation ne change rien et n'apprend rien au modèle : pas de demande.
                    if tool_name == crate::files_tool::TOOL {
                        let mut resp = json!({ "behavior": "allow", "updatedInput": input });
                        if let Some(id) = req["tool_use_id"].as_str() {
                            resp["toolUseID"] = json!(id);
                        }
                        self.reply_async(sid, control_success(&rid, resp));
                        return;
                    }
                    let suggestions = req.get("permission_suggestions").filter(|s| s.as_array().is_some_and(|a| !a.is_empty())).cloned();
                    let shown = match (tool_name.as_str(), input["command"].as_str()) {
                        ("Bash", Some(c)) => c.to_string(),
                        _ => serde_json::to_string_pretty(&input).unwrap_or_default(),
                    };
                    let shown = truncate_middle(&shown, crate::protocol::tool_input_max(&tool_name)).0;
                    let ev = UiEvent::Permission {
                        sid: sid.into(),
                        request_id: rid.clone(),
                        tool_name,
                        title: req["title"].as_str().map(str::to_string),
                        description: req["description"]
                            .as_str()
                            .or(req["decision_reason"].as_str())
                            .map(str::to_string),
                        input: shown,
                        can_always: suggestions.is_some(),
                    };
                    if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
                        s.perms.insert(
                            rid,
                            PendingPerm {
                                input,
                                suggestions,
                                tool_use_id: req["tool_use_id"].as_str().map(str::to_string),
                            },
                        );
                    }
                    self.emit(ev);
                    self.emit_session(sid);
                    self.request_attention();
                } else if req["subtype"] == "mcp_message" && req["server_name"] == crate::simulator_tool::SERVER {
                    let hub = self.clone();
                    let sid = sid.to_string();
                    let message = req["message"].clone();
                    tauri::async_runtime::spawn(async move {
                        let Some(simulator) = hub.app.try_state::<Arc<crate::simulator::Simulator>>().map(|s| s.inner().clone()) else {
                            hub.reply_async(&sid, control_error(&rid, "simulateur indisponible"));
                            return;
                        };
                        let response = crate::simulator_tool::handle(&simulator, &message).await;
                        hub.reply_async(&sid, control_success(&rid, json!({ "mcp_response": response })));
                    });
                } else if req["subtype"] == "mcp_message" && req["server_name"] == crate::files_tool::SERVER {
                    let cwd = self.sessions.lock().unwrap().get(sid).map(|s| s.p.cwd.clone()).unwrap_or_default();
                    let response = crate::files_tool::handle(&cwd, &req["message"]);
                    self.reply_async(sid, control_success(&rid, json!({ "mcp_response": response })));
                } else {
                    // hook_callback, mcp_message (autres serveurs), elicitation… non pris en charge :
                    // on répond une erreur pour ne jamais bloquer le CLI.
                    self.reply_async(sid, control_error(&rid, "non pris en charge par better-harness"));
                }
            }
            "control_response" => {
                let r = &v["response"];
                let rid = r["request_id"].as_str().unwrap_or("");
                let waiter = self.pending.lock().unwrap().remove(rid);
                if let Some(tx) = waiter {
                    let out = if r["subtype"] == "error" {
                        Err(r["error"].as_str().unwrap_or("erreur du CLI").to_string())
                    } else {
                        Ok(r["response"].clone())
                    };
                    let _ = tx.send(out);
                } else if r["response"].get("models").is_some() {
                    // Réponse à `initialize` : vraie liste des modèles et niveaux d'effort.
                    let cwd = self.sessions.lock().unwrap().get(sid).map(|s| s.p.cwd.clone());
                    if let (Some(cwd), true) = (cwd, r["response"]["commands"].is_array()) {
                        self.remember_commands(&cwd, &r["response"]["commands"]);
                    }
                    self.emit(UiEvent::Capabilities {
                        sid: sid.into(),
                        models: r["response"]["models"].clone(),
                        plan: r["response"]["account"]["subscriptionType"].as_str().map(str::to_string),
                    });
                }
            }
            "control_cancel_request" => {
                let rid = v["request_id"].as_str().unwrap_or("").to_string();
                if let Some(s) = self.sessions.lock().unwrap().get_mut(sid) {
                    s.perms.remove(&rid);
                }
                self.emit(UiEvent::PermissionDone { sid: sid.into(), request_id: rid });
                self.emit_session(sid);
            }
            "rate_limit_event" => {
                let i = &v["rate_limit_info"];
                self.emit(UiEvent::RateLimit {
                    sid: sid.into(),
                    status: i["status"].as_str().unwrap_or("").into(),
                    resets_at: i["resetsAt"].as_i64(),
                    window: i["rateLimitType"].as_str().map(str::to_string),
                    windows: Some(i["unifiedWindows"].clone()).filter(Value::is_object),
                });
            }
            _ => {}
        }
    }

    fn request_attention(&self) {
        let visible = self.out.lock().unwrap().visible;
        if let Some(w) = self.app.get_webview_window("main") {
            if !visible || !w.is_focused().unwrap_or(true) {
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    }
}

/// Journal du protocole, activé par la variable d'environnement BH_PROTOCOL_LOG=<fichier>
/// (lancer alors le binaire directement : `…/Better Harness.app/Contents/MacOS/better-harness`).
fn protocol_log(sid: &str, dir: &str, line: &str) {
    static PATH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    let Some(path) = PATH.get_or_init(|| std::env::var_os("BH_PROTOCOL_LOG").map(PathBuf::from)) else { return };
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let short = &sid[..sid.len().min(8)];
        let _ = writeln!(f, "{} {short} {dir} {}", now_ms(), crate::protocol::one_line(line, 2000));
    }
}

async fn write_line(stdin: &Stdin, v: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    protocol_log("-", "→", &String::from_utf8_lossy(&line));
    line.push(b'\n');
    let mut g = stdin.lock().await;
    let w = g.as_mut().ok_or("Processus arrêté")?;
    w.write_all(&line).await.map_err(|e| format!("Écriture vers claude impossible : {e}"))?;
    w.flush().await.map_err(|e| e.to_string())
}

fn kill_group(pid: u32, sig: i32) {
    if pid > 1 {
        // pgid == pid grâce à process_group(0) : tue aussi les serveurs MCP enfants.
        unsafe {
            libc::kill(-(pid as i32), sig);
        }
    }
}

async fn stop_process(p: Proc) {
    // 1. Fermer stdin : le CLI termine proprement (transcript écrit sur disque).
    p.stdin.lock().await.take();
    for (wait, sig) in [(Duration::from_secs(4), libc::SIGTERM), (Duration::from_secs(2), libc::SIGKILL)] {
        let deadline = tokio::time::Instant::now() + wait;
        while !p.exited.load(Ordering::SeqCst) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if p.exited.load(Ordering::SeqCst) {
            // Le CLI est sorti ; on nettoie d'éventuels enfants MCP orphelins du groupe.
            kill_group(p.pid, libc::SIGTERM);
            return;
        }
        kill_group(p.pid, sig);
    }
}
