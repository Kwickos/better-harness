//! L'outil MCP qui laisse Claude joindre des fichiers à la conversation : les images s'y affichent
//! en aperçu, les autres fichiers en carte qui s'ouvre dans leur app. Servi comme `simulator_tool`
//! (serveur « sdk » sur le canal stream-json), sans processus de plus. L'outil ne renvoie rien du
//! contenu au modèle : il montre un fichier à l'utilisateur, d'où son autorisation sans demande.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const SERVER: &str = "harness";
pub const TOOL: &str = "mcp__harness__send_files";
pub const CONFIG: &str = r#"{"mcpServers":{"harness":{"type":"sdk","name":"harness"}}}"#;
/// Ajouté au prompt système : un outil MCP reste différé, Claude doit savoir qu'il existe.
pub const PROMPT: &str = "This conversation is shown in the Better Harness desktop chat. To show the user an image or any \
other file (a screenshot, a generated image, a chart, a PDF, an export), call mcp__harness__send_files with its path: \
images appear inline with a preview.";
const MAX_FILES: usize = 20;

const DESCRIPTION: &str = "Show files to the user in this chat. Images (PNG, JPEG, GIF, WebP, SVG, HEIC, AVIF…) appear \
inline as previews the user can open full size; other files appear as cards that open in their default app. Use it \
whenever the user would want to see a file you made or found: a generated image, a screenshot, a chart, a PDF, an export. \
The files must already exist; paths are absolute or relative to the working directory. Nothing of the files comes back to you.";

const IMAGE_EXT: [&str; 14] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "heic", "heif", "avif", "apng"];

/// Fichiers qu'« Ouvrir » ne doit pas lancer : un script ou un raccourci s'exécuterait au lieu de s'afficher.
const RUNNABLE_EXT: [&str; 20] = [
    "command", "tool", "terminal", "sh", "bash", "zsh", "csh", "ksh", "fish", "app", "pkg", "mpkg", "jar", "workflow", "scpt",
    "applescript", "webloc", "inetloc", "fileloc", "shortcut",
];

fn tool() -> Value {
    json!({
        "name": "send_files",
        "description": DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "files": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": MAX_FILES, "description": "Paths of the files to show." },
                "caption": { "type": "string", "description": "Optional short line shown with the files." }
            },
            "required": ["files"]
        },
        "annotations": { "readOnlyHint": true }
    })
}

/// Répond à un message JSON-RPC du CLI.
pub fn handle(cwd: &str, message: &Value) -> Value {
    let id = message["id"].clone();
    let result = match message["method"].as_str() {
        Some("initialize") => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") }
        }),
        Some("tools/list") => json!({ "tools": [tool()] }),
        Some("tools/call") => match run(cwd, &message["params"]["arguments"]) {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
        },
        Some("ping") => json!({}),
        // Une notification n'attend pas de réponse.
        _ if id.is_null() => return json!({}),
        _ => return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Méthode inconnue" } }),
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Les chemins demandés : une liste, ou un seul chemin passé en chaîne.
pub fn requested(args: &Value) -> Vec<String> {
    let files = &args["files"];
    let list: Vec<String> = match files {
        Value::String(s) => vec![s.clone()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    list.into_iter().filter(|p| !p.trim().is_empty()).take(MAX_FILES).collect()
}

fn run(cwd: &str, args: &Value) -> Result<String, String> {
    let paths = requested(args);
    if paths.is_empty() {
        return Err("files is required: the paths of the files to show.".into());
    }
    let (found, missing): (Vec<&String>, Vec<&String>) = paths.iter().partition(|p| resolve(cwd, p).is_file());
    if found.is_empty() {
        return Err(format!("No such file: {}.", join(&missing)));
    }
    let mut text = format!("Shown to the user: {}.", join(&found));
    if !missing.is_empty() {
        text.push_str(&format!(" Not found, not shown: {}.", join(&missing)));
    }
    Ok(text)
}

fn join(paths: &[&String]) -> String {
    paths.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(", ")
}

/// Chemin absolu : `~` vaut le dossier personnel, un chemin relatif part du dossier de la conversation.
pub fn resolve(cwd: &str, path: &str) -> PathBuf {
    let p = path.trim();
    let p = p.strip_prefix("file://").unwrap_or(p);
    if p == "~" || p.starts_with("~/") {
        return dirs::home_dir().unwrap_or_default().join(p.trim_start_matches('~').trim_start_matches('/'));
    }
    let p = Path::new(p);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(cwd).join(p)
    }
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Ce que l'interface affiche d'un fichier joint.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub size: u64,
    pub image: bool,
    /// Dimensions lues dans l'en-tête de l'image : l'aperçu a sa taille avant d'être chargé.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub fn describe(cwd: &str, path: &str) -> Attachment {
    let full = resolve(cwd, path);
    let meta = std::fs::metadata(&full).ok().filter(|m| m.is_file());
    let ext = extension(&full);
    let image = meta.is_some() && IMAGE_EXT.contains(&ext.as_str());
    let dims = if image && ext != "svg" {
        imagesize::size(&full).ok().filter(|s| s.width > 0 && s.height > 0).map(|s| (s.width as u32, s.height as u32))
    } else {
        None
    };
    Attachment {
        name: full.file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string(),
        path: full.to_string_lossy().into_owned(),
        exists: meta.is_some(),
        size: meta.map(|m| m.len()).unwrap_or(0),
        image,
        width: dims.map(|d| d.0),
        height: dims.map(|d| d.1),
    }
}

/// Un fichier qu'« Ouvrir » peut confier à son app sans rien exécuter.
pub fn safe_to_open(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    meta.is_file() && meta.permissions().mode() & 0o111 == 0 && !RUNNABLE_EXT.contains(&extension(path).as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chemins_resolus() {
        assert_eq!(resolve("/a/b", "c.png"), PathBuf::from("/a/b/c.png"));
        assert_eq!(resolve("/a/b", " /x/y.png "), PathBuf::from("/x/y.png"));
        assert_eq!(resolve("/a/b", "file:///x/y.png"), PathBuf::from("/x/y.png"));
        assert_eq!(resolve("/a/b", "~/y.png"), dirs::home_dir().unwrap().join("y.png"));
    }

    #[test]
    fn fichiers_demandes() {
        assert_eq!(requested(&json!({ "files": ["a.png", " ", "b.pdf"] })), vec!["a.png", "b.pdf"]);
        assert_eq!(requested(&json!({ "files": "a.png" })), vec!["a.png"]);
        assert!(requested(&json!({})).is_empty());
    }

    #[test]
    fn appel_de_l_outil() {
        let dir = std::env::temp_dir().join(format!("bh-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // PNG 3 × 2 minimal : signature et en-tête IHDR suffisent à lire la taille.
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
        std::fs::write(dir.join("a.png"), &png).unwrap();
        let cwd = dir.to_str().unwrap();

        let call = |args: Value| handle(cwd, &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "arguments": args } }));
        let ok = call(json!({ "files": ["a.png", "absent.pdf"] }));
        assert_eq!(ok["result"]["isError"], Value::Null);
        assert_eq!(ok["result"]["content"][0]["text"], "Shown to the user: a.png. Not found, not shown: absent.pdf.");
        assert_eq!(call(json!({ "files": ["absent.pdf"] }))["result"]["isError"], true);

        let a = describe(cwd, "a.png");
        assert!(a.exists && a.image);
        assert_eq!((a.width, a.height, a.name.as_str()), (Some(3), Some(2), "a.png"));
        assert!(!describe(cwd, "absent.pdf").exists);
        assert!(safe_to_open(&dir.join("a.png")));
        std::fs::write(dir.join("go.command"), "echo").unwrap();
        assert!(!safe_to_open(&dir.join("go.command")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
