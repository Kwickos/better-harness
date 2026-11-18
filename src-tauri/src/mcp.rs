//! Sélection des serveurs MCP par session.
//!
//! Chaque processus `claude` relance sa propre copie de chaque serveur MCP stdio
//! (constaté : rea, touchdesigner, blender… dupliqués dans chaque session de
//! Desktop). En ne passant que les serveurs utiles via
//! `--strict-mcp-config --mcp-config`, on évite ces processus et on allège le
//! contexte (les définitions d'outils MCP coûtent des tokens).

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub name: String,
    /// user | local | project
    pub scope: String,
    /// stdio | http | sse
    pub transport: String,
    pub detail: String,
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// Configs des serveurs visibles pour `cwd`, par ordre de priorité croissante.
fn sources(cwd: &str) -> Vec<(String, Map<String, Value>)> {
    let mut out = Vec::new();
    let home = dirs::home_dir().unwrap_or_default();
    if let Some(cfg) = read_json(&home.join(".claude.json")) {
        if let Some(m) = cfg.get("mcpServers").and_then(Value::as_object) {
            out.push(("user".to_string(), m.clone()));
        }
        if let Some(m) = cfg
            .get("projects")
            .and_then(|p| p.get(cwd))
            .and_then(|p| p.get("mcpServers"))
            .and_then(Value::as_object)
        {
            out.push(("local".to_string(), m.clone()));
        }
    }
    if let Some(m) = read_json(&Path::new(cwd).join(".mcp.json"))
        .and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned())
    {
        out.push(("project".to_string(), m));
    }
    out
}

pub fn list(cwd: &str) -> Vec<McpEntry> {
    let mut by_name: std::collections::BTreeMap<String, McpEntry> = Default::default();
    for (scope, servers) in sources(cwd) {
        for (name, cfg) in servers {
            let transport = cfg
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or(if cfg.get("url").is_some() { "http" } else { "stdio" })
                .to_string();
            let detail = match transport.as_str() {
                "stdio" => {
                    let cmd = cfg.get("command").and_then(Value::as_str).unwrap_or("");
                    let args: Vec<&str> = cfg
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    crate::protocol::one_line(&format!("{cmd} {}", args.join(" ")), 80)
                }
                _ => cfg.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
            };
            by_name.insert(name.clone(), McpEntry { name, scope: scope.clone(), transport, detail });
        }
    }
    by_name.into_values().collect()
}

/// Écrit un fichier --mcp-config ne contenant que les serveurs `names`.
/// Le fichier peut contenir des secrets (variables d'env) : droits 0600.
pub fn write_config(cwd: &str, names: &[String], dest: &PathBuf) -> std::io::Result<()> {
    let mut chosen = Map::new();
    for (_, servers) in sources(cwd) {
        for (name, cfg) in servers {
            if names.iter().any(|n| n == &name) {
                chosen.insert(name, cfg);
            }
        }
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "mcpServers": chosen }))?;
    std::fs::write(dest, body)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o600))
}
