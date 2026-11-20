//! Files that reach the composer without a path of their own: a pasted screenshot, a file
//! copied from the Finder. They are written to the cache and mentioned like any other file.

use crate::i18n::tr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Enough for a screenshot or a document; beyond that, dragging the file is the way.
const MAX_BYTES: usize = 50 * 1024 * 1024;
/// Old enough to have been sent and read: older files are erased on the next paste.
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// A name safe to write: no folder, no hidden file, no quote that would break the mention.
fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches(|c| matches!(c, '.' | '-' | ' '));
    let mut out: String = trimmed.chars().take(80).collect();
    if out.is_empty() {
        out = "file".into();
    }
    out
}

fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > MAX_AGE);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Writes the bytes under `dir`, in a folder of their own so the original name stays readable.
pub fn save(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err(tr("The pasted file is empty.", "Le fichier collé est vide.").into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(tr("The pasted file is over 50 MB: drag it in instead.", "Le fichier collé dépasse 50 Mo : glisse-le plutôt.").into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    sweep(dir);
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    // Several files pasted at once share the millisecond: each takes the next free folder.
    let folder = (0..100)
        .map(|n| dir.join(format!("{stamp}-{n}")))
        .find(|f| std::fs::create_dir(f).is_ok())
        .ok_or_else(|| "no free folder for the pasted file".to_string())?;
    let path = folder.join(clean_name(name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Headers only carry ASCII: the UI encodes the name with `encodeURIComponent`.
pub fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A dropped folder gets its trailing "/": the composer then shows it as a folder.
pub fn mark_dirs(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .map(|p| if !p.ends_with('/') && Path::new(&p).is_dir() { format!("{p}/") } else { p })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_inside_the_folder() {
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name(".hidden"), "hidden");
        assert_eq!(clean_name("Capture d’écran 2026.png"), "Capture d-écran 2026.png");
        assert_eq!(clean_name("say \"hi\".txt"), "say -hi-.txt");
        assert_eq!(clean_name(""), "file");
        assert_eq!(clean_name("/"), "file");
    }

    #[test]
    fn decodes_header_names() {
        assert_eq!(percent_decode("Capture%20d%E2%80%99%C3%A9cran.png"), "Capture d’écran.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zz"), "a%zz");
    }

    #[test]
    fn saves_and_refuses_empty() {
        let dir = std::env::temp_dir().join(format!("bh-pasted-{}", std::process::id()));
        let path = save(&dir, "shot.png", b"png").unwrap();
        let again = save(&dir, "shot.png", b"png 2").unwrap();
        assert!(path.starts_with(&dir));
        assert_eq!(path.file_name().unwrap(), "shot.png");
        assert_ne!(path, again);
        assert_eq!(std::fs::read(&path).unwrap(), b"png");
        assert_eq!(std::fs::read(&again).unwrap(), b"png 2");
        assert!(save(&dir, "empty.png", b"").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folders_get_a_slash() {
        let dir = std::env::temp_dir().to_string_lossy().trim_end_matches('/').to_string();
        assert_eq!(mark_dirs(vec![dir.clone(), "/no/such/file.txt".into()]), vec![format!("{dir}/"), "/no/such/file.txt".into()]);
    }
}
