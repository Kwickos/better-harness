//! An app launched from the Finder does not inherit the shell PATH: `claude`, `npx`,
//! `uv`… would be missing for the CLI and its MCP servers. The PATH is read once
//! through a login shell (Claude Desktop does the same with its
//! "Shell Environment Extractor").

use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::OnceCell;

static SHELL_PATH: OnceCell<String> = OnceCell::const_new();

fn fallback_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut parts: Vec<String> = vec![
        home.join(".local/bin").display().to_string(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Ok(p) = std::env::var("PATH") {
        parts.push(p);
    }
    parts.push("/usr/bin:/bin:/usr/sbin:/sbin".into());
    parts.join(":")
}

async fn read_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", "printf '__BH_PATH__%s' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(6), cmd.output()).await.ok()?.ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let p = s.rsplit("__BH_PATH__").next()?.trim().to_string();
    (!p.is_empty()).then_some(p)
}

/// PATH passed to the CLI (resolved once, then cached).
pub async fn path() -> &'static str {
    SHELL_PATH
        .get_or_init(|| async {
            let mut p = read_login_path().await.unwrap_or_else(fallback_path);
            let local = dirs::home_dir().unwrap_or_default().join(".local/bin");
            if !p.split(':').any(|d| Path::new(d) == local) {
                p = format!("{}:{p}", local.display());
            }
            p
        })
        .await
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// What `claude --version` prints (`2.1.327 (Claude Code)`), or `None` if it does not answer.
pub async fn claude_version(claude: &Path) -> Option<String> {
    let mut cmd = Command::new(claude);
    cmd.arg("--version")
        .env("PATH", path().await)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(8), cmd.output()).await.ok()?.ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !v.is_empty()).then_some(v)
}

/// Finds the `claude` binary: explicit setting, then shell PATH, then known locations.
pub async fn resolve_claude(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = explicit.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(p.trim());
        return is_executable(&p).then_some(p);
    }
    for dir in path().await.split(':') {
        let c = Path::new(dir).join("claude");
        if is_executable(&c) {
            return Some(c);
        }
    }
    let home = dirs::home_dir()?;
    [home.join(".local/bin/claude"), home.join(".claude/local/claude")]
        .into_iter()
        .find(|p| is_executable(p))
}
