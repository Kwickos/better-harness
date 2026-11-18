//! The MCP tool that ends a turn with a next-step box: a short recap, the question that is the
//! user's call, and one or two buttons. A button has a short label and the full message a click
//! sends back, so "Test first" can stand for a precise request. Served by the `harness` server
//! (`files_tool`), which reaches the model with no extra process. The UI reads the box from the
//! tool call's input; the tool only checks it and tells the model to finish its turn.

use serde_json::{json, Value};

pub const NAME: &str = "next_step";
pub const TOOL: &str = "mcp__harness__next_step";
/// Appended to the system prompt when the box is on: when to call the tool.
pub const PROMPT: &str = "When a turn leaves the user a decision or a step to take (a choice of approach, a go-ahead to \
commit, push, publish or apply a fix, an approval), call mcp__harness__next_step right before your closing message. \
It draws a box under that message with a short recap, your question and one or two buttons; a click sends you the \
button's message as the user's reply. Skip it for short answers, pure conversation and turns with nothing pending.";

const LABEL_MAX: usize = 24;
const ASK_MAX: usize = 160;
const RECAP_MAX: usize = 600;
const MESSAGE_MAX: usize = 2000;
const BUTTONS_MAX: usize = 2;

const DESCRIPTION: &str = "Ends a turn with a next-step box drawn under your closing message: a two-or-three-sentence \
recap, the one question that is the user's call, and one or two buttons that answer it. A button shows a short label; \
a click sends you its message as if the user had typed it. Call it once, right before your closing message, only when \
the turn leaves the user a decision or a step to take. Then write your closing message as usual, the last thing you \
say: the box already shows the question and the buttons, so don't list them again.";

pub fn tool() -> Value {
    json!({
        "name": NAME,
        "description": DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "recap": {
                    "type": "string",
                    "description": "Two or three short sentences, under 300 characters, in the user's language: what is now true or changed, then where it stands, including what is not done or not verified."
                },
                "ask": {
                    "type": "string",
                    "description": "The one decision that is the user's call, in one short sentence under 100 characters: no reason, no recommendation, no list of the options."
                },
                "buttons": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": BUTTONS_MAX,
                    "description": "One or two answers to ask, your recommendation first; a second only when it is a realistic alternative.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {
                                "type": "string",
                                "description": "The button's text: 1 to 3 words, at most 24 characters, in the user's language (\"Yes, commit\", \"Test first\")."
                            },
                            "message": {
                                "type": "string",
                                "description": "What a click sends you as the user's reply, in their language: the full request this answer stands for, with the details you will need to act on it (what to do, on what, what to check). One to three sentences."
                            }
                        },
                        "required": ["label", "message"]
                    }
                }
            },
            "required": ["recap", "ask", "buttons"]
        },
        "annotations": { "readOnlyHint": true },
        // Loaded with the other tools rather than deferred behind ToolSearch: it serves at the end of most turns.
        "_meta": { "anthropic/alwaysLoad": true }
    })
}

fn text<'a>(args: &'a Value, key: &str) -> &'a str {
    args[key].as_str().map(str::trim).unwrap_or("")
}

/// Checks the box. An error tells the model what to change, so it can call again.
pub fn run(args: &Value) -> Result<String, String> {
    let fail = |why: String| Err(format!("The box was not shown: {why}. Call next_step again with that fixed."));
    let recap = text(args, "recap");
    let ask = text(args, "ask");
    if recap.is_empty() {
        return fail("recap is empty".into());
    }
    if recap.chars().count() > RECAP_MAX {
        return fail(format!("recap is longer than {RECAP_MAX} characters"));
    }
    if ask.is_empty() {
        return fail("ask is empty, and the buttons answer a question".into());
    }
    if ask.chars().count() > ASK_MAX || ask.contains('\n') {
        return fail(format!("ask must be one line under {ASK_MAX} characters"));
    }
    let buttons = args["buttons"].as_array().map(Vec::as_slice).unwrap_or_default();
    if buttons.is_empty() || buttons.len() > BUTTONS_MAX {
        return fail(format!("give 1 or {BUTTONS_MAX} buttons, not {}", buttons.len()));
    }
    for (i, b) in buttons.iter().enumerate() {
        let n = i + 1;
        let label = text(b, "label");
        let message = text(b, "message");
        if label.is_empty() || label.chars().count() > LABEL_MAX || label.contains('\n') {
            return fail(format!("the label of button {n} must be 1 to 3 words, at most {LABEL_MAX} characters"));
        }
        if message.is_empty() {
            return fail(format!("button {n} has no message to send"));
        }
        if message.chars().count() > MESSAGE_MAX {
            return fail(format!("the message of button {n} is longer than {MESSAGE_MAX} characters"));
        }
    }
    Ok("Shown to the user. Now write your closing message, the last thing you say this turn; the box already shows the question and its buttons.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(buttons: Value) -> Value {
        json!({ "recap": "The card is in place. Nothing is committed.", "ask": "Commit and open the PR?", "buttons": buttons })
    }

    #[test]
    fn valid_box() {
        let ok = run(&args(json!([
            { "label": "Commit", "message": "Commit on this branch and open a PR to main." },
            { "label": "Test first", "message": "Run the app with the real CLI and check that the box shows after a turn." }
        ])));
        assert!(ok.is_ok());
    }

    #[test]
    fn refusals_say_what_to_fix() {
        let err = run(&args(json!([]))).unwrap_err();
        assert!(err.contains("give 1 or 2 buttons"));
        let long = run(&args(json!([{ "label": "A label far too long for a button", "message": "x" }]))).unwrap_err();
        assert!(long.contains("label of button 1"));
        let empty = run(&args(json!([{ "label": "Go", "message": " " }]))).unwrap_err();
        assert!(empty.contains("no message"));
        let no_ask = run(&json!({ "recap": "Done.", "buttons": [{ "label": "Go", "message": "Go on." }] })).unwrap_err();
        assert!(no_ask.contains("ask is empty"));
    }

    #[test]
    fn listed_without_deferral() {
        assert_eq!(tool()["_meta"]["anthropic/alwaysLoad"], true);
        assert_eq!(format!("mcp__{}__{NAME}", crate::files_tool::SERVER), TOOL);
    }
}
