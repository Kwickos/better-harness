# Claude Desktop analysis: why it uses so much

Readings taken on November 7, 2026 on a MacBook Pro M1 Pro (8 cores, 16 GB of RAM), on macOS 27.0.1, with Claude Desktop **4.23118.0**.
Tools used: REA (`analyze_javascript_application` on `app.asar`), a manual extraction of the ASAR and of the Bun binary, then `ps`, `top` and `vm_stat`.

Each finding is tagged:
- **[observed]**: seen directly in the binary or on the machine;
- **[inferred]**: deduced from the observations, without direct proof;
- **[unknown]**: not checked.

## 1. Architecture

```
Claude.app (Electron 4.23118.0)
├── main process  (.vite/build/index.pre.js → index.chunk-*.js, ~13 MB of JS)
│   ├── WebContentsView "mainView": the UI (chat + Code tab)
│   ├── workers: file-index, heavy-work, transcript-search, pty-host,
│   │            shell-path, stall-sampler, mcp-runtime/directMcpHost
│   ├── embedded Agent SDK (index.chunk-CqnLpjST.js)
│   │     └── for EACH Code session:
│   │         disclaimer --pgroup -- …/claude-code/2.1.317/…/claude
│   │              --output-format stream-json --verbose --input-format stream-json …
│   │              ├── rea MCP server           (npm exec → node)
│   │              ├── touchdesigner MCP server (npm exec → node)
│   │              └── blender MCP server       (uv → python)
│   └── chat-side MCP servers (StudioMCP ×2, rea ×2, blender ×2…)
├── Claude Helper (GPU)
├── Claude Helper (Renderer) ×2
└── Claude Helper (Network, Audio, Video capture, Plugin…)
```

- **[observed]** The Code tab has no agent of its own. The main process embeds the **Agent SDK**, which starts a separate `claude` binary in `stream-json` mode for each session. The arguments are built in `index.chunk-CqnLpjST.js` (`["--output-format","stream-json","--verbose","--input-format","stream-json"]`, `--permission-prompt-tool=stdio`, `--resume`, `--thinking`, `--effort`…). REA evidence: `ev_bb4a6abe1b97…`. These processes also show up in `ps`.
- **[observed]** Desktop downloads **its own copies of the CLI** into `~/Library/Application Support/Claude/claude-code/`: 2.1.309 (263 MB) and 2.1.317 (312 MB). They come on top of the versions in `~/.local/share/claude/versions` (1.2 GB for 4 versions).
- **[observed]** The CLI is a 307 MB **Bun** executable. Its `__BUN` Mach-O section (186 MB) holds 3,147 modules: 2,900 JS files, i.e. 54.7 MB of source, plus about 108 MB of precompiled JSC bytecode. The entry point is `/$bunfs/root/cli`.
- **[observed]** The main window is served over the custom `app://localhost` protocol, with 36 references to `https://claude.ai` in the main process. **[inferred]** The chat UI and the Code tab are therefore the claude.ai web app (React), rendered by Chromium.

## 2. Where the CPU and RAM go

Measured while a Code session was streaming a reply (`top`, 4 × 4 s):

| Process | CPU | RAM |
|---|---:|---:|
| Claude Helper (Renderer): the web UI | **45%** | **893 MB** |
| WindowServer (macOS compositing) | **50%** | 551 MB |
| Claude Helper (GPU) | **17%** | 305 MB |
| Claude (main process) | 8.5% | 435 MB |
| `claude` CLI of the active session | 4.2% | 283 MB |

Machine state at the same time **[observed]**:
- 4 open CLI sessions, between 137 and 349 MB each;
- about 40 MB of MCP servers **duplicated per session**;
- all Claude.app processes together use 1.3 GB and 55% CPU;
- swap reaches **2.9 GB out of 4 GB**.

Conclusions:
1. **[observed]** The main cost comes from **rendering**, not from the agent. While streaming, Desktop's renderer and GPU use about 62% CPU, against 4% for the CLI doing the real work. WindowServer, at 50%, is shared with the other apps and is therefore not counted. **[inferred]** A good part of that cost still comes from Desktop's compositing.
2. **[observed]** There is **one CLI process per open session**, even idle. Each keeps 150 to 350 MB, and Desktop doesn't suspend them as long as the session stays open.
3. **[observed]** **Every stdio MCP server is restarted in each session**, often via `npx -y …`, which resolves the package on every start. claude.ai connectors and MCP tools also weigh on the context, since tool definitions cost tokens.
4. **[observed]** `backgroundThrottling` is disabled for the mainView in several cases: visible popouts, computer-use lock, startup, screen capture (`mainView backgroundThrottling disabled (visible popouts: …)`). In these cases the UI keeps rendering at full speed, even in the background.
5. **[observed]** There is also a disk cost: `~/Library/Application Support/Claude` weighs **14 GB**, 11 GB of it in `vm_bundles`, and `~/.claude/projects` holds **5.8 GB** of transcripts (up to 133 MB per session).

## 3. CLI protocol (verified)

- Launch: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`.
- The client first sends `{"type":"control_request","request_id":…,"request":{"subtype":"initialize"}}`. The answer is a `control_response` listing the available commands and skills. **[observed live]**
- The CLI then emits `system:init` (session_id, tools, mcp_servers, model), `system:status`, `rate_limit_event`, `stream_event` (deltas), `assistant`, `user` (tool_result) and `result`. **[observed live]**
- Permissions: the CLI sends a `can_use_tool` `control_request` (tool_name, input, tool_use_id, permission_suggestions…). The expected answer is `control_response{subtype:"success", response:{behavior:"allow", updatedInput, toolUseID}}` or `{behavior:"deny", message}`. **[observed in the SDK code; not yet tested live]** The account had hit its `seven_day` weekly limit.
- Other control requests used: `interrupt`, `set_permission_mode`, `set_model`, `get_context_usage`, `mcp_status`…

## 4. What Better Harness does differently

| Measured problem | Better Harness's answer |
|---|---|
| Chromium UI + claude.ai React (≈1.6 GB, ~62% CPU while streaming for the renderer and GPU) | Tauri: system WebKit, TypeScript UI without a framework (98 KB of JS), no animation, Markdown rendered once per finished message, `content-visibility: auto` |
| Deltas rendered continuously | Coalescing on the Rust side (40 ms), sent **only** for the displayed session while the window is visible |
| One live CLI per open session | Lazy spawn (no process before the first message), at most `max_live` processes, suspension after inactivity and transparent resume via `--resume` |
| MCP servers duplicated in each session | Per-session selection (`--strict-mcp-config --mcp-config`); the whole process **group** (CLI + MCP) is killed on suspension |
| Transcripts of 100 MB and more | List built by reading 64 KB at the start and end of each file; a transcript loads walking back from the end (24 MB cap) |
| All the raw JSON sent to the UI | Compact projection: tool results truncated to 6 KB for display (the CLI's jsonl stays complete) |

The measurements of the harness itself are in [`MEASUREMENTS.md`](MEASUREMENTS.md).
