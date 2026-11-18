//! Simulateurs iOS : liste, démarrage et réglages par `simctl` ; écran et touches par le
//! pont `sim-bridge`. Le pont ne tourne que pendant que l'onglet est affiché ou que Claude
//! s'en sert, et seule la dernière image est gardée : l'interface peut prendre du retard
//! sans que rien ne s'empile.

use crate::events::UiEvent;
use crate::hub::Hub;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;

const XCRUN: &str = "/usr/bin/xcrun";
const MAX_PACKET: usize = 64 * 1024 * 1024;
const FRAMES_PER_SECOND: &str = "30";
/// Au-delà, la prochaine demande d'image repart de zéro : l'interface n'attend jamais indéfiniment.
const FRAME_WAIT: Duration = Duration::from_secs(1);
const CAPTURE_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// Le pont reste branché ce temps après la dernière action de Claude, sans onglet ouvert.
const AGENT_HOLD: Duration = Duration::from_secs(30);
/// Un appareil qui démarre peut mettre un moment à avoir une image.
const FIRST_FRAME: Duration = Duration::from_secs(20);
const SETTLE_QUIET: Duration = Duration::from_millis(300);
const SETTLE_MAX: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimDevice {
    pub udid: String,
    pub name: String,
    /// `Booted`, `Shutdown`, `Booting`…
    pub state: String,
    /// « iOS 27.0 »
    pub runtime: String,
}

struct Stream {
    id: u64,
    udid: String,
    input: mpsc::UnboundedSender<String>,
    /// Le processus meurt quand ce canal se ferme.
    _stop: oneshot::Sender<()>,
}

pub struct Simulator {
    hub: Arc<Hub>,
    captures: PathBuf,
    stream: Mutex<Option<Stream>>,
    latest: Mutex<Option<Arc<Vec<u8>>>>,
    /// Numéro de la dernière image reçue.
    frames: watch::Sender<u64>,
    ui_seen: AtomicU64,
    /// Taille des images du flux, en pixels : celle que voit Claude.
    image: Mutex<Option<(f64, f64)>>,
    input_ok: AtomicBool,
    /// L'appareil affiché par le panneau, même onglet fermé.
    selected: Mutex<Option<String>>,
    ui_open: AtomicBool,
    window_hidden: AtomicBool,
    agent_active: AtomicBool,
    agent_run: AtomicU64,
    /// Numéro de la dernière image remise à Claude.
    agent_seen: AtomicU64,
    /// Claude peut envoyer plusieurs actions d'un coup : elles passent une par une.
    pub agent_turn: tokio::sync::Mutex<()>,
    next_id: AtomicU64,
}

/// Xcode est-il là ? Lu une fois : sans lui, le CLI n'a pas besoin de l'outil simulateur.
pub fn available() -> bool {
    static XCODE: OnceLock<bool> = OnceLock::new();
    *XCODE.get_or_init(|| {
        std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output()
            .is_ok_and(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).contains(".app/"))
    })
}

/// Le dossier développeur d'Xcode, ou un message lisible. `xcrun` ouvrirait sinon une fenêtre d'installation.
async fn developer_dir() -> Result<String, String> {
    let out = Command::new("/usr/bin/xcode-select").arg("-p").stdin(Stdio::null()).output().await.map_err(|e| e.to_string())?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || !dir.contains(".app/") {
        return Err("Le simulateur iOS a besoin d'Xcode.".into());
    }
    Ok(dir)
}

async fn simctl(args: &[&str], limit: Duration) -> Result<String, String> {
    developer_dir().await?;
    let run = Command::new(XCRUN).arg("simctl").args(args).stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(limit, run).await.map_err(|_| "Le simulateur ne répond pas.".to_string())?.map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&out.stderr);
    let first = message.lines().next().unwrap_or("simctl a échoué").trim();
    Err(first.strip_prefix("An error was encountered processing the command").unwrap_or(first).to_string())
}

/// `com.apple.CoreSimulator.SimRuntime.iOS-27-0` → (27, 0), pour un iOS seulement.
fn ios_version(runtime: &str) -> Option<(u32, u32)> {
    let rest = runtime.rsplit('.').next()?.strip_prefix("iOS-")?;
    let mut parts = rest.split('-').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next().flatten().unwrap_or(0)))
}

fn parse_devices(json: &str) -> Vec<SimDevice> {
    let value: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let mut runtimes: Vec<(u32, u32, &Vec<Value>)> = value["devices"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(runtime, list)| {
            let (major, minor) = ios_version(runtime)?;
            Some((major, minor, list.as_array()?))
        })
        .collect();
    runtimes.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)));
    let mut devices = Vec::new();
    for (major, minor, list) in runtimes {
        for device in list {
            let (Some(udid), Some(name), Some(state)) = (device["udid"].as_str(), device["name"].as_str(), device["state"].as_str()) else { continue };
            devices.push(SimDevice {
                udid: udid.into(),
                name: name.into(),
                state: state.into(),
                runtime: format!("iOS {major}.{minor}"),
            });
        }
    }
    devices
}

pub async fn devices() -> Result<Vec<SimDevice>, String> {
    Ok(parse_devices(&simctl(&["list", "devices", "available", "-j"], Duration::from_secs(20)).await?))
}

pub async fn boot(udid: &str) -> Result<(), String> {
    match simctl(&["boot", udid], Duration::from_secs(120)).await {
        Err(e) if e.contains("current state: Booted") => Ok(()),
        other => other.map(|_| ()),
    }
}

/// Copie du texte dans le presse-papiers de l'appareil. Sans locale UTF-8, `pbcopy` lit du Mac Roman.
pub async fn copy_to_device(udid: &str, text: &str) -> Result<(), String> {
    developer_dir().await?;
    let mut child = Command::new(XCRUN)
        .args(["simctl", "pbcopy", udid])
        .env("LC_ALL", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Presse-papiers indisponible")?;
    stdin.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let status = timeout(Duration::from_secs(10), child.wait()).await.map_err(|_| "Le simulateur ne répond pas.".to_string())?.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Le presse-papiers du simulateur a refusé le texte.".into())
    }
}

/// Claviers et langues de l'appareil, tels que les donne `defaults`.
pub async fn keyboard_settings(udid: &str) -> (Option<String>, Option<String>) {
    let read = |key: &'static str| async move { simctl(&["spawn", udid, "defaults", "read", "-g", key], Duration::from_secs(10)).await.ok() };
    (read("AppleKeyboards").await, read("AppleLanguages").await)
}

pub async fn open_url(udid: &str, url: &str) -> Result<(), String> {
    simctl(&["openurl", udid, url], Duration::from_secs(20)).await.map(|_| ())
}

/// Lit ou change l'apparence : `light`, `dark`, ou `unsupported` sur un appareil qui ne la gère pas.
pub async fn appearance(udid: &str, value: Option<&str>) -> Result<String, String> {
    if let Some(value) = value {
        if value != "light" && value != "dark" {
            return Err("Apparence inconnue".into());
        }
        simctl(&["ui", udid, "appearance", value], Duration::from_secs(10)).await?;
        return Ok(value.into());
    }
    simctl(&["ui", udid, "appearance"], Duration::from_secs(10)).await
}

impl Simulator {
    pub fn new(hub: Arc<Hub>, cache_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            hub,
            captures: cache_dir.join("simulator"),
            stream: Mutex::new(None),
            latest: Mutex::new(None),
            frames: watch::channel(0).0,
            ui_seen: AtomicU64::new(0),
            image: Mutex::new(None),
            input_ok: AtomicBool::new(false),
            selected: Mutex::new(None),
            ui_open: AtomicBool::new(false),
            window_hidden: AtomicBool::new(false),
            agent_active: AtomicBool::new(false),
            agent_run: AtomicU64::new(0),
            agent_seen: AtomicU64::new(0),
            agent_turn: tokio::sync::Mutex::new(()),
            next_id: AtomicU64::new(1),
        })
    }

    pub fn select(&self, udid: Option<String>) {
        *self.selected.lock().unwrap() = udid;
    }

    pub fn selected(&self) -> Option<String> {
        self.selected.lock().unwrap().clone()
    }

    pub async fn shutdown(&self, udid: &str) -> Result<(), String> {
        let attached = self.stream.lock().unwrap().as_ref().is_some_and(|s| s.udid == udid);
        if attached {
            self.close_stream();
        }
        match simctl(&["shutdown", udid], Duration::from_secs(60)).await {
            Err(e) if e.contains("current state: Shutdown") => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// L'onglet s'ouvre sur cet appareil.
    pub async fn attach_ui(self: &Arc<Self>, udid: String) -> Result<(), String> {
        self.ui_open.store(true, Ordering::SeqCst);
        self.open_stream(udid).await
    }

    /// L'onglet se ferme : le pont s'arrête, sauf si Claude s'en sert encore.
    pub fn detach_ui(&self) {
        self.ui_open.store(false, Ordering::SeqCst);
        if !self.agent_active.load(Ordering::SeqCst) {
            self.close_stream();
        }
    }

    /// Claude agit sur cet appareil : branche le pont, garde-le un moment et attend une première image.
    pub async fn agent_attach(self: &Arc<Self>, udid: &str) -> Result<(), String> {
        let same = self.stream.lock().unwrap().as_ref().is_some_and(|s| s.udid == udid);
        if !same {
            self.open_stream(udid.to_string()).await?;
        }
        let starting = !self.agent_active.swap(true, Ordering::SeqCst);
        // Fenêtre cachée : le flux était en pause, or Claude a besoin de voir l'écran.
        self.send_line("resume".to_string());
        let run = self.agent_run.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AGENT_HOLD).await;
            if me.agent_run.load(Ordering::SeqCst) != run {
                return;
            }
            me.agent_active.store(false, Ordering::SeqCst);
            if !me.ui_open.load(Ordering::SeqCst) {
                me.close_stream();
            } else if me.window_hidden.load(Ordering::SeqCst) {
                me.send_line("pause".to_string());
            }
        });
        // Une seule fois par série d'actions : fermer le panneau pendant que Claude travaille reste possible.
        if starting || !same {
            self.hub.emit(UiEvent::Simulator { udid: udid.to_string(), state: "agent".into(), message: None });
        }
        let mut frames = self.frames.subscribe();
        let ready = async {
            loop {
                if self.latest.lock().unwrap().is_some() {
                    return;
                }
                if frames.changed().await.is_err() {
                    return;
                }
            }
        };
        let _ = timeout(FIRST_FRAME, ready).await;
        if self.latest.lock().unwrap().is_some() {
            Ok(())
        } else {
            Err("The screen is not available yet.".into())
        }
    }

    pub fn image_size(&self) -> Option<(f64, f64)> {
        *self.image.lock().unwrap()
    }

    pub fn frame_count(&self) -> u64 {
        *self.frames.borrow()
    }

    /// Claude a-t-il déjà vu la dernière image ?
    pub fn agent_is_current(&self) -> bool {
        self.agent_seen.load(Ordering::SeqCst) == self.frame_count()
    }

    pub fn agent_saw_latest(&self) {
        self.agent_seen.store(self.frame_count(), Ordering::SeqCst);
    }

    pub fn require_input(&self) -> Result<(), String> {
        if self.input_ok.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err("Touches are not available with this version of Xcode.".into())
        }
    }

    pub fn send_line(&self, line: String) {
        if let Some(stream) = self.stream.lock().unwrap().as_ref() {
            let _ = stream.input.send(line);
        }
    }

    /// La dernière image une fois l'écran calmé : aucune nouvelle image pendant `SETTLE_QUIET`.
    pub async fn settled(&self, since: u64, first_change: Duration) -> Option<Arc<Vec<u8>>> {
        let mut frames = self.frames.subscribe();
        let deadline = Instant::now() + SETTLE_MAX;
        if !first_change.is_zero() {
            let changed = async {
                while *frames.borrow_and_update() <= since {
                    if frames.changed().await.is_err() {
                        return;
                    }
                }
            };
            let _ = timeout(first_change, changed).await;
        }
        while Instant::now() < deadline {
            frames.borrow_and_update();
            if timeout(SETTLE_QUIET, frames.changed()).await.is_err() {
                break;
            }
        }
        self.latest.lock().unwrap().clone()
    }

    async fn open_stream(self: &Arc<Self>, udid: String) -> Result<(), String> {
        let dir = developer_dir().await?;
        let mut guard = self.stream.lock().unwrap();
        if guard.as_ref().is_some_and(|s| s.udid == udid) {
            return Ok(());
        }
        *guard = None;
        *self.latest.lock().unwrap() = None;
        *self.image.lock().unwrap() = None;
        self.input_ok.store(false, Ordering::SeqCst);

        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bridge = exe.with_file_name("sim-bridge");
        let mut child = Command::new(&bridge)
            .args([&udid, &dir, &FRAMES_PER_SECOND.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Pont du simulateur introuvable : {e}"))?;
        let mut stdin = child.stdin.take().ok_or("Entrée du pont indisponible")?;
        let stdout = child.stdout.take().ok_or("Sortie du pont indisponible")?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (input, mut lines) = mpsc::unbounded_channel::<String>();
        let (stop, stopped) = oneshot::channel();

        tauri::async_runtime::spawn(async move {
            while let Some(mut line) = lines.recv().await {
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = stopped => { let _ = child.kill().await; }
            }
        });
        let me = self.clone();
        let reader_udid = udid.clone();
        tauri::async_runtime::spawn(async move { me.read_packets(id, reader_udid, stdout).await });

        *guard = Some(Stream { id, udid, input, _stop: stop });
        Ok(())
    }

    async fn read_packets(self: Arc<Self>, id: u64, udid: String, stdout: tokio::process::ChildStdout) {
        let mut reader = BufReader::with_capacity(256 * 1024, stdout);
        let mut header = [0u8; 5];
        let mut failed = None;
        while reader.read_exact(&mut header).await.is_ok() {
            let size = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
            if size > MAX_PACKET {
                break;
            }
            let mut data = vec![0u8; size];
            if reader.read_exact(&mut data).await.is_err() {
                break;
            }
            if !self.is_current(id) {
                return;
            }
            if header[0] == 0 {
                *self.latest.lock().unwrap() = Some(Arc::new(data));
                self.frames.send_modify(|count| *count += 1);
            } else if let Ok(event) = serde_json::from_slice::<Value>(&data) {
                match event["event"].as_str() {
                    Some("ready") => {
                        let input = event["input"].as_bool() == Some(true);
                        self.input_ok.store(input, Ordering::SeqCst);
                        let state = if input { "ready" } else { "no-input" };
                        self.hub.emit(UiEvent::Simulator { udid: udid.clone(), state: state.into(), message: None });
                    }
                    Some("screen") => {
                        if let (Some(width), Some(height)) = (event["width"].as_f64(), event["height"].as_f64()) {
                            *self.image.lock().unwrap() = Some((width, height));
                        }
                    }
                    Some("error") => failed = event["message"].as_str().map(String::from),
                    _ => {}
                }
            }
        }
        // Fin imprévue : appareil éteint ailleurs, ou Xcode incompatible.
        let mut guard = self.stream.lock().unwrap();
        if guard.as_ref().is_some_and(|s| s.id == id) {
            *guard = None;
            drop(guard);
            *self.latest.lock().unwrap() = None;
            let state = if failed.is_some() { "error" } else { "ended" };
            self.hub.emit(UiEvent::Simulator { udid, state: state.into(), message: failed });
        }
    }

    fn is_current(&self, id: u64) -> bool {
        self.stream.lock().unwrap().as_ref().is_some_and(|s| s.id == id)
    }

    pub fn close_stream(&self) {
        *self.stream.lock().unwrap() = None;
        *self.latest.lock().unwrap() = None;
        *self.image.lock().unwrap() = None;
    }

    /// La dernière image pas encore affichée, vide si rien n'a changé pendant `FRAME_WAIT`.
    pub async fn next_frame(&self) -> Vec<u8> {
        let seen = self.ui_seen.load(Ordering::SeqCst);
        let mut frames = self.frames.subscribe();
        let changed = async {
            while *frames.borrow_and_update() <= seen {
                if frames.changed().await.is_err() {
                    return;
                }
            }
        };
        let _ = timeout(FRAME_WAIT, changed).await;
        let count = self.frame_count();
        if count <= seen {
            return Vec::new();
        }
        self.ui_seen.store(count, Ordering::SeqCst);
        self.latest.lock().unwrap().as_ref().map(|frame| frame.to_vec()).unwrap_or_default()
    }

    /// Une ligne de l'interface. Fenêtre cachée : le flux se met en pause, sauf si Claude s'en sert.
    pub fn input(&self, line: String) {
        if line.contains('\n') {
            return;
        }
        if line == "pause" {
            self.window_hidden.store(true, Ordering::SeqCst);
            if self.agent_active.load(Ordering::SeqCst) {
                return;
            }
        } else if line == "resume" {
            self.window_hidden.store(false, Ordering::SeqCst);
        }
        self.send_line(line);
    }

    /// Une capture en pleine résolution, jetable : les précédentes de plus d'un jour sont effacées.
    pub async fn screenshot(&self, udid: &str) -> Result<String, String> {
        std::fs::create_dir_all(&self.captures).map_err(|e| e.to_string())?;
        if let Ok(entries) = std::fs::read_dir(&self.captures) {
            for entry in entries.flatten() {
                let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > CAPTURE_MAX_AGE);
                if old {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = self.captures.join(format!("capture-{stamp}.png"));
        let target = path.to_string_lossy().to_string();
        simctl(&["io", udid, "screenshot", &target], Duration::from_secs(20)).await?;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ne_garde_que_ios_du_plus_recent_au_plus_ancien() {
        let json = r#"{"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-18-2":[{"udid":"a","name":"Vieux","state":"Shutdown"}],
            "com.apple.CoreSimulator.SimRuntime.watchOS-11-0":[{"udid":"w","name":"Montre","state":"Shutdown"}],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"udid":"b","name":"iPhone 18 Pro","state":"Booted"}]
        }}"#;
        let list = parse_devices(json);
        assert_eq!(list.iter().map(|d| d.udid.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(list[0].runtime, "iOS 27.0");
    }

    #[test]
    fn une_reponse_illisible_ne_donne_aucun_appareil() {
        assert!(parse_devices("pas du json").is_empty());
    }
}
