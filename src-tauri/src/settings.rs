use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Avant la version 2, le dernier choix du composer était enregistré comme défaut :
/// ces valeurs n'ont jamais été choisies dans les réglages, on les oublie.
const SETTINGS_VERSION: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(default)]
    pub settings_version: u32,
    /// Chemin explicite du binaire `claude` (sinon résolu via le PATH du shell).
    pub claude_path: Option<String>,
    /// Nombre max de processus CLI vivants en même temps. Au-delà, la session
    /// inactive la plus ancienne est suspendue (et reprise via --resume).
    pub max_live: usize,
    /// Minutes d'inactivité avant de suspendre le processus d'une session.
    pub idle_minutes: u64,
    pub default_model: Option<String>,
    /// low | medium | high | xhigh | max (None = défaut du CLI).
    pub default_effort: Option<String>,
    pub default_permission_mode: String,
    /// "all" = configuration MCP standard du CLI ; "selected" = uniquement `mcp_selected`.
    pub mcp_mode: String,
    pub mcp_selected: Vec<String>,
    /// Streaming du texte en cours de génération (--include-partial-messages).
    pub partial_messages: bool,
    /// Garder les outils lourds et rares (`HEAVY_TOOLS`), retirés par défaut.
    pub all_tools: bool,
    pub recent_dirs: Vec<String>,
}

/// Outils du CLI chargés dans chaque requête alors qu'ils servent rarement : Workflow
/// (≈2,7k tokens) et ScheduleWakeup, utilisé seulement par /loop (≈2,5k). Mesuré avec
/// `get_context_usage` sur le CLI 2.1.319 ; les autres outils rares sont déjà différés.
pub const HEAVY_TOOLS: [&str; 2] = ["Workflow", "ScheduleWakeup"];

impl Default for Settings {
    fn default() -> Self {
        Self {
            settings_version: SETTINGS_VERSION,
            claude_path: None,
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

/// Modèle et effort que le CLI utilise quand on ne lui en impose aucun.
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

/// Du moins au plus prioritaire : réglages utilisateur, projet, puis projet local.
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
    fn oublie_les_defauts_implicites_une_seule_fois() {
        let old = temp("old.json", r#"{"defaultModel":"haiku","defaultEffort":"high","defaultPermissionMode":"auto","recentDirs":["/a"]}"#);
        let s = Settings::load(&old);
        assert_eq!((s.default_model.as_deref(), s.default_effort.as_deref()), (None, None));
        assert_eq!((s.default_permission_mode.as_str(), s.recent_dirs.len()), ("auto", 1));

        // Une fois migrés, les choix faits dans les réglages restent.
        let mut chosen = s.clone();
        chosen.default_model = Some("sonnet".into());
        chosen.save(&old).unwrap();
        assert_eq!(Settings::load(&old).default_model.as_deref(), Some("sonnet"));
        let _ = std::fs::remove_file(old);
    }

    #[test]
    fn le_projet_prime_sur_l_utilisateur() {
        let user = temp("user.json", r#"{"model":"opus","effortLevel":"xhigh"}"#);
        let project = temp("project.json", r#"{"effortLevel":"low"}"#);
        let broken = temp("broken.json", "{pas du json");
        let d = read_cli_defaults(&[user.clone(), project.clone(), broken.clone(), PathBuf::from("/absent.json")]);
        assert_eq!((d.model.as_deref(), d.effort.as_deref()), (Some("opus"), Some("low")));
        for f in [user, project, broken] {
            let _ = std::fs::remove_file(f);
        }
    }
}
