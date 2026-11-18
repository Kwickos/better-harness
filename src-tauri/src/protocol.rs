//! Traduction des messages stream-json du CLI claude en événements UI compacts.
//! Formats relevés sur le CLI 2.1.319 et sur l'Agent SDK embarqué dans Claude Desktop.

use crate::events::{ArtifactRef, Block};
use serde_json::{json, Value};

/// Taille max d'un résultat d'outil envoyé à l'UI (le reste reste dans le jsonl du CLI).
pub const TOOL_RESULT_MAX: usize = 6_000;
/// Taille max de l'entrée d'un outil affichée.
pub const TOOL_INPUT_MAX: usize = 4_000;
const EDIT_INPUT_MAX: usize = 32_000;

/// Diff, question, plan ou fichiers joints : l'interface lit ces entrées, elles doivent rester un JSON complet.
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

/// Garde le début et la fin d'un texte trop long.
pub fn truncate_middle(s: &str, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s.to_string(), false);
    }
    let head = floor_boundary(s, max * 2 / 3);
    let tail = ceil_boundary(s, s.len() - (max - max * 2 / 3));
    let hidden = tail - head;
    (
        format!("{}\n\n… [{} octets masqués] …\n\n{}", &s[..head], hidden, &s[tail..]),
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

/// Résumé d'une ligne pour un appel d'outil (commande, fichier, motif…).
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

/// Convertit le contenu d'un message assistant en blocs UI.
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

/// L'artefact désigné par le résultat structuré d'un outil (`tool_use_result` en direct, `toolUseResult` dans un transcript).
pub fn artifact_ref(result: Option<&Value>) -> Option<ArtifactRef> {
    let result = result?;
    let url = result.get("url")?.as_str()?;
    if !(url.starts_with("https://claude.ai/artifact/") || url.starts_with("https://claude.ai/code/artifact/")) {
        return None;
    }
    let text = |key: &str| result.get(key).and_then(Value::as_str).map(str::to_string);
    Some(ArtifactRef { url: url.to_string(), title: text("title"), path: text("path") })
}

/// Texte d'un bloc tool_result (chaîne ou liste de blocs).
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

/// Texte saisi par l'utilisateur dans un message `user` (hors tool_result).
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
        assert!(t.contains("octets masqués"));
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
            {"type":"text","text":"Salut"},
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
    fn artefact_lu_dans_le_resultat_structure() {
        let file = json!({"url":"https://claude.ai/artifact/abc","path":"/tmp/a.html","artifact_id":"x","title":"Repérage"});
        assert_eq!(
            artifact_ref(Some(&file)),
            Some(ArtifactRef { url: "https://claude.ai/artifact/abc".into(), title: Some("Repérage".into()), path: Some("/tmp/a.html".into()) })
        );
        let from_type = json!({"created_from_type":true,"url":"https://claude.ai/artifact/def","title":"Maquettes"});
        assert_eq!(artifact_ref(Some(&from_type)).unwrap().path, None);
        // Le résultat d'un autre outil n'est pas un artefact.
        assert_eq!(artifact_ref(Some(&json!({"url":"https://exemple.fr/artifact/abc"}))), None);
        assert_eq!(artifact_ref(Some(&json!({"type":"text","file":{"filePath":"/tmp/a"}}))), None);
        assert_eq!(artifact_ref(None), None);
    }

    #[test]
    fn tool_result_array() {
        let c = json!([{"type":"text","text":"a"},{"type":"image"}]);
        assert_eq!(tool_result_text(&c), "a\n[image]");
    }
}
