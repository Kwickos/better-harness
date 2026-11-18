#!/usr/bin/env python3
"""Fake `claude` binary that speaks the stream-json protocol, to test the
harness without using quota. It reproduces the sequence observed on the real
CLI 2.1.319: response to `initialize`, system:init, text deltas, tool call
with a permission request (can_use_tool), tool_result then result.

Usage: in Settings, claude binary path = <repo>/scripts/fake-claude.py
"""
import json
import sys
import time
import uuid

args = sys.argv[1:]
resume = args[args.index("--resume") + 1] if "--resume" in args else None
session_id = resume or str(uuid.uuid4())
partial = "--include-partial-messages" in args


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    return json.loads(line) if line.strip() else None


def stream_text(text, delay=0.012):
    if not partial:
        return
    for i in range(0, len(text), 6):
        send({"type": "stream_event", "parent_tool_use_id": None,
              "event": {"type": "content_block_delta", "index": 0,
                        "delta": {"type": "text_delta", "text": text[i:i + 6]}}})
        time.sleep(delay)


turn = 0
while True:
    msg = read()
    if msg is None:
        break
    if msg.get("type") == "control_request":
        sub = msg["request"].get("subtype")
        send({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"],
                                                        "response": {"commands": []}}})
        if sub == "initialize":
            send({"type": "system", "subtype": "init", "session_id": session_id, "cwd": ".",
                  "model": "fake-model", "tools": ["Bash", "Read", "Edit"], "permissionMode": "default",
                  "mcp_servers": [{"name": "demo", "status": "connected"}]})
        continue
    if msg.get("type") != "user":
        continue
    turn += 1
    t0 = time.time()
    prompt = msg["message"]["content"]
    mid = f"msg_{uuid.uuid4().hex[:10]}"
    send({"type": "system", "subtype": "status", "status": "requesting"})
    if "lon" in prompt.lower():  # "long" (tolerates truncated input)
        # Measurement mode: ~20 s of continuous streaming (≈80 deltas/s), no tool.
        para = ("The harness coalesces deltas on the Rust side and only renders the visible session. "
                "This paragraph measures the CPU cost of rendering during a long reply. ")
        text = "".join(f"## Section {i}\n\n{para * 3}\n\n- point A\n- point B\n\n" for i in range(1, 25))
        stream_text(text, delay=0.012)
        send({"type": "assistant", "parent_tool_use_id": None,
              "message": {"id": mid, "content": [{"type": "text", "text": text}]}})
        send({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1,
              "duration_ms": int((time.time() - t0) * 1000), "total_cost_usd": 0, "session_id": session_id,
              "result": "", "usage": {"input_tokens": 100, "output_tokens": len(text) // 4}})
        continue
    intro = f"Looking into it (turn {turn}). You wrote: \"{prompt[:80]}\".\n\nI'll list the folder."
    stream_text(intro)
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": mid, "content": [{"type": "text", "text": intro}]}})
    tool_id = f"toolu_{uuid.uuid4().hex[:10]}"
    tool_input = {"command": "ls -la", "description": "List the folder"}
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": mid, "content": [{"type": "tool_use", "id": tool_id, "name": "Bash", "input": tool_input}]}})
    send({"type": "control_request", "request_id": f"perm-{turn}",
          "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": tool_input,
                      "tool_use_id": tool_id, "permission_suggestions": [
                          {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "ls:*"}],
                           "behavior": "allow", "destination": "session"}]}})
    decision = None
    while decision is None:
        r = read()
        if r is None:
            sys.exit(0)
        if r.get("type") == "control_response":
            decision = r["response"]["response"]
    allowed = decision.get("behavior") == "allow"
    out = "total 8\ndrwxr-xr-x  3 user staff  96 .\n-rw-r--r--  1 user staff 120 README.md" if allowed else decision.get("message", "denied")
    send({"type": "user", "parent_tool_use_id": None,
          "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id,
                                                   "content": out, "is_error": not allowed}]}})
    final = ("Here are the contents:\n\n```\n" + out + "\n```\n\n| File | Size |\n|---|---|\n| README.md | 120 B |\n\n"
             "**Done.**") if allowed else "OK, I won't run the command."
    mid2 = f"msg_{uuid.uuid4().hex[:10]}"
    stream_text(final)
    send({"type": "assistant", "parent_tool_use_id": None,
          "message": {"id": mid2, "content": [{"type": "text", "text": final}]}})
    send({"type": "result", "subtype": "success", "is_error": False, "num_turns": 2,
          "duration_ms": int((time.time() - t0) * 1000), "total_cost_usd": 0.0012, "session_id": session_id,
          "result": final, "usage": {"input_tokens": 1200, "cache_read_input_tokens": 3400, "output_tokens": 180}})
