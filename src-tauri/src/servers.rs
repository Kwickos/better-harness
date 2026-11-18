//! A project's dev servers: `.claude/launch.json` (same format as
//! Claude Desktop) and the usual `package.json` scripts. Each server runs in
//! its own process group; logs are kept in memory (500 lines)
//! and sent to the UI in batches, the local URL is detected in the output.

use crate::events::UiEvent;
use crate::hub::Hub;
use crate::i18n::tr;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const LOG_LINES: usize = 500;
const FLUSH: Duration = Duration::from_millis(250);
const SCRIPTS: [&str; 6] = ["dev", "start", "serve", "preview", "watch", "storybook"];

#[derive(Clone)]
struct ServerDef {
    id: String,
    name: String,
    command: String,
    args: Vec<String>,
    url: Option<String>,
    cwd: PathBuf,
    source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub key: String,
    pub cwd: String,
    pub id: String,
    pub name: String,
    pub command: String,
    pub source: String,
    /// stopped | running | crashed
    pub state: String,
    pub url: Option<String>,
    pub pid: Option<u32>,
}

struct Running {
    def: ServerDef,
    state: String,
    url: Option<String>,
    pid: Option<u32>,
    logs: VecDeque<String>,
    batch: Vec<String>,
    scheduled: bool,
    stopping: bool,
}

pub struct Servers {
    hub: Arc<Hub>,
    map: Mutex<HashMap<String, Running>>,
}

fn key_of(cwd: &str, id: &str) -> String {
    format!("{cwd}#{id}")
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// Definitions found in the project, in order: launch.json then package.json.
fn definitions(cwd: &str) -> Vec<ServerDef> {
    let root = Path::new(cwd);
    let mut out = Vec::new();
    if let Some(cfg) = read_json(&root.join(".claude/launch.json")) {
        for c in cfg["configurations"].as_array().into_iter().flatten() {
            let Some(name) = c["name"].as_str() else { continue };
            let Some(cmd) = c["runtimeExecutable"].as_str() else { continue };
            let args: Vec<String> = c["runtimeArgs"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
            let url = c["url"]
                .as_str()
                .map(str::to_string)
                .or_else(|| c["port"].as_u64().map(|p| format!("http://localhost:{p}")));
            let dir = c["cwd"].as_str().map(|d| root.join(d)).unwrap_or_else(|| root.to_path_buf());
            out.push(ServerDef { id: format!("launch:{name}"), name: name.into(), command: cmd.into(), args, url, cwd: dir, source: "launch.json".into() });
        }
    }
    if let Some(pkg) = read_json(&root.join("package.json")) {
        let pm = if root.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if root.join("yarn.lock").exists() {
            "yarn"
        } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
            "bun"
        } else {
            "npm"
        };
        for s in SCRIPTS {
            if pkg["scripts"][s].is_string() && !out.iter().any(|d| d.args.last().map(String::as_str) == Some(s)) {
                out.push(ServerDef {
                    id: format!("script:{s}"),
                    name: s.into(),
                    command: pm.into(),
                    args: vec!["run".into(), s.into()],
                    url: None,
                    cwd: root.to_path_buf(),
                    source: "package.json".into(),
                });
            }
        }
    }
    out
}

/// Spots a local URL in a log line ("Local: http://localhost:5173/").
fn find_local_url(line: &str) -> Option<String> {
    for host in ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"] {
        for scheme in ["http", "https"] {
            let pat = format!("{scheme}://{host}:");
            if let Some(i) = line.find(&pat) {
                let digits: String = line[i + pat.len()..].chars().take_while(char::is_ascii_digit).collect();
                if !digits.is_empty() {
                    return Some(format!("{scheme}://localhost:{digits}"));
                }
            }
        }
    }
    None
}

/// Strips ANSI sequences (colors, erasures) from logs.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn kill_group(pid: u32, sig: i32) {
    if pid > 1 {
        unsafe {
            libc::kill(-(pid as i32), sig);
        }
    }
}

impl Servers {
    pub fn new(hub: Arc<Hub>) -> Arc<Self> {
        Arc::new(Self { hub, map: Mutex::new(HashMap::new()) })
    }

    fn info(cwd: &str, def: &ServerDef, run: Option<&Running>) -> ServerInfo {
        ServerInfo {
            key: key_of(cwd, &def.id),
            cwd: cwd.into(),
            id: def.id.clone(),
            name: def.name.clone(),
            command: format!("{} {}", def.command, def.args.join(" ")).trim().to_string(),
            source: def.source.clone(),
            state: run.map(|r| r.state.clone()).unwrap_or_else(|| "stopped".into()),
            url: run.and_then(|r| r.url.clone()).or_else(|| def.url.clone()),
            pid: run.and_then(|r| r.pid),
        }
    }

    pub fn list(&self, cwd: &str) -> Vec<ServerInfo> {
        let map = self.map.lock().unwrap();
        definitions(cwd).iter().map(|d| Self::info(cwd, d, map.get(&key_of(cwd, &d.id)))).collect()
    }

    fn emit_info(&self, key: &str) {
        let info = {
            let map = self.map.lock().unwrap();
            map.get(key).map(|r| {
                let cwd = key.rsplit_once('#').map(|(c, _)| c).unwrap_or("");
                Self::info(cwd, &r.def, Some(r))
            })
        };
        if let Some(server) = info {
            self.hub.emit(UiEvent::Server { server });
        }
    }

    pub async fn start(self: &Arc<Self>, cwd: String, id: String) -> Result<ServerInfo, String> {
        let def = definitions(&cwd).into_iter().find(|d| d.id == id).ok_or(tr("Server not found in this project.", "Serveur introuvable dans ce projet."))?;
        let key = key_of(&cwd, &id);
        if self.map.lock().unwrap().get(&key).is_some_and(|r| r.pid.is_some()) {
            return Ok(Self::info(&cwd, &def, self.map.lock().unwrap().get(&key)));
        }
        let mut cmd = Command::new(&def.command);
        cmd.args(&def.args)
            .current_dir(&def.cwd)
            .env("PATH", crate::shellenv::path().await)
            .env("BROWSER", "none")
            .env("FORCE_COLOR", "0")
            // Without this, Python (Django, Flask, http.server…) buffers its logs.
            .env("PYTHONUNBUFFERED", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| tr(format!("Could not start \"{}\": {e}", def.command), format!("Lancement de « {} » impossible : {e}", def.command)))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut map = self.map.lock().unwrap();
            let logs = map.remove(&key).map(|r| r.logs).unwrap_or_default();
            map.insert(
                key.clone(),
                Running { url: def.url.clone(), def: def.clone(), state: "running".into(), pid, logs, batch: vec![], scheduled: false, stopping: false },
            );
        }
        self.push_line(&key, format!("$ {} {}", def.command, def.args.join(" ")));
        for stream in [stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)].into_iter().flatten() {
            let me = self.clone();
            let k = key.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    me.push_line(&k, strip_ansi(&l));
                }
            });
        }
        let me = self.clone();
        let k = key.clone();
        tauri::async_runtime::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code());
            {
                let mut map = me.map.lock().unwrap();
                if let Some(r) = map.get_mut(&k) {
                    r.pid = None;
                    r.state = if r.stopping || code == Some(0) { "stopped".into() } else { "crashed".into() };
                }
            }
            let code = code.map(|c| format!(" (code {c})")).unwrap_or_default();
            me.push_line(&k, tr(format!("— stopped{code}"), format!("— arrêté{code}")));
            me.emit_info(&k);
        });
        self.emit_info(&key);
        let map = self.map.lock().unwrap();
        Ok(Self::info(&cwd, &def, map.get(&key)))
    }

    fn push_line(self: &Arc<Self>, key: &str, line: String) {
        let mut url_found = false;
        let schedule = {
            let mut map = self.map.lock().unwrap();
            let Some(r) = map.get_mut(key) else { return };
            if r.url.is_none() {
                if let Some(u) = find_local_url(&line) {
                    r.url = Some(u);
                    url_found = true;
                }
            }
            if r.logs.len() >= LOG_LINES {
                r.logs.pop_front();
            }
            r.logs.push_back(line.clone());
            r.batch.push(line);
            !std::mem::replace(&mut r.scheduled, true)
        };
        if url_found {
            self.emit_info(key);
        }
        if schedule {
            let me = self.clone();
            let k = key.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(FLUSH).await;
                let lines = {
                    let mut map = me.map.lock().unwrap();
                    let Some(r) = map.get_mut(&k) else { return };
                    r.scheduled = false;
                    std::mem::take(&mut r.batch)
                };
                if !lines.is_empty() {
                    me.hub.emit(UiEvent::ServerLog { key: k, lines });
                }
            });
        }
    }

    pub fn stop(self: &Arc<Self>, key: &str) {
        let pid = {
            let mut map = self.map.lock().unwrap();
            let Some(r) = map.get_mut(key) else { return };
            r.stopping = true;
            r.pid
        };
        if let Some(pid) = pid {
            kill_group(pid, libc::SIGTERM);
            let me = self.clone();
            let k = key.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                if me.map.lock().unwrap().get(&k).is_some_and(|r| r.pid == Some(pid)) {
                    kill_group(pid, libc::SIGKILL);
                }
            });
        }
    }

    pub fn logs(&self, key: &str) -> Vec<String> {
        self.map.lock().unwrap().get(key).map(|r| r.logs.iter().cloned().collect()).unwrap_or_default()
    }

    pub fn shutdown_all(&self) {
        for r in self.map.lock().unwrap().values() {
            if let Some(pid) = r.pid {
                kill_group(pid, libc::SIGTERM);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_vite_url() {
        assert_eq!(find_local_url("  ➜  Local:   http://localhost:5173/").as_deref(), Some("http://localhost:5173"));
        assert_eq!(find_local_url("ready on http://0.0.0.0:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(find_local_url("no url here"), None);
    }

    #[test]
    fn strips_colors() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m\r"), "ok");
    }
}
