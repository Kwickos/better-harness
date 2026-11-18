//! The MCP tool that lets Claude attach files to the conversation: images show as previews,
//! other files as cards that open in their app. Served like `simulator_tool` ("sdk" server on
//! the stream-json channel), with no extra process. The tool returns nothing of the content to
//! the model: it shows a file to the user, hence its approval without a prompt.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const SERVER: &str = "harness";
pub const TOOL: &str = "mcp__harness__send_files";
pub const CONFIG: &str = r#"{"mcpServers":{"harness":{"type":"sdk","name":"harness"}}}"#;
/// Appended to the system prompt: an MCP tool stays deferred, Claude must know it exists.
pub const PROMPT: &str = "This conversation is shown in the Better Harness desktop chat. To show the user an image or any \
other file (a screenshot, a generated image, a chart, a PDF, an export), call mcp__harness__send_files with its path: \
images appear inline with a preview.";
const MAX_FILES: usize = 20;

const DESCRIPTION: &str = "Show files to the user in this chat. Images (PNG, JPEG, GIF, WebP, SVG, HEIC, AVIF…) appear \
inline as previews the user can open full size; other files appear as cards that open in their default app. Use it \
whenever the user would want to see a file you made or found: a generated image, a screenshot, a chart, a PDF, an export. \
The files must already exist; paths are absolute or relative to the working directory. Nothing of the files comes back to you.";

const IMAGE_EXT: [&str; 14] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "heic", "heif", "avif", "apng"];

/// Files "Open" must not launch: a script or a shortcut would run instead of showing.
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

/// Answers a JSON-RPC message from the CLI.
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
        // A notification expects no answer.
        _ if id.is_null() => return json!({}),
        _ => return json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } }),
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// The requested paths: a list, or a single path passed as a string.
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

/// Absolute path: `~` is the home folder, a relative path starts from the conversation's folder.
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

/// What the UI shows of an attached file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub path: String,
    pub name: String,
    pub exists: bool,
    pub size: u64,
    pub image: bool,
    /// Dimensions read from the image header: the preview has its size before it loads.
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

/// A file "Open" can hand to its app without running anything.
pub fn safe_to_open(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    meta.is_file() && meta.permissions().mode() & 0o111 == 0 && !RUNNABLE_EXT.contains(&extension(path).as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_paths() {
        assert_eq!(resolve("/a/b", "c.png"), PathBuf::from("/a/b/c.png"));
        assert_eq!(resolve("/a/b", " /x/y.png "), PathBuf::from("/x/y.png"));
        assert_eq!(resolve("/a/b", "file:///x/y.png"), PathBuf::from("/x/y.png"));
        assert_eq!(resolve("/a/b", "~/y.png"), dirs::home_dir().unwrap().join("y.png"));
    }

    #[test]
    fn requested_files() {
        assert_eq!(requested(&json!({ "files": ["a.png", " ", "b.pdf"] })), vec!["a.png", "b.pdf"]);
        assert_eq!(requested(&json!({ "files": "a.png" })), vec!["a.png"]);
        assert!(requested(&json!({})).is_empty());
    }

    #[test]
    fn tool_call() {
        let dir = std::env::temp_dir().join(format!("bh-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Minimal 3 × 2 PNG: the signature and IHDR header are enough to read the size.
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
