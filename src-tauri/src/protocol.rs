//! Translation of the claude CLI's stream-json messages into compact UI events.
//! Formats observed on CLI 2.1.319 and on the Agent SDK embedded in Claude Desktop.

use crate::events::{ArtifactRef, Block};
use crate::i18n::tr;
use serde_json::{json, Value};

/// Max size of a tool result sent to the UI (the rest stays in the CLI's jsonl).
pub const TOOL_RESULT_MAX: usize = 6_000;
/// Max size of a displayed tool input.
pub const TOOL_INPUT_MAX: usize = 4_000;
const EDIT_INPUT_MAX: usize = 32_000;

/// Diff, question, plan or attached files: the UI reads these inputs, they must stay complete JSON.
pub fn tool_input_max(tool: &str) -> usize {
    if matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "AskUserQuestion" | "ExitPlanMode" | crate::files_tool::TOOL) {
        EDIT_INPUT_MAX
    } else {
        TOOL_INPUT_MAX
    }
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Keeps the start and end of a text that is too long.
pub fn truncate_middle(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let head = floor_boundary(s, max * 2 / 3);
    let tail = ceil_boundary(s, s.len() - (max - max * 2 / 3));
    let hidden = tail - head;
    let (start, end) = (&s[..head], &s[tail..]);
    (
        tr(
            format!("{start}\n\n… [{hidden} bytes hidden] …\n\n{end}"),
            format!("{start}\n\n… [{hidden} octets masqués] …\n\n{end}"),
        ),
        true,
    )
}

pub fn one_line(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// One-line summary of a tool call (command, file, pattern…).
pub fn tool_summary(name: &str, input: &Value) -> String {
    let pick = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let s = match name {
        "Bash" => pick("command"),
        "Read" | "Write" | "Edit" | "MultiEdit" => pick("file_path"),
        "NotebookEdit" => pick("notebook_path"),
        "Glob" | "Grep" => pick("pattern"),
        "WebFetch" => pick("url"),
        "WebSearch" => pick("query"),
        "Task" | "Agent" => pick("description"),
        "Skill" => pick("skill"),
        _ => None,
    }
    .or_else(|| {
        input
            .as_object()
            .and_then(|o| o.values().find_map(|v| v.as_str().map(str::to_string)))
    });
    one_line(&s.unwrap_or_default(), 160)
}

/// Converts the content of an assistant message into UI blocks.
pub fn assistant_blocks(content: &Value) -> Vec<Block> {
    let mut out = Vec::new();
    let Some(arr) = content.as_array() else {
        if let Some(t) = content.as_str() {
            out.push(Block::Text { text: t.to_string() });
        }
        return out;
    };
    for b in arr {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                let t = b.get("text").and_then(Value::as_str).unwrap_or("");
                if !t.is_empty() {
                    out.push(Block::Text { text: t.to_string() });
                }
            }
            Some("thinking") => {
                let t = b.get("thinking").and_then(Value::as_str).unwrap_or("");
                if !t.is_empty() {
                    out.push(Block::Thinking { text: t.to_string() });
                }
            }
            Some("tool_use") | Some("server_tool_use") => {
                let name = b.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
                let input = b.get("input").cloned().unwrap_or(Value::Null);
                let pretty = serde_json::to_string_pretty(&input).unwrap_or_default();
                out.push(Block::Tool {
                    id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    summary: tool_summary(&name, &input),
                    input: truncate_middle(&pretty, tool_input_max(&name)).0,
                    name,
                });
            }
            _ => {}
        }
    }
    out
}

/// The artifact a tool's structured result points to (`tool_use_result` live, `toolUseResult` in a transcript).
pub fn artifact_ref(result: Option<&Value>) -> Option<ArtifactRef> {
    let result = result?;
    let url = result.get("url")?.as_str()?;
    if !(url.starts_with("https://claude.ai/artifact/") || url.starts_with("https://claude.ai/code/artifact/")) {
        return None;
    }
    let text = |key: &str| result.get(key).and_then(Value::as_str).map(str::to_string);
    Some(ArtifactRef { url: url.to_string(), title: text("title"), path: text("path") })
}

/// Text of a tool_result block (string or list of blocks).
pub fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for it in items {
                match it.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        parts.push(it.get("text").and_then(Value::as_str).unwrap_or("").to_string())
                    }
                    Some("image") => parts.push("[image]".into()),
                    Some(other) => parts.push(format!("[{other}]")),
                    None => {}
                }
            }
            parts.join("\n")
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Text typed by the user in a `user` message (tool_result excluded).
pub fn user_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let texts: Vec<&str> = items
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        }
        _ => None,
    }
}

pub fn user_message(text: &str) -> Value {
    json!({
        "type": "user",
        "session_id": "",
        "parent_tool_use_id": null,
        "message": { "role": "user", "content": text }
    })
}

pub fn control_request(request_id: &str, request: Value) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": request })
}

pub fn control_success(request_id: &str, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response }
    })
}

pub fn control_error(request_id: &str, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_keeps_char_boundaries() {
        let s = "é".repeat(5000);
        let (t, cut) = truncate_middle(&s, 1001);
        assert!(cut);
        assert!(t.contains("bytes hidden"));
    }

    #[test]
    fn summary_for_bash() {
        let v = json!({"command": "ls -la\npwd", "description": "x"});
        assert_eq!(tool_summary("Bash", &v), "ls -la pwd");
    }

    #[test]
    fn blocks_from_content() {
        let c = json!([
            {"type":"thinking","thinking":"hmm"},
            {"type":"text","text":"Hello"},
            {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/b.rs"}}
        ]);
        let b = assistant_blocks(&c);
        assert_eq!(b.len(), 3);
        match &b[2] {
            Block::Tool { summary, .. } => assert_eq!(summary, "/a/b.rs"),
            _ => panic!(),
        }
    }

    #[test]
    fn artifact_read_from_structured_result() {
        let file = json!({"url":"https://claude.ai/artifact/abc","path":"/tmp/a.html","artifact_id":"x","title":"Scouting"});
        assert_eq!(
            artifact_ref(Some(&file)),
            Some(ArtifactRef { url: "https://claude.ai/artifact/abc".into(), title: Some("Scouting".into()), path: Some("/tmp/a.html".into()) })
        );
        let from_type = json!({"created_from_type":true,"url":"https://claude.ai/artifact/def","title":"Mockups"});
        assert_eq!(artifact_ref(Some(&from_type)).unwrap().path, None);
        // Another tool's result is not an artifact.
        assert_eq!(artifact_ref(Some(&json!({"url":"https://example.com/artifact/abc"}))), None);
        assert_eq!(artifact_ref(Some(&json!({"type":"text","file":{"filePath":"/tmp/a"}}))), None);
        assert_eq!(artifact_ref(None), None);
    }

    #[test]
    fn tool_result_array() {
        let c = json!([{"type":"text","text":"a"},{"type":"image"}]);
        assert_eq!(tool_result_text(&c), "a\n[image]");
    }
}
