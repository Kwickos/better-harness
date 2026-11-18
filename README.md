English · [Français](README.fr.md)

# Better Harness

Better Harness is a lightweight harness for the `claude` CLI, built to replace the **Code** tab of Claude Desktop on a Mac that can't keep up.

The engine stays the same: the **official `claude` CLI**, driven in `stream-json` exactly the way the Agent SDK embedded in Desktop does it. You keep your subscription, tools, skills, hooks, plugins and MCP servers. Only the layer around it changes, to be much leaner:
- the interface;
- process management;
- MCP servers.

The why, with numbers: [`docs/ANALYSIS.md`](docs/ANALYSIS.md). The harness measurements: [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md).

## Run

Requirements: Rust ≥ 1.80, Node ≥ 20, and the `claude` CLI installed and signed in (`claude` must work in a terminal).

```bash
npm install
```

```bash
npm run app
```

`npm run app` starts the app in development mode. To build `Better Harness.app` (in `src-tauri/target/release/bundle/macos/`):

```bash
npm run bundle
```

To test without using quota, set **Settings → claude binary path** to `scripts/fake-claude.py`. It's a fake CLI that speaks the same protocol: streaming, tool call, permission request and result. A message containing "long" triggers 20 s of continuous streaming, for measurements.

### Diagnostics

- **Protocol log.** Start the app with the `BH_PROTOCOL_LOG` variable. Every line exchanged with the CLI is written to it, timestamped (`→` sent, `←` received).

  ```bash
  open --env BH_PROTOCOL_LOG=/tmp/bh-protocol.log "src-tauri/target/release/bundle/macos/Better Harness.app"
  ```

- **Silent CLI.** If the CLI doesn't respond within 20 s of starting, a notice shows the end of its stderr.
- **macOS access prompts.** macOS asks for permission the first time the app accesses a protected folder (Documents, Desktop…). With an ad hoc signature, the prompt comes back **after every rebuild**. Until it is answered, the CLI waits. To avoid repeated prompts, sign the app with a stable certificate (`bundle.macOS.signingIdentity` in `tauri.conf.json`).

## Install

Download `Better-Harness_<version>_universal.dmg` from the [releases](https://github.com/Kwickos/better-harness/releases/latest). The app is universal (Apple Silicon and Intel) and runs on **macOS 13 Ventura** and later (13.7.8 included).

It isn't notarized by Apple: on first launch, **right-click → Open** the app in the Applications folder, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/Better Harness.app"
```

## Updates

The app checks for a new version 20 s after launch, then every 6 hours. It reads `latest.json` from the latest release of this repository. A new version downloads in the background and its signature is verified. Then an **Update** button appears at the bottom of the sidebar. If you don't click it, the update installs when the app quits. **Settings → About** also lets you check by hand.

The **Update channel** setting in the same place picks what you receive. **Stable** (default) reads the latest release. **Beta** takes the newest release, beta or stable, through the GitHub API. Going back to stable keeps the installed beta until a higher stable version comes out: updates never go back.

The `claude` CLI is kept up to date too: 40 s after launch, then every 6 hours, the app runs `claude update`, which updates it the way it was installed and on its update channel. Running conversations keep their version until their next start. **Settings → General → Update automatically** turns this off, and **Settings → About** runs it by hand.

### Publish a version

Versions are published from this Mac, under the **Kwickos** GitHub account only, from an up-to-date `main`:

```bash
npm run release -- 0.2.0 "What changed"
```

A beta is written `0.3.0-beta.1`: it is published as a pre-release, offered only to apps on the beta channel.

The script stops if gh, git or the remote aren't Kwickos, if there are uncommitted changes, or if the GitHub protections have changed. Then, in order:

1. it bumps the version in `package.json`, `Cargo.toml` and `tauri.conf.json`, on a `release/v<version>` branch;
2. it builds the universal app;
3. it checks that each binary runs on macOS 13;
4. it signs the update package with `~/.tauri/better-harness.key` (password in the Keychain, item "better-harness updater key");
5. it opens the `release: v<version>` PR, waits for CI, then squash-merges it;
6. it tags that commit on `main`, then creates the release with the `.dmg`, the `.app.tar.gz` and `latest.json`;
7. it moves the `beta` branch onto it, and `stable` too for a stable version.

**Back up the key and its password.** Without them, installed apps can no longer update.

Branches, PRs, CI and GitHub protections: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What makes it light

- **No Chromium.** The app uses the system WebKit through Tauri. The UI is TypeScript without a framework (about 220 KB of JS, 75 KB compressed).
- **Lighter tools.** `Workflow` and `ScheduleWakeup` (used by `/loop`) are removed by default: about 5,000 fewer tokens on every request (39,500 → 34,400, measured with `get_context_usage`). A checkbox in Settings brings them back.
- **Coalesced streaming.** Text being generated is batched on the Rust side: 25 sends per second at most. It is only sent for the session on screen, and only while the window is visible.
- **Processes on demand:**
  - no `claude` process starts before your first message;
  - at most *N* processes live at the same time (3 by default);
  - an idle session is suspended after *X* minutes (10 by default);
  - the next message resumes it automatically via `--resume`.
- **MCP à la carte.** For each session, you pick "standard configuration" or "only the checked ones" (`--strict-mcp-config`). On suspension, the whole process group is killed, MCP servers included.
- **History without loading everything.** The list reads 64 KB at the start and at the end of each file in `~/.claude/projects`; a transcript loads starting from the end.
- **Built-in memory meter.** The bottom left shows the memory of the Rust core and of each session (CLI + MCP). WebKit processes aren't counted.

## Features

- **Conversations by project.** The sidebar groups the open conversations and the history from `~/.claude/projects`. The order only changes on real activity, not when you open a conversation.
- **New conversation without a dialog.** You pick the folder in the composer (recent folders or the native picker), type, and send. The conversation is created on the first message.
- **Worktrees, as in Claude Desktop.** In a git repository, the composer offers *Local* or *Worktree*. A worktree conversation works in `<repo>/.claude/worktrees/<name>`, on its own branch `<prefix>/<name>` (prefix `claude` by default, set in Settings), from the branch you pick. The untracked files listed in `.worktreeinclude` (`.env`…) are copied into it. It sits with its project in the sidebar, and the header shows its branch. Archiving or deleting the conversation removes a clean worktree; one with uncommitted changes stays on disk, and Settings → Worktrees removes it (its changes go to the Trash). A branch with commits of its own is always kept, and reopening the conversation brings its worktree back.
- **Live Markdown.** Only the last block is recomputed while text is being written.
- **Activity lines.** Consecutive tool calls collapse, for example into "2 files read, 1 command". While they run, the line shows the current step.
- **Model and effort.** The models offered are the ones the CLI returns (`initialize`), all of them, with no list written in the app: at launch, when no list is known yet or the CLI version changed, it asks the CLI before any conversation. There are 5 effort levels, applied live via `apply_flag_settings`, as in Claude Desktop.
- **Opus advisor.** In the model menu, per conversation: the chosen model does the work and consults Opus at key moments (`--advisor opus` at launch, `advisorModel` live). Off by default.
- **Agent world.** Above the input field, each Claude in the conversation is an animal (fox for Opus, cat for Sonnet, rabbit for Haiku, puppy for Fable) that walks to the station of what it is doing and says so in a bubble; subagents come in through the door and come back to report. Measured cost, window visible: about +2% CPU at rest (4 frames per second when everyone is asleep, 12 otherwise), nothing when the window is hidden. Can be turned off in Settings.
- **Context gauge.** The breakdown by category (`get_context_usage`) is one click away, along with the "Compact" action.
- **Projects.** Reorder them by dragging their header (or `⌥↑` / `⌥↓`), collapse them with a click. A collapsed project still shows the signal of its running or waiting conversations.
- **No folder.** A conversation can start without a project: the CLI then works in a dedicated app folder, grouped under "No folder".
- **Model and effort.** By default, the ones the CLI would apply (`model` and `effortLevel` from its user, project and local settings), unless chosen in Settings. A choice made in the composer only applies to the current conversation.
- **Changes** (`⌘⇧D`). The files changed according to Git, with their diff, reveal in Finder, and restore to the last version (the current version goes to the Trash). The `Edit` and `Write` tools also show their diff in the steps and in the permission request.
- **Mentions.** In the composer, `/` suggests the skills and commands the CLI has loaded, with their description; `@` suggests the project's files and folders, the other known projects, or the contents of an absolute path (`@/Users/…`).
- **Questions and plans.** When the model asks a question (`AskUserQuestion`), a card shows the questions one by one: pick one option, several, or write your own answer. A plan (`ExitPlanMode`) is shown as Markdown, to approve or reject.
- **Message actions.** On hover: copy and edit a sent message, copy a reply or retry.
- **Copy.** A button on hover over code blocks, tool outputs, diffs (the new code) and logs.
- **Archives.** Archiving hides a conversation without touching its file; deleting sends it to the Trash.
- **Automatic titles.** The CLI sums up the first message as a short title, written to its transcript: it stays when the conversation is reopened and shows up in Claude Code. If that fails, the start of the message is used as the title.
- **Artifacts** (`⌘⇧A`). Pages published by Claude open in the panel, without a claude.ai session while the HTML file is still there, and on claude.ai otherwise. The button only shows for a conversation that has some. You can switch artifact, reload, copy the link, and delete after confirmation.
- **iOS Simulator** (`⌘⇧M`). The live screen of a simulator in the right panel: tap, drag, edge gestures (home, back, Control Center) and physical keyboard. A screenshot attaches to the message in one click. You can boot and shut down the device, and switch between light and dark. The bridge (`helper/sim-bridge.swift`) only runs while the tab is shown or Claude is using it, and only encodes a frame when the screen has changed.
- **Claude drives the simulator.** A `mcp__ios-simulator__control` tool lets it see the screen, tap, drag, type, go home, open a URL and boot a device. Each action goes through the usual permission, and the panel opens on the device concerned. By default, the tool targets the panel's device or the only booted one, never a device picked at random. It goes through the `stream-json` channel already open: no extra process per conversation, and the CLI only loads its definition if it uses it. A per-conversation switch is in the Servers tab.
- **Built-in browser** (`⌘⇧B`). A real WKWebView placed in the right panel, with no access to the app's IPC. It moves out of the way when a dialog or menu comes in front. A `localhost` link in a reply opens in it.
- **Servers** (`⌘⇧S`):
  - dev servers come from `.claude/launch.json` (same format as Desktop) and from the `dev`, `start`, `serve`… scripts of `package.json`;
  - you can start and stop them, each in its own process group;
  - their logs are shown live, and the local URL detected opens in the built-in browser;
  - the state of the conversation's MCP servers is shown too, with enable, disable and reconnect.
- **Settings in sections** (`⌘,`): General, Performance, MCP servers and About. Every change is saved automatically.
- **Languages.** The app is in English by default and also speaks French: **Settings → General → Language** (English, Français, or System to follow macOS).

## Usage

| Action | How |
|---|---|
| New conversation | `⌘N`, the icon at the top of the sidebar, or a project's `+` |
| Search | `⌘K` |
| Send / new line | `Return` / `Shift+Return` |
| Interrupt | `Esc` |
| Browser / servers / simulator / artifacts | `⌘⇧B` / `⌘⇧S` / `⌘⇧M` / `⌘⇧A` |
| Settings | `⌘,` |
| Free a conversation's RAM | `⋯` menu → "Suspend process" (the conversation stays open) |

## Architecture

```
src-tauri/src/
  hub.rs        sessions, claude processes, stream-json protocol, permissions,
                streaming coalescing, supervisor (auto suspension)
  protocol.rs   turns CLI messages into compact UI events
  history.rs    partial reading of the ~/.claude/projects transcripts
  mcp.rs        MCP server list and writing of a restricted --mcp-config
  metrics.rs    RAM/CPU per session (process tree)
  shellenv.rs   login shell PATH (for claude, npx, uv…)
  artifacts.rs  local preview and deletion of artifacts
  simulator.rs  iOS simulators (simctl) and the helper/sim-bridge.swift stream
  simulator_tool.rs  MCP tool that lets Claude drive the simulator
  i18n.rs       language of the messages sent by the Rust core
  commands.rs   Tauri commands
src/
  main.ts       sidebar, header, permissions, dialogs, metrics
  transcript.ts per-session model + DOM rendering
  markdown.ts   marked + DOMPurify
  i18n.ts       t() and tp(): source strings in English, translations in locales/
```

## Current limitations

- These control requests get an error response so they never block the CLI:
  - `hook_callback` (hooks defined by an SDK);
  - `elicitation` (MCP forms);
  - `mcp_message` (SDK MCP servers, except the simulator tool).
- No image drag and drop yet (an image is attached with an `@` mention), and no sharing of a single instance of each MCP server across sessions.
- The built-in browser is for previewing. Claude can't drive it yet: it would have to be exposed to the CLI as an MCP server.
- The simulator relies on Xcode's private frameworks (CoreSimulator, SimulatorKit), tested with Xcode 27 and iOS 27. Another Xcode may change them: the bridge runs in its own process, so the app doesn't crash and the tab shows an error. Rotation isn't supported.
- Claude types into the simulator by pressing real keys, on a device set to French (AZERTY) or US English (QWERTY, not tried on a device yet). Elsewhere, or for a character missing from the keyboard such as "É", it pastes the text, and iOS then asks for a permission that Claude has to accept.
- The local preview of an artifact runs without its claude.ai environment: no `window.claude.*` capabilities or shared data, and `fetch` can't read neighboring files. The "Open on claude.ai" button gives the real page.
- Only the CLI's tool can delete an artifact: to do so, the interface starts a small separate Haiku process, restricted to that one address. The list only shows the conversation's artifacts; "All my artifacts" opens the gallery on claude.ai.
- The child webview uses Tauri 2's `unstable` API (`Window::add_child`).
- The `can_use_tool` permission flow is implemented from the Agent SDK code. The three choices (Allow, Always allow, Deny) are tested end to end with the fake CLI.
- The real CLI is tested up to the usage-limit response: `init` (31 tools), `rate_limit_event` banner, error result. A real model turn with tools couldn't be run, because the weekly limit had been reached.

## Credits

- Agent world creatures: [Free Pets Pack](https://frakassets.itch.io/free-pets-pack) by Frakassets, under the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) license. Only the fox, cat, rabbit, puppy and hedgehog are used, at 48 px in side view (`src/assets/critters/`).
