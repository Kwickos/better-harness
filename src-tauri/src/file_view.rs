//! The panel's "File" tab: what a file is (text, image, PDF, audio, video, other), its text
//! when it can be edited, and saving it back. A save refuses to overwrite a file that changed
//! on disk since it was read (Claude or another app wrote it meanwhile).

use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::i18n::tr;

/// Beyond this, the text isn't loaded: a textarea becomes slow, and it's rarely hand-edited.
const MAX_TEXT: u64 = 4 * 1024 * 1024;
/// Bytes looked at to tell text from binary.
const SNIFF: usize = 8000;

const PDF_EXT: [&str; 1] = ["pdf"];
const VIDEO_EXT: [&str; 5] = ["mp4", "m4v", "mov", "webm", "ogv"];
const AUDIO_EXT: [&str; 7] = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// "text", "image", "pdf", "video", "audio", "binary" or "large" (text too big to edit).
    pub kind: &'static str,
    pub text: Option<String>,
    /// Modification time in milliseconds: a save checks that it hasn't changed.
    pub modified: u64,
    pub readonly: bool,
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn kind_by_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let ext = ext.as_str();
    if crate::files_tool::IMAGE_EXT.contains(&ext) {
        Some("image")
    } else if PDF_EXT.contains(&ext) {
        Some("pdf")
    } else if VIDEO_EXT.contains(&ext) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext) {
        Some("audio")
    } else {
        None
    }
}

/// Text only if it is valid UTF-8 without NUL bytes: saving anything else would damage it.
fn as_text(bytes: Vec<u8>) -> Option<String> {
    if bytes[..bytes.len().min(SNIFF)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub fn open(cwd: &str, path: &str) -> Result<FileView, String> {
    let full = crate::files_tool::resolve(cwd, path);
    let meta = std::fs::metadata(&full).map_err(|_| tr(format!("Not found: {}", full.display()), format!("Introuvable : {}", full.display())))?;
    if !meta.is_file() {
        return Err(tr(format!("Not a file: {}", full.display()), format!("Ce n'est pas un fichier : {}", full.display())));
    }
    let size = meta.len();
    let mut kind = kind_by_extension(&full);
    let mut text = None;
    if kind.is_none() {
        if size > MAX_TEXT {
            // Too big to edit: still say whether it is text, from its start.
            let mut head = vec![0u8; SNIFF];
            let n = std::io::Read::read(&mut std::fs::File::open(&full).map_err(|e| e.to_string())?, &mut head).map_err(|e| e.to_string())?;
            kind = Some(if head[..n].contains(&0) { "binary" } else { "large" });
        } else {
            let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
            text = as_text(bytes);
            kind = Some(if text.is_some() { "text" } else { "binary" });
        }
    }
    Ok(FileView {
        name: full.file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string(),
        path: full.to_string_lossy().into_owned(),
        size,
        kind: kind.unwrap_or("binary"),
        text,
        modified: modified_ms(&meta),
        readonly: meta.permissions().readonly(),
    })
}

/// Writes the text in place (permissions and symbolic links are kept). `expected`: the
/// modification time read at opening; `None` overwrites whatever is there.
/// Returns the new modification time.
pub fn save(path: &str, text: &str, expected: Option<u64>) -> Result<u64, String> {
    let full = Path::new(path);
    let meta = std::fs::metadata(full).map_err(|e| e.to_string())?;
    if let Some(expected) = expected {
        if modified_ms(&meta) != expected {
            return Err("conflict".into());
        }
    }
    std::fs::write(full, text).map_err(|e| tr(format!("Couldn't save: {e}"), format!("Enregistrement impossible : {e}")))?;
    Ok(std::fs::metadata(full).map(|m| modified_ms(&m)).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("bh-fileview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn kinds() {
        let root = dir();
        std::fs::write(root.join(".env"), "KEY=value\n").unwrap();
        std::fs::write(root.join("doc.pdf"), b"%PDF-1.4").unwrap();
        std::fs::write(root.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        std::fs::write(root.join("latin1.txt"), [0x63, 0x61, 0x66, 0xe9]).unwrap();
        let cwd = root.to_string_lossy();
        let env = open(&cwd, ".env").unwrap();
        assert_eq!((env.kind, env.text.as_deref(), env.name.as_str()), ("text", Some("KEY=value\n"), ".env"));
        assert_eq!(open(&cwd, "doc.pdf").unwrap().kind, "pdf");
        assert_eq!(open(&cwd, "blob.bin").unwrap().kind, "binary");
        // Not UTF-8: shown as binary rather than saved back damaged.
        assert_eq!(open(&cwd, "latin1.txt").unwrap().kind, "binary");
        assert!(open(&cwd, "missing").is_err());
        assert!(open(&cwd, ".").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn save_refuses_a_file_changed_meanwhile() {
        let root = dir();
        let file = root.join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let path = file.to_string_lossy().into_owned();
        let read = open("", &path).unwrap();
        let after = save(&path, "two", Some(read.modified)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(save(&path, "three", Some(after.wrapping_sub(5_000))), Err("conflict".into()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        save(&path, "three", None).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "three");
        let _ = std::fs::remove_dir_all(root);
    }
}
