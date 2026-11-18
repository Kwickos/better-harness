//! Reading the CLI history in ~/.claude/projects/<encoded cwd>/<id>.jsonl.
//! These files sometimes exceed 100 MB: only the start and end are read for
//! the list, and a transcript is loaded by walking back from the end.

use crate::events::UiEvent;
use crate::i18n::tr;
use crate::protocol::{assistant_blocks, tool_result_text, truncate_middle, user_text, TOOL_RESULT_MAX};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const PEEK: u64 = 64 * 1024;
/// Cap on bytes read to rebuild a transcript.
const TAIL_BUDGET: u64 = 24 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub cli_id: String,
    pub cwd: String,
    pub title: String,
    pub mtime_ms: u64,
    pub size: u64,
}

pub fn projects_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude/projects")
}

fn read_range(f: &mut File, start: u64, len: u64) -> Vec<u8> {
    let mut buf = vec![0; len as usize];
    if f.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let n = f.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    buf
}

fn first_prompt(v: &Value) -> Option<String> {
    if v.get("type")?.as_str()? != "user" || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let t = user_text(v.get("message")?.get("content")?)?;
    let t = t.trim();
    if t.is_empty() || t.starts_with('<') {
        return None;
    }
    Some(crate::protocol::one_line(t, 90))
}

fn summarize(path: &Path) -> Option<HistoryEntry> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    let mut f = File::open(path).ok()?;
    let head = read_range(&mut f, 0, PEEK.min(size));
    let tail = if size > PEEK { read_range(&mut f, size - PEEK, PEEK) } else { vec![] };

    let (mut cwd, mut prompt, mut custom, mut ai) = (None, None, None, None);
    for chunk in [&head, &tail] {
        for line in String::from_utf8_lossy(chunk).lines() {
            let fast_title = line.contains("\"custom-title\"") || line.contains("\"ai-title\"");
            if !(fast_title || (cwd.is_none() || prompt.is_none()) && line.contains("\"cwd\"")) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            match v.get("type").and_then(Value::as_str) {
                Some("custom-title") => custom = v.get("customTitle").and_then(Value::as_str).map(str::to_string),
                Some("ai-title") => ai = v.get("aiTitle").and_then(Value::as_str).map(str::to_string),
                _ => {
                    if cwd.is_none() {
                        cwd = v.get("cwd").and_then(Value::as_str).map(str::to_string);
                    }
                    if prompt.is_none() {
                        prompt = first_prompt(&v);
                    }
                }
            }
        }
    }
    let title = custom.or(ai).or(prompt)?;
    Some(HistoryEntry {
        cli_id: path.file_stem()?.to_string_lossy().into_owned(),
        cwd: cwd.unwrap_or_default(),
        title,
        mtime_ms,
        size,
    })
}

/// Recent sessions, sorted by date. `query` filters on the title and folder;
/// conversations in `hidden` (archived) are skipped.
pub fn list(limit: usize, query: Option<&str>, hidden: &HashSet<String>) -> Vec<HistoryEntry> {
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    let Ok(dirs) = std::fs::read_dir(projects_dir()) else { return vec![] };
    for d in dirs.flatten() {
        let Ok(entries) = std::fs::read_dir(d.path()) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if p.file_stem().is_some_and(|s| hidden.contains(&*s.to_string_lossy())) {
                continue;
            }
            if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                let ms = m.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
                files.push((ms, p));
            }
        }
    }
    files.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let q = query.map(|q| q.to_lowercase()).filter(|q| !q.is_empty());
    let scan = if q.is_some() { 600 } else { limit * 2 };
    files
        .into_iter()
        .take(scan)
        .filter_map(|(_, p)| summarize(&p))
        .filter(|e| match &q {
            Some(q) => e.title.to_lowercase().contains(q) || e.cwd.to_lowercase().contains(q),
            None => true,
        })
        .take(limit)
        .collect()
}

/// Summaries of a list of conversations (the archive), newest first.
pub fn entries(ids: &HashSet<String>) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = ids.iter().filter_map(|id| summarize(&find_file(id)?)).collect();
    out.sort_unstable_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

fn valid_id(cli_id: &str) -> bool {
    !cli_id.is_empty() && !cli_id.contains('/') && !cli_id.contains("..")
}

/// A conversation's files: its transcript and its side folder (subagents, tool results).
fn conversation_paths(cli_id: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if !valid_id(cli_id) {
        return paths;
    }
    let Ok(dirs) = std::fs::read_dir(projects_dir()) else { return paths };
    for d in dirs.flatten() {
        let (file, annex) = (d.path().join(format!("{cli_id}.jsonl")), d.path().join(cli_id));
        if file.is_file() {
            paths.push(file);
        }
        if annex.is_dir() {
            paths.push(annex);
        }
    }
    paths
}

/// Moves a conversation to the Trash: it stays recoverable from the Finder.
pub fn trash(cli_id: &str) -> Result<(), String> {
    let paths = conversation_paths(cli_id);
    if paths.is_empty() {
        return Ok(());
    }
    to_trash(&paths)
}

pub fn to_trash(paths: &[PathBuf]) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // NSFileManager: no Finder permission to ask for, no trash sound.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete_all(paths).map_err(|e| tr(format!("Could not move to the Trash: {e}"), format!("Impossible de mettre à la corbeille : {e}")))
}

pub fn find_file(cli_id: &str) -> Option<PathBuf> {
    if !valid_id(cli_id) {
        return None;
    }
    let name = format!("{cli_id}.jsonl");
    std::fs::read_dir(projects_dir())
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| p.is_file())
}

/// Last modification date of a session's transcript (ms since the epoch).
pub fn mtime_ms(cli_id: &str) -> Option<u64> {
    let m = std::fs::metadata(find_file(cli_id)?).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Reads the last `want` useful lines of the file, walking back from the end.
fn tail_lines(path: &Path, want: usize) -> (Vec<String>, bool) {
    let Ok(mut f) = File::open(path) else { return (vec![], false) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let keep = |l: &str| {
        (l.contains("\"type\":\"user\"") || l.contains("\"type\":\"assistant\""))
            && !l.contains("\"isSidechain\":true")
            && !l.contains("\"isMeta\":true")
    };
    let mut pos = size;
    let mut carry: Vec<u8> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut read_total = 0u64;
    const CHUNK: u64 = 256 * 1024;
    while pos > 0 && out.len() < want && read_total < TAIL_BUDGET {
        let start = pos.saturating_sub(CHUNK);
        let mut buf = read_range(&mut f, start, pos - start);
        read_total += buf.len() as u64;
        buf.extend_from_slice(&carry);
        let mut lines: Vec<&[u8]> = buf.split(|b| *b == b'\n').collect();
        // The chunk's first line may be incomplete: keep it for the next round.
        let first = if start > 0 { lines.remove(0).to_vec() } else { vec![] };
        for l in lines.into_iter().rev() {
            if out.len() >= want {
                break;
            }
            if let Ok(s) = std::str::from_utf8(l) {
                if keep(s) {
                    out.push(s.to_string());
                }
            }
        }
        carry = first;
        pos = start;
    }
    out.reverse();
    (out, pos > 0)
}

/// Rebuilds a session's last messages as UI events.
pub fn load(sid: &str, cli_id: &str, want: usize) -> (Vec<UiEvent>, bool) {
    let Some(path) = find_file(cli_id) else { return (vec![], false) };
    let (lines, more) = tail_lines(&path, want);
    let mut ev = Vec::with_capacity(lines.len());
    for l in lines {
        let Ok(v) = serde_json::from_str::<Value>(&l) else { continue };
        let Some(msg) = v.get("message") else { continue };
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let blocks = assistant_blocks(&content);
                if !blocks.is_empty() {
                    ev.push(UiEvent::Assistant {
                        sid: sid.into(),
                        id: msg.get("id").and_then(Value::as_str).unwrap_or("").into(),
                        parent: None,
                        blocks,
                    });
                }
            }
            Some("user") => {
                if let Some(arr) = content.as_array() {
                    for b in arr {
                        if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                            let raw = tool_result_text(b.get("content").unwrap_or(&Value::Null));
                            let (text, truncated) = truncate_middle(&raw, TOOL_RESULT_MAX);
                            ev.push(UiEvent::ToolResult {
                                sid: sid.into(),
                                tool_use_id: b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").into(),
                                parent: None,
                                is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                                text,
                                truncated,
                                artifact: crate::protocol::artifact_ref(v.get("toolUseResult")),
                            });
                        }
                    }
                }
                if let Some(t) = user_text(&content) {
                    if !t.trim().is_empty() {
                        ev.push(UiEvent::User { sid: sid.into(), text: t });
                    }
                }
            }
            _ => {}
        }
    }
    (ev, more)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake HOME: these tests must never touch the real history.
    fn fake_home() -> PathBuf {
        let home = std::env::temp_dir().join(format!("bh-history-{}", uuid::Uuid::new_v4()));
        let project = home.join(".claude/projects/-tmp-demo");
        std::fs::create_dir_all(project.join("aaa/subagents")).unwrap();
        let line = |title: &str| format!("{{\"type\":\"custom-title\",\"customTitle\":\"{title}\"}}\n{{\"type\":\"user\",\"cwd\":\"/tmp/demo\",\"message\":{{\"content\":\"hello\"}}}}\n");
        std::fs::write(project.join("aaa.jsonl"), line("First")).unwrap();
        std::fs::write(project.join("bbb.jsonl"), line("Second")).unwrap();
        std::env::set_var("HOME", &home);
        home
    }

    #[test]
    fn archives_deletion_paths_and_listing() {
        let home = fake_home();
        assert_eq!(projects_dir(), home.join(".claude/projects"));

        // An archived conversation leaves the list but stays readable in the archive.
        let hidden: HashSet<String> = ["aaa".to_string()].into();
        let titles: Vec<_> = list(10, None, &hidden).into_iter().map(|e| e.title).collect();
        assert_eq!(titles, ["Second"]);
        assert_eq!(list(10, None, &HashSet::new()).len(), 2);
        let archived = entries(&hidden);
        assert_eq!((archived.len(), archived[0].title.as_str()), (1, "First"));

        // Deletion targets the transcript and its side folder, nothing else.
        let project = home.join(".claude/projects/-tmp-demo");
        let mut paths = conversation_paths("aaa");
        paths.sort();
        assert_eq!(paths, [project.join("aaa"), project.join("aaa.jsonl")]);
        assert_eq!(conversation_paths("bbb"), [project.join("bbb.jsonl")]);

        // Hostile IDs: no path comes out of them.
        for id in ["", "..", "../..", "a/b", "../-tmp-demo/aaa"] {
            assert!(conversation_paths(id).is_empty(), "{id}");
        }
        assert!(trash("../-tmp-demo/aaa").is_ok());
        assert!(project.join("aaa.jsonl").is_file());
        let _ = std::fs::remove_dir_all(home);
    }

    /// Puts a real test file in the Trash: run by hand with `--ignored`.
    #[test]
    #[ignore]
    fn trash_moves_files_out() {
        let home = fake_home();
        let project = home.join(".claude/projects/-tmp-demo");
        trash("aaa").unwrap();
        assert!(!project.join("aaa.jsonl").exists());
        assert!(!project.join("aaa").exists());
        assert!(project.join("bbb.jsonl").is_file());
        let _ = std::fs::remove_dir_all(home);
    }
}
