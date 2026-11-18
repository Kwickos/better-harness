//! iOS simulators: list, boot and settings through `simctl`; screen and touches through the
//! `sim-bridge` bridge. The bridge runs only while the tab is shown or Claude uses it,
//! and only the last frame is kept: the UI can fall behind without anything piling up.

use crate::events::UiEvent;
use crate::hub::Hub;
use crate::i18n::tr;
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
/// Beyond this, the next frame request starts over: the UI never waits forever.
const FRAME_WAIT: Duration = Duration::from_secs(1);
const CAPTURE_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// The bridge stays connected this long after Claude's last action, with no tab open.
const AGENT_HOLD: Duration = Duration::from_secs(30);
/// A booting device can take a while to have a frame.
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
    /// "iOS 27.0"
    pub runtime: String,
}

struct Stream {
    id: u64,
    udid: String,
    input: mpsc::UnboundedSender<String>,
    /// The process dies when this channel closes.
    _stop: oneshot::Sender<()>,
}

pub struct Simulator {
    hub: Arc<Hub>,
    captures: PathBuf,
    stream: Mutex<Option<Stream>>,
    latest: Mutex<Option<Arc<Vec<u8>>>>,
    /// Number of the last frame received.
    frames: watch::Sender<u64>,
    ui_seen: AtomicU64,
    /// Size of the stream's frames, in pixels: the one Claude sees.
    image: Mutex<Option<(f64, f64)>>,
    input_ok: AtomicBool,
    /// The device shown by the panel, even with the tab closed.
    selected: Mutex<Option<String>>,
    ui_open: AtomicBool,
    window_hidden: AtomicBool,
    agent_active: AtomicBool,
    agent_run: AtomicU64,
    /// Number of the last frame handed to Claude.
    agent_seen: AtomicU64,
    /// Claude can send several actions at once: they go through one by one.
    pub agent_turn: tokio::sync::Mutex<()>,
    next_id: AtomicU64,
}

/// Is Xcode there? Read once: without it, the CLI does not need the simulator tool.
pub fn available() -> bool {
    static XCODE: OnceLock<bool> = OnceLock::new();
    *XCODE.get_or_init(|| {
        std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output()
            .is_ok_and(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).contains(".app/"))
    })
}

/// Xcode's developer folder, or a readable message. `xcrun` would otherwise open an install window.
async fn developer_dir() -> Result<String, String> {
    let out = Command::new("/usr/bin/xcode-select").arg("-p").stdin(Stdio::null()).output().await.map_err(|e| e.to_string())?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || !dir.contains(".app/") {
        return Err(tr("The iOS simulator needs Xcode.", "Le simulateur iOS a besoin d'Xcode.").into());
    }
    Ok(dir)
}

async fn simctl(args: &[&str], limit: Duration) -> Result<String, String> {
    developer_dir().await?;
    let run = Command::new(XCRUN).arg("simctl").args(args).stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(limit, run)
        .await
        .map_err(|_| tr("The simulator is not responding.", "Le simulateur ne répond pas.").to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let message = String::from_utf8_lossy(&out.stderr);
    let first = message.lines().next().unwrap_or(tr("simctl failed", "simctl a échoué")).trim();
    Err(first.strip_prefix("An error was encountered processing the command").unwrap_or(first).to_string())
}

/// `com.apple.CoreSimulator.SimRuntime.iOS-27-0` → (27, 0), for iOS only.
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

/// The bridge reports its failures in English: shown in the UI language when it is known.
fn bridge_message(message: &str) -> String {
    const MESSAGES: [(&str, &str); 5] = [
        ("CoreSimulator not found: is Xcode installed?", "CoreSimulator est introuvable : Xcode est-il installé ?"),
        ("SimulatorKit not found in this Xcode.", "SimulatorKit est introuvable dans cet Xcode."),
        ("This simulator no longer exists.", "Ce simulateur n'existe plus."),
        ("This simulator's screen is unavailable: is it booted?", "L'écran de ce simulateur est indisponible : est-il démarré ?"),
        ("This Xcode does not expose the simulator screen as expected.", "Cet Xcode n'expose pas l'écran du simulateur comme attendu."),
    ];
    MESSAGES.iter().find(|(en, _)| *en == message).map_or(message, |(en, fr)| tr(*en, *fr)).to_string()
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

/// Copies text to the device clipboard. Without a UTF-8 locale, `pbcopy` reads Mac Roman.
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
    let mut stdin = child.stdin.take().ok_or("Clipboard unavailable")?;
    stdin.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let status = timeout(Duration::from_secs(10), child.wait()).await.map_err(|_| "The simulator is not responding.".to_string())?.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("The simulator clipboard refused the text.".into())
    }
}

/// The device's keyboards and languages, as `defaults` gives them.
pub async fn keyboard_settings(udid: &str) -> (Option<String>, Option<String>) {
    let read = |key: &'static str| async move { simctl(&["spawn", udid, "defaults", "read", "-g", key], Duration::from_secs(10)).await.ok() };
    (read("AppleKeyboards").await, read("AppleLanguages").await)
}

pub async fn open_url(udid: &str, url: &str) -> Result<(), String> {
    simctl(&["openurl", udid, url], Duration::from_secs(20)).await.map(|_| ())
}

/// Reads or changes the appearance: `light`, `dark`, or `unsupported` on a device that lacks it.
pub async fn appearance(udid: &str, value: Option<&str>) -> Result<String, String> {
    if let Some(value) = value {
        if value != "light" && value != "dark" {
            return Err(tr("Unknown appearance", "Apparence inconnue").into());
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

    /// The tab opens on this device.
    pub async fn attach_ui(self: &Arc<Self>, udid: String) -> Result<(), String> {
        self.ui_open.store(true, Ordering::SeqCst);
        self.open_stream(udid).await
    }

    /// The tab closes: the bridge stops, unless Claude still uses it.
    pub fn detach_ui(&self) {
        self.ui_open.store(false, Ordering::SeqCst);
        if !self.agent_active.load(Ordering::SeqCst) {
            self.close_stream();
        }
    }

    /// Claude acts on this device: connect the bridge, keep it a while and wait for a first frame.
    pub async fn agent_attach(self: &Arc<Self>, udid: &str) -> Result<(), String> {
        let same = self.stream.lock().unwrap().as_ref().is_some_and(|s| s.udid == udid);
        if !same {
            self.open_stream(udid.to_string()).await?;
        }
        let starting = !self.agent_active.swap(true, Ordering::SeqCst);
        // Hidden window: the stream was paused, but Claude needs to see the screen.
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
        // Once per series of actions: closing the panel while Claude works stays possible.
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

    /// Has Claude already seen the last frame?
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

    /// The last frame once the screen has settled: no new frame during `SETTLE_QUIET`.
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
            .map_err(|e| tr(format!("Simulator bridge not found: {e}"), format!("Pont du simulateur introuvable : {e}")))?;
        let mut stdin = child.stdin.take().ok_or(tr("Bridge input unavailable", "Entrée du pont indisponible"))?;
        let stdout = child.stdout.take().ok_or(tr("Bridge output unavailable", "Sortie du pont indisponible"))?;
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
                    Some("error") => failed = event["message"].as_str().map(bridge_message),
                    _ => {}
                }
            }
        }
        // Unexpected end: device shut down elsewhere, or incompatible Xcode.
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

    /// The last frame not yet shown, empty if nothing changed during `FRAME_WAIT`.
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

    /// A line from the UI. Hidden window: the stream pauses, unless Claude uses it.
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

    /// A disposable full-resolution capture: previous ones older than a day are erased.
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
    fn keeps_only_ios_newest_first() {
        let json = r#"{"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-18-2":[{"udid":"a","name":"Old","state":"Shutdown"}],
            "com.apple.CoreSimulator.SimRuntime.watchOS-11-0":[{"udid":"w","name":"Watch","state":"Shutdown"}],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"udid":"b","name":"iPhone 18 Pro","state":"Booted"}]
        }}"#;
        let list = parse_devices(json);
        assert_eq!(list.iter().map(|d| d.udid.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(list[0].runtime, "iOS 27.0");
    }

    #[test]
    fn unreadable_answer_gives_no_device() {
        assert!(parse_devices("not json").is_empty());
    }
}
