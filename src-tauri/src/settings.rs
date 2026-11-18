use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Before version 2, the composer's last choice was saved as the default:
/// those values were never picked in the settings, so they are dropped.
const SETTINGS_VERSION: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(default)]
    pub settings_version: u32,
    /// Explicit path to the `claude` binary (otherwise resolved through the shell PATH).
    pub claude_path: Option<String>,
    /// Runs `claude update` at launch, then every 6 hours (src-tauri/src/cli_updates.rs).
    pub cli_auto_update: bool,
    /// Max number of CLI processes alive at once. Beyond that, the oldest idle
    /// session is suspended (and resumed with --resume).
    pub max_live: usize,
    /// Minutes of inactivity before a session's process is suspended.
    pub idle_minutes: u64,
    pub default_model: Option<String>,
    /// low | medium | high | xhigh | max (None = CLI default).
    pub default_effort: Option<String>,
    pub default_permission_mode: String,
    /// "all" = the CLI's standard MCP configuration; "selected" = only `mcp_selected`.
    pub mcp_mode: String,
    pub mcp_selected: Vec<String>,
    /// Streaming of text while it is generated (--include-partial-messages).
    pub partial_messages: bool,
    /// Keep the heavy, rarely used tools (`HEAVY_TOOLS`), removed by default.
    pub all_tools: bool,
    pub recent_dirs: Vec<String>,
    /// Interface language: "en" (default), "fr", or "system" (macOS preferred languages).
    pub language: String,
}

/// CLI tools loaded in every request though they are rarely used: Workflow
/// (≈2.7k tokens) and ScheduleWakeup, used only by /loop (≈2.5k). Measured with
/// `get_context_usage` on CLI 2.1.319; the other rare tools are already deferred.
pub const HEAVY_TOOLS: [&str; 2] = ["Workflow", "ScheduleWakeup"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            settings_version: SETTINGS_VERSION,
            claude_path: None,
            cli_auto_update: true,
            max_live: 3,
            idle_minutes: 10,
            default_model: None,
            default_effort: None,
            default_permission_mode: "default".into(),
            mcp_mode: "all".into(),
            mcp_selected: vec![],
            partial_messages: true,
            all_tools: false,
            recent_dirs: vec![],
            language: "en".into(),
        }
    }
}

impl Settings {
    pub fn load(path: &PathBuf) -> Self {
        let mut s: Self = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if s.settings_version < SETTINGS_VERSION {
            s.default_model = None;
            s.default_effort = None;
            s.settings_version = SETTINGS_VERSION;
        }
        s
    }

    pub fn save(&self, path: &PathBuf) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        std::fs::rename(tmp, path)
    }

    pub fn remember_dir(&mut self, dir: &str) {
        self.recent_dirs.retain(|d| d != dir);
        self.recent_dirs.insert(0, dir.to_string());
        self.recent_dirs.truncate(12);
    }
}

/// Model and effort the CLI uses when none is forced on it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
}

fn read_cli_defaults(files: &[PathBuf]) -> CliDefaults {
    let mut out = CliDefaults::default();
    for f in files {
        let Some(v) = std::fs::read(f).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { continue };
        if let Some(m) = v["model"].as_str() {
            out.model = Some(m.to_string());
        }
        if let Some(e) = v["effortLevel"].as_str() {
            out.effort = Some(e.to_string());
        }
    }
    out
}

/// From lowest to highest priority: user settings, project, then local project.
pub fn cli_defaults(cwd: Option<&str>) -> CliDefaults {
    let mut files = vec![dirs::home_dir().unwrap_or_default().join(".claude/settings.json")];
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        let project = PathBuf::from(c).join(".claude");
        files.push(project.join("settings.json"));
        files.push(project.join("settings.local.json"));
    }
    read_cli_defaults(&files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, body: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("bh-settings-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn drops_implicit_defaults_only_once() {
        let old = temp("old.json", r#"{"defaultModel":"haiku","defaultEffort":"high","defaultPermissionMode":"auto","recentDirs":["/a"]}"#);
        let s = Settings::load(&old);
        assert_eq!((s.default_model.as_deref(), s.default_effort.as_deref()), (None, None));
        assert_eq!((s.default_permission_mode.as_str(), s.recent_dirs.len()), ("auto", 1));

        // Once migrated, choices made in the settings stay.
        let mut chosen = s.clone();
        chosen.default_model = Some("sonnet".into());
        chosen.save(&old).unwrap();
        assert_eq!(Settings::load(&old).default_model.as_deref(), Some("sonnet"));
        let _ = std::fs::remove_file(old);
    }

    #[test]
    fn project_overrides_user() {
        let user = temp("user.json", r#"{"model":"opus","effortLevel":"xhigh"}"#);
        let project = temp("project.json", r#"{"effortLevel":"low"}"#);
        let broken = temp("broken.json", "{not json");
        let d = read_cli_defaults(&[user.clone(), project.clone(), broken.clone(), PathBuf::from("/absent.json")]);
        assert_eq!((d.model.as_deref(), d.effort.as_deref()), (Some("opus"), Some("low")));
        for f in [user, project, broken] {
            let _ = std::fs::remove_file(f);
        }
    }
}
