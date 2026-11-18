// Simulated backend, loaded only outside Tauri (browser): lets you work on
// the design and rendering (streaming, tools, permissions) without starting the CLI.
import type { Api, Attachment, CliUpdateState, UpdateState, Block, GitFile, HistoryEntry, ServerInfo, SessionInfo, SimDevice, Settings, UiEvent, Worktree, WorktreeState } from "./api";

let emit: (e: UiEvent) => void = () => {};
const now = Date.now();

const sessions = new Map<string, SessionInfo>();
function mk(p: Partial<SessionInfo> & { sid: string; title: string; cwd: string }): SessionInfo {
  return {
    cliId: null,
    model: null,
    permissionMode: "default",
    state: "idle",
    pid: null,
    mcpLabel: "all",
    effort: null,
    advisor: null,
    lastActiveMs: now,
    pendingPermissions: 0,
    ...p,
  };
}
sessions.set(
  "s1",
  mk({ sid: "s1", title: "Composer redesign", cwd: "/Users/demo/Code/better-harness", state: "suspended", cliId: "c1", lastActiveMs: now - 4 * 60_000 }),
);
sessions.set(
  "s2",
  mk({ sid: "s2", title: "Billing database migration", cwd: "/Users/demo/Code/billing-api", state: "suspended", cliId: "c2", lastActiveMs: now - 3 * 3600_000, model: "opus" }),
);

const history: HistoryEntry[] = [
  ["c1", "/Users/demo/Code/better-harness", "Composer redesign", 4 * 60_000],
  ["c2", "/Users/demo/Code/billing-api", "Billing database migration", 3 * 3600_000],
  ["c3", "/Users/demo/Code/studio-site", "Fix the mobile menu that closes on its own", 26 * 3600_000],
  ["c4", "/Users/demo/Code/billing-api", "Add partial credit notes", 2 * 86400_000],
  ["c5", "/Users/demo/Code/scripts", "Photo backup script", 5 * 86400_000],
  ["c6", "/Users/demo/Code/studio-site", "Convert images to AVIF", 9 * 86400_000],
  ["c7", "/Users/demo/Code/better-harness/.claude/worktrees/fix-login-redirect-3f2a1c", "Fix the login redirect", 50 * 60_000],
].map(([cliId, cwd, title, ago]) => ({ cliId: cliId as string, cwd: cwd as string, title: title as string, mtimeMs: now - (ago as number), size: 2_400_000 }));

const archived = new Set<string>();

/** Worktrees made for conversations, with what the Settings show of them. */
const worktrees: WorktreeState[] = [
  {
    path: "/Users/demo/Code/better-harness/.claude/worktrees/fix-login-redirect-3f2a1c",
    repo: "/Users/demo/Code/better-harness",
    branch: "claude/fix-login-redirect-3f2a1c",
    base: "main",
    baseCommit: "9f9d917",
    createdMs: now - 50 * 60_000,
    exists: true,
    dirty: 3,
    commits: 1,
  },
];
const worktreeList = (): Worktree[] => worktrees.map(({ path, repo, branch, base, baseCommit, createdMs }) => ({ path, repo, branch, base, baseCommit, createdMs }));
const emitWorktrees = () => emit({ kind: "worktrees", list: worktreeList() });
const cwdOf = (cliId: string) => [...sessions.values()].find((s) => s.cliId === cliId)?.cwd ?? history.find((h) => h.cliId === cliId)?.cwd;
/** Like the core: a clean worktree goes with its conversation, one with changes stays on disk. */
function releaseWorktree(cliId: string, forget: boolean) {
  const i = worktrees.findIndex((w) => w.path === cwdOf(cliId));
  if (i < 0) return null;
  const w = worktrees[i];
  if (w.exists && w.dirty) return { path: w.path, branch: w.branch, dirty: w.dirty };
  w.exists = false;
  if (forget) worktrees.splice(i, 1);
  emitWorktrees();
  return null;
}
const SCRATCH = "/Users/demo/Library/Application Support/Better Harness/sans-dossier";
const gitFiles: GitFile[] = [
  { path: "src/main.ts", oldPath: null, status: "M", added: 12, removed: 3 },
  { path: "src/styles.css", oldPath: null, status: "M", added: 4, removed: 1 },
  { path: "docs/release notes.md", oldPath: null, status: "?", added: 6, removed: 0 },
  { path: "src/legacy.ts", oldPath: null, status: "D", added: 0, removed: 18 },
  { path: "src/fonts/geist.woff2", oldPath: null, status: "M", added: null, removed: null },
];
const GIT_DIFF = `diff --git a/src/main.ts b/src/main.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -12,7 +12,8 @@ function renderComposer() {
   const v = activeView();
-  $("model-name").textContent = v ? v.info.model : draft.model;
+  const modelId = v ? v.info.model : draft.model;
+  $("model-name").textContent = prettyModel(modelId, v?.init?.model);
   renderContext();
 }
@@ -88,3 +89,4 @@ async function boot() {
   await api.subscribe(onEvent);
+  scratchDir = await api.scratchDir();
   settings = await api.getSettings();
`;
function closeByCliId(cliId: string) {
  for (const [sid, s] of sessions) {
    if (s.cliId === cliId) {
      sessions.delete(sid);
      emit({ kind: "sessionRemoved", sid });
    }
  }
}

let settings: Settings = {
  claudePath: null,
  maxLive: 3,
  idleMinutes: 10,
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: "default",
  mcpMode: "all",
  mcpSelected: [],
  partialMessages: true,
  allTools: false,
  cliAutoUpdate: true,
  recentDirs: ["/Users/demo/Code/better-harness", "/Users/demo/Code/billing-api", "/Users/demo/Code/studio-site", "/Users/demo/Code/ws", "/Users/demo/Archive/ws", "/Users/demo/Code/internal-tools", "/Users/demo/Code/marketing-site"],
  worktreePrefix: "claude",
  worktreeDefault: false,
  updateChannel: "stable",
  // Settings live in memory here: keep the language across reloads, like the real app does.
  language: (() => {
    try {
      return localStorage.getItem("bh-language") ?? "en";
    } catch {
      return "en";
    }
  })(),
};

const update = (sid: string, patch: Partial<SessionInfo>) => {
  const s = sessions.get(sid);
  if (!s) return;
  Object.assign(s, patch, { lastActiveMs: Date.now() });
  emit({ kind: "sessionUpdate", session: { ...s } });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams text like the Rust core: one batched send every 50 ms. */
async function stream(sid: string, text: string, thinking = false) {
  let first = true;
  for (let i = 0; i < text.length; i += 22) {
    emit({ kind: "delta", sid, text: text.slice(i, i + 22), thinking, replace: first });
    first = false;
    await sleep(50);
  }
}

const REPLY_1 = `Let me look at how the composer is built before touching the styles.

The field is a \`<textarea>\` that grows with its content, capped at **260 px**. Three things to fix:

1. The send button has no disabled state when the field is empty.
2. The model and permission mode sit in the header, far from the action.
3. Nothing shows that a message can be queued during a generation.

Checking the current styles:`;

const REPLY_2 = `Done. The composer now groups the text, the model and the mode:

\`\`\`css
.composer {
  display: grid;
  grid-template-rows: 1fr auto;
  background: var(--tone-1);
  border-radius: 14px;
  /* Subject: Seasonal Staff app: the accounts to create before going live, with a line long enough to run well past the width of the thread's reading column. */
}
\`\`\`

| Element | Before | After |
|---|---|---|
| Model | header | composer |
| Send | always enabled | disabled when empty |
| Queue | invisible | "1 message queued" |

> Streaming stays coalesced at 20 refreshes per second: live Markdown rendering only recomputes the last block.

Want me to apply the same logic to the new session dialog?`;

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Same shape as the CLI's answer to `initialize` (2.1.327): Fable comes as a full id, not an alias.
const MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: LEVELS },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: LEVELS },
  { value: "claude-fable-5-2[1m]", resolvedModel: "claude-fable-5-2", displayName: "Fable", description: "Fable 5.2 · Most capable for your hardest and longest-running tasks", supportedEffortLevels: LEVELS },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "Sonnet 5.5 · Efficient for routine tasks", supportedEffortLevels: LEVELS },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "Haiku 5.5 · Fastest for quick answers", supportedEffortLevels: LEVELS },
];

const servers = new Map<string, ServerInfo>();
const serverLogs = new Map<string, string[]>();
function defsFor(cwd: string): ServerInfo[] {
  const mk = (id: string, name: string, command: string, source: string): ServerInfo => {
    const key = `${cwd}#${id}`;
    return servers.get(key) ?? { key, cwd, id, name, command, source, state: "stopped", url: null, pid: null };
  };
  return [mk("launch:web", "web", "npm run dev", "launch.json"), mk("script:storybook", "storybook", "npm run storybook", "package.json")];
}

let permResolve: ((d: string) => void) | null = null;

/** Demos: a word in the message picks the kind of request. */
function demoRequest(prompt: string) {
  if (prompt.includes("plan"))
    return { toolName: "ExitPlanMode", title: null, description: null, input: JSON.stringify({ plan: "# Composer redesign\n\n1. Replace the `textarea` with an editable field.\n2. Add `/` and `@` mentions.\n3. Check the rendering." }) };
  if (prompt.includes("questions"))
    return {
      toolName: "AskUserQuestion",
      title: null,
      description: null,
      input: JSON.stringify({
        questions: [
          { question: "Which database should we use?", header: "Database", multiSelect: false, options: [{ label: "SQLite (recommended)", description: "No service to run, a single file." }, { label: "Postgres", description: "Better suited to concurrent writes." }] },
          { question: "What tone for the messages?", header: "Tone", multiSelect: false, options: [{ label: "Direct", description: "Short sentences, no pleasantries." }, { label: "Warm", description: "More casual, with more examples." }] },
          { question: "Which screens do you want first?", header: "Screens", multiSelect: true, options: [{ label: "Home", description: "Project list." }, { label: "Settings", description: "Account and preferences." }, { label: "History", description: "Recent actions." }] },
        ],
      }),
    };
  if (prompt.includes("question"))
    return { toolName: "AskUserQuestion", title: null, description: null, input: JSON.stringify({ questions: [{ question: "Where should the model picker go?", header: "Model", multiSelect: false, options: [{ label: "In the composer (recommended)", description: "Always visible when sending." }, { label: "In the header", description: "Frees up space under the field." }] }] }) };
  if (prompt.includes("edit"))
    return { toolName: "Edit", title: null, description: "Adds a radius to the composer.", input: JSON.stringify({ file_path: "/Users/demo/Code/better-harness/src/styles.css", old_string: "a {\n  color: red;\n}", new_string: "a {\n  color: blue;\n}" }, null, 2) };
  return { toolName: "Bash", title: null, description: "Builds the interface to check types.", input: "npm run build" };
}

async function runTurn(sid: string, prompt: string) {
  update(sid, { state: "busy", pid: 48213 });
  emit({ kind: "init", sid, model: "claude-opus-5-5", tools: 31, mcp: [{ name: "savvy-progress", status: "connected" }] });
  emit({ kind: "capabilities", sid, plan: "Claude Max", models: MODELS });
  const hours = (h: number) => Math.round(Date.now() / 1000 + h * 3600);
  emit({ kind: "rateLimit", sid, status: "allowed", resetsAt: hours(120), window: "seven_day", windows: { five_hour: { utilization: 0.38, resetsAt: hours(2) }, seven_day: { utilization: 0.19, resetsAt: hours(120) } } });
  emit({ kind: "status", sid, status: "requesting" });
  await sleep(500);
  await stream(sid, "The user wants to rework the composer. I'll read the existing code first, then the styles.", true);
  const mid = `m${Date.now()}`;
  emit({ kind: "assistant", sid, id: mid, parent: null, blocks: [{ t: "thinking", text: "The user wants to rework the composer. I'll read the existing code first, then the styles." }] });
  const reply = prompt.toLowerCase().includes("short") ? "Sure." : REPLY_1;
  await stream(sid, reply);
  emit({ kind: "assistant", sid, id: mid, parent: null, blocks: [{ t: "text", text: reply }] });
  const tools: Block[] = [
    { t: "tool", id: "t1", name: "Read", summary: "src/main.ts", input: '{\n  "file_path": "src/main.ts"\n}' },
    { t: "tool", id: "t2", name: "Grep", summary: "composer", input: '{\n  "pattern": "composer",\n  "path": "src"\n}' },
    { t: "tool", id: "t2b", name: "Edit", summary: "src/styles.css", input: JSON.stringify({ file_path: "src/styles.css", old_string: ".composer {\n  display: block;\n  gap: 8px;\n  padding: 12px;\n}", new_string: ".composer {\n  display: grid;\n  gap: 8px;\n  padding: 12px;\n  border-radius: 14px;\n}" }, null, 2) },
  ];
  emit({ kind: "assistant", sid, id: mid, parent: null, blocks: tools });
  await sleep(2500);
  emit({ kind: "toolResult", sid, toolUseId: "t1", parent: null, isError: false, text: "1\timport { openUrl } from \"@tauri-apps/plugin-opener\";\n2\timport { api } from \"./api\";\n…", truncated: false });
  emit({ kind: "toolResult", sid, toolUseId: "t2b", parent: null, isError: false, text: "The file has been updated.", truncated: false });
  emit({ kind: "toolResult", sid, toolUseId: "t2", parent: null, isError: false, text: "src/main.ts:412:$(\"composer\").addEventListener(\"submit\", …\nsrc/styles.css:188:#composer {", truncated: false });
  // A subagent on Haiku: the pixel-art world brings it in through the door, has it work, then leave.
  emit({ kind: "assistant", sid, id: mid, parent: null, blocks: [{ t: "tool", id: "a1", name: "Agent", summary: "Find usages of the composer", input: JSON.stringify({ description: "Composer usages", subagent_type: "Explore", model: "haiku", prompt: "…" }) }] });
  await sleep(1800);
  emit({ kind: "assistant", sid, id: "sa1", parent: "a1", blocks: [{ t: "tool", id: "a1-g", name: "Grep", summary: "renderComposer", input: '{"pattern":"renderComposer"}' }] });
  await sleep(2600);
  emit({ kind: "assistant", sid, id: "sa2", parent: "a1", blocks: [{ t: "tool", id: "a1-r", name: "Read", summary: "src/composer.ts", input: '{"file_path":"src/composer.ts"}' }] });
  await sleep(2600);
  emit({ kind: "toolResult", sid, toolUseId: "a1", parent: null, isError: false, text: "Found 3 usages.", truncated: false });
  await sleep(1200);
  const bash: Block = { t: "tool", id: "t3", name: "Bash", summary: "npm run build", input: "npm run build" };
  emit({ kind: "assistant", sid, id: mid, parent: null, blocks: [bash] });
  update(sid, { pendingPermissions: 1 });
  emit({
    kind: "permission",
    sid,
    requestId: "p1",
    ...demoRequest(prompt),
    canAlways: true,
  });
  const decision = await new Promise<string>((r) => (permResolve = r));
  permResolve = null;
  update(sid, { pendingPermissions: 0 });
  emit({ kind: "permissionDone", sid, requestId: "p1" });
  const ok = decision !== "deny";
  emit({
    kind: "toolResult",
    sid,
    toolUseId: "t3",
    parent: null,
    isError: !ok,
    text: ok ? "> tsc --noEmit && vite build\n✓ 13 modules transformed.\n✓ built in 69ms" : "The user denied this action.", // taste-skill-ignore: literal vite output
    truncated: false,
  });
  const mid2 = `m${Date.now()}`;
  const final = ok ? REPLY_2 : "Understood, I won't run the build.";
  await stream(sid, final);
  emit({ kind: "assistant", sid, id: mid2, parent: null, blocks: [{ t: "text", text: final }] });
  emit({ kind: "status", sid, status: null });
  emit({ kind: "result", sid, isError: false, subtype: "success", text: null, durationMs: 18_420, costUsd: 0.0412, turns: 3, inputTokens: 18_230, outputTokens: 912 });
  update(sid, { state: "ready" });
}

const simDevices: SimDevice[] = [
  { udid: "sim-1", name: "iPhone 18 Pro", state: "Booted", runtime: "iOS 27.0" },
  { udid: "sim-2", name: "iPhone 17e", state: "Shutdown", runtime: "iOS 27.0" },
  { udid: "sim-3", name: "iPad Pro 11-inch", state: "Shutdown", runtime: "iOS 27.0" },
  { udid: "sim-4", name: "iPhone 17e", state: "Shutdown", runtime: "iOS 18.2" },
];
let simAttached: string | null = null;
let simDirty = false;
let simDark = false;
let simTouches = 0;

/** A fake iPhone screen: enough to see the layout and the effect of a tap. */
async function mockScreen(): Promise<ArrayBuffer> {
  const pad = simAttached === "sim-3";
  const canvas = new OffscreenCanvas(pad ? 834 : 585, pad ? 1194 : 1266);
  const c = canvas.getContext("2d")!;
  c.fillStyle = simDark ? "#111114" : "#f2f2f7";
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = simDark ? "#fff" : "#111";
  c.font = "600 22px -apple-system";
  c.fillText("15:42", 60, 52);
  c.font = "700 56px -apple-system";
  c.fillText("Settings", 40, 190);
  for (let i = 0; i < 8; i++) {
    c.fillStyle = simDark ? "#1c1c1f" : "#fff";
    c.fillRect(40, 240 + i * 112, canvas.width - 80, 96);
    c.fillStyle = simDark ? "#ddd" : "#333";
    c.font = "400 30px -apple-system";
    c.fillText(i === 0 ? `Taps: ${simTouches}` : `Row ${i + 1}`, 70, 300 + i * 112);
  }
  return (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer();
}

/** Demo images: a gradient at the stated size, to see the layout. */
const MOCK_IMAGES: Record<string, [number, number, string, string]> = {
  "home-screenshot.png": [2880, 1800, "#4f46e5", "#0ea5e9"],
  "icon.png": [64, 64, "#f59e0b", "#ef4444"],
  "mobile-mockup.png": [1170, 2532, "#10b981", "#0f766e"],
  "chart.svg": [0, 0, "#64748b", "#0f172a"],
  "photo.jpg": [4032, 3024, "#a855f7", "#ec4899"],
};
function mockImage(name: string, w: number, h: number, from: string, to: string): string {
  const [vw, vh] = w && h ? [w, h] : [800, 500];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#fff" font-family="-apple-system" font-size="${Math.max(10, Math.min(vw, vh) / 10)}" text-anchor="middle" dominant-baseline="middle">${name}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function mockAttachment(cwd: string, path: string): Attachment {
  const full = path.startsWith("/") ? path : `${cwd}/${path}`;
  const name = full.split("/").pop() ?? full;
  const img = MOCK_IMAGES[name];
  const exists = !name.includes("missing");
  return { path: full, name, exists, size: exists ? 1_284_000 : 0, image: !!img && exists, width: img?.[0] || null, height: img?.[1] || null, url: img && exists ? mockImage(name, ...img) : undefined };
}

let mockUpdate: UpdateState = { state: "idle" };
const updateListeners = new Set<(s: UpdateState) => void>();
const setMockUpdate = (s: UpdateState) => {
  mockUpdate = s;
  for (const cb of updateListeners) cb(s);
};

let mockCliUpdate: CliUpdateState = { state: "upToDate", version: "2.1.319" };
const cliUpdateListeners = new Set<(s: CliUpdateState) => void>();
const setMockCliUpdate = (s: CliUpdateState) => {
  mockCliUpdate = s;
  for (const cb of cliUpdateListeners) cb(s);
};

export const mockApi: Api = {
  subscribe: async (cb) => {
    emit = cb;
  },
  listSessions: async () => [...sessions.values()].map((s) => ({ ...s })),
  createSession: async (o) => {
    const sid = `s${Date.now()}`;
    if (o.worktree) {
      await sleep(800);
      const slug =
        (o.worktree.hint ?? "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f']/g, "")
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
          .slice(0, 4)
          .join("-") || "session";
      const name = `${slug}-${Math.random().toString(16).slice(2, 8)}`;
      const repo = o.cwd;
      const path = `${repo}/.claude/worktrees/${name}`;
      worktrees.unshift({ path, repo, branch: `${settings.worktreePrefix}/${name}`, base: o.worktree.base ?? "main", baseCommit: "9f9d917", createdMs: Date.now(), exists: true, dirty: 0, commits: 0 });
      emitWorktrees();
      o = { ...o, cwd: path };
    }
    const s = mk({ sid, title: o.title ?? "New session", cwd: o.cwd, cliId: o.resume ?? null, model: o.model ?? null, advisor: o.advisor ?? null, state: o.resume ? "suspended" : "idle", mcpLabel: o.mcp ? (o.mcp.length ? o.mcp.join(", ") : "none") : "all" });
    sessions.set(sid, s);
    queueMicrotask(() => emit({ kind: "sessionUpdate", session: { ...s } }));
    return { ...s };
  },
  send: async (sid, text) => {
    const s = sessions.get(sid);
    if (s && s.title === "New session") {
      update(sid, { title: text.slice(0, 60) });
      // Like the CLI: the generated title arrives a moment after the first message.
      setTimeout(() => update(sid, { title: "Title generated from the first message" }), 900);
    }
    void runTurn(sid, text);
  },
  interrupt: async (sid) => {
    emit({ kind: "notice", sid, level: "info", text: "Interrupt requested." });
  },
  respondPermission: async (_sid, _rid, decision, answers, message) => {
    (window as unknown as { __mockAnswer: unknown }).__mockAnswer = { decision, answers, message };
    permResolve?.(decision);
  },
  setPermissionMode: async (sid, mode) => update(sid, { permissionMode: mode }),
  setModel: async (sid, model) => update(sid, { model }),
  suspend: async (sid) => {
    update(sid, { state: "suspended", pid: null });
    emit({ kind: "notice", sid, level: "info", text: "Process suspended (manual); resumes automatically on the next message." });
  },
  close: async (sid) => {
    sessions.delete(sid);
    emit({ kind: "sessionRemoved", sid });
  },
  focus: async () => {},
  setVisible: async () => {},
  listHistory: async (limit, query) =>
    history.filter((h) => !archived.has(h.cliId) && (!query || (h.title + h.cwd).toLowerCase().includes(query.toLowerCase()))).slice(0, limit),
  scratchDir: async () => SCRATCH,
  appReady: async () => {},
  listCommands: async () => {
    await sleep(300);
    return [
      ["compact", "Summarize the conversation history to free up context."],
      ["make-interfaces-feel-better", "Design engineering principles for making interfaces feel polished."],
      ["transitions-polish", "Polish and refine existing motion against the transitions.dev motion-token scale."],
      ["framer-motion-animator", "Creates smooth animations and micro-interactions using Framer Motion."],
      ["tauri-v2", "Tauri v2+ cross-platform app development with Rust backend."],
      ["anthropic-skills:docx", "Create, read and edit Word documents."],
      ["anthropic-skills:pdf", "Read, merge, split and fill PDF files."],
      ["code-review", "Review the current diff for correctness bugs."],
      ["simplify", "Review the changed code for reuse and simplification."],
    ].map(([name, description]) => ({ name, description }));
  },
  mentionFiles: async (cwd, query) => {
    if (query.startsWith("/")) return ["/Users/demo/Documents/", "/Users/demo/My projects/", "/Users/demo/notes.md"].filter((p) => p.toLowerCase().startsWith(query.toLowerCase()));
    if (cwd === SCRATCH) return [];
    return ["src/", "docs/", "README.md", "package.json", "src/main.ts", "src/styles.css", "src/composer.ts", "docs/release notes.md"].filter((p) => p.toLowerCase().includes(query.toLowerCase()));
  },
  cliModels: async () => MODELS,
  cliDefaults: async () => ({ model: null, effort: "xhigh" }),
  gitStatus: async (cwd) =>
    cwd === SCRATCH || cwd.includes("scripts")
      ? { isRepo: false, root: "", hasHead: false, branch: null, files: [], truncated: false }
      : { isRepo: true, root: cwd, hasHead: true, branch: "main", files: cwd.includes("billing") ? [] : gitFiles.map((f) => ({ ...f })), truncated: false },
  gitDiff: async (_cwd, path) => (path.endsWith(".woff2") ? { text: `Binary files a/${path} and b/${path} differ`, truncated: false, binary: true } : { text: GIT_DIFF, truncated: false, binary: false }),
  gitDiscard: async (_cwd, path) => {
    const i = gitFiles.findIndex((f) => f.path === path);
    if (i >= 0) gitFiles.splice(i, 1);
  },
  listArchived: async () => history.filter((h) => archived.has(h.cliId)),
  setArchived: async (cliId, on) => {
    if (!on) {
      archived.delete(cliId);
      return null;
    }
    archived.add(cliId);
    const kept = releaseWorktree(cliId, false);
    closeByCliId(cliId);
    return kept;
  },
  deleteConversation: async (cliId) => {
    const kept = releaseWorktree(cliId, true);
    closeByCliId(cliId);
    archived.delete(cliId);
    const i = history.findIndex((h) => h.cliId === cliId);
    if (i >= 0) history.splice(i, 1);
    return kept;
  },
  gitBranches: async (cwd) =>
    cwd.includes("scripts") || cwd === SCRATCH
      ? { isRepo: false, hasHead: false, current: null, list: [] }
      : { isRepo: true, hasHead: true, current: "main", list: ["main", ...worktrees.filter((w) => w.repo === cwd).map((w) => w.branch), "release", "fix/menu-flicker"] },
  listWorktrees: async () => worktreeList(),
  worktreeStates: async () => worktrees.filter((w) => w.exists).map((w) => ({ ...w })),
  removeWorktree: async (path) => {
    for (const [sid, s] of sessions) {
      if (s.cwd === path) {
        sessions.delete(sid);
        emit({ kind: "sessionRemoved", sid });
      }
    }
    const w = worktrees.find((x) => x.path === path);
    if (w) w.exists = false;
    emitWorktrees();
  },
  copyText: async (text) => navigator.clipboard?.writeText(text),
  loadTranscript: async (sid, cliId) => {
    // A large conversation: reading it takes longer than the transition waits.
    if (cliId === "c5") await sleep(600);
    if (cliId !== "c1") return { events: [], hasMore: false };
    const ev: UiEvent[] = [
      { kind: "user", sid, text: "The composer is too cluttered. Can you simplify it?" },
      { kind: "assistant", sid, id: "h1", parent: null, blocks: [{ t: "text", text: "Yes. I'll start by looking at **what is shown** and what is actually used." }, { t: "tool", id: "h-t1", name: "Read", summary: "index.html", input: '{ "file_path": "index.html" }' }] },
      { kind: "toolResult", sid, toolUseId: "h-t1", parent: null, isError: false, text: "<form id=\"composer\">…</form>", truncated: false },
      { kind: "assistant", sid, id: "h-a", parent: null, blocks: [{ t: "tool", id: "h-t2", name: "Artifact", summary: "mockup.html", input: '{ "file_path": "/tmp/mockup.html", "icon": "layout" }' }] },
      { kind: "toolResult", sid, toolUseId: "h-t2", parent: null, isError: false, text: "Published /tmp/mockup.html at https://claude.ai/artifact/demo", truncated: false, artifact: { url: "https://claude.ai/artifact/demo", title: "Composer mockup", path: "/tmp/mockup.html" } },
      { kind: "assistant", sid, id: "h2", parent: null, blocks: [{ t: "text", text: "Three controls could move into the composer: the model, the mode and interrupt. I suggest grouping them under the input field." }] },
      { kind: "assistant", sid, id: "h3", parent: null, blocks: [{ t: "text", text: "Here is the home screen after the redesign:" }, { t: "tool", id: "h-f1", name: "mcp__harness__send_files", summary: "", input: JSON.stringify({ files: ["docs/home-screenshot.png"] }, null, 2) }] },
      { kind: "toolResult", sid, toolUseId: "h-f1", parent: null, isError: false, text: "Shown to the user: docs/home-screenshot.png.", truncated: false },
      { kind: "assistant", sid, id: "h4", parent: null, blocks: [{ t: "tool", id: "h-f2", name: "mcp__harness__send_files", summary: "", input: JSON.stringify({ files: ["/tmp/mobile-mockup.png", "/tmp/photo.jpg", "/tmp/icon.png", "/tmp/chart.svg", "docs/final measurements report.pdf", "/tmp/missing-export.csv"], caption: "The mockups, the report and the export you asked for." }, null, 2) }] },
      { kind: "toolResult", sid, toolUseId: "h-f2", parent: null, isError: false, text: "Shown to the user: … Not found, not shown: /tmp/missing-export.csv.", truncated: false },
    ];
    return { events: ev, hasMore: true };
  },
  listMcp: async () => [
    { name: "context7", scope: "user", transport: "http", detail: "https://mcp.context7.com/mcp" },
    { name: "rea", scope: "user", transport: "stdio", detail: "npx -y rea-agents@6.5.0 mcp" },
    { name: "blender", scope: "user", transport: "stdio", detail: "uv run blender-mcp" },
  ],
  metrics: async () => {
    const live = [...sessions.values()].filter((s) => s.pid);
    return {
      harness: { rssMb: 34.2, cpu: 0.4, procs: 1 },
      sessions: live.map((s) => [s.sid, { rssMb: 176.4, cpu: 2.1, procs: 1 }] as [string, { rssMb: number; cpu: number; procs: number }]),
      totalRssMb: 34.2 + live.length * 176.4,
    };
  },
  getSettings: async () => ({ ...settings }),
  saveSettings: async (s) => {
    // Like the app: changing channel drops the version downloaded for the other one.
    if (s.updateChannel !== settings.updateChannel) setMockUpdate({ state: "idle" });
    settings = s;
  },
  setLanguage: async () => undefined,
  setEffort: async (sid, effort) => update(sid, { effort }),
  setAdvisor: async (sid, advisor) => update(sid, { advisor }),
  contextUsage: async () => ({
    totalTokens: 41_230,
    maxTokens: 1_000_000,
    categories: [
      { id: "system_prompt", name: "System prompt", tokens: 2682, kind: "used" },
      { id: "system_tools", name: "System tools", tokens: 13_664, kind: "used" },
      { id: "skills", name: "Skills", tokens: 9951, kind: "used" },
      { id: "messages", name: "Messages", tokens: 14_340, kind: "used" },
      { id: "memory_files", name: "Memory files", tokens: 593, kind: "used" },
    ],
  }),
  mcpStatus: async () => ({
    mcpServers: [
      { name: "context7", status: "connected", transport: "http", tools: [{ name: "resolve" }, { name: "query" }] },
      { name: "rea", status: "failed", transport: "stdio", tools: [] },
      { name: "savvy-progress", status: "connected", transport: "http", tools: [{ name: "progress" }, { name: "step" }] },
    ],
  }),
  mcpToggle: async () => {},
  mcpReconnect: async () => {},
  serversList: async (cwd) => defsFor(cwd),
  serverStart: async (cwd, id) => {
    const def = defsFor(cwd).find((d) => d.id === id)!;
    const s: ServerInfo = { ...def, state: "running", pid: 51234, url: null };
    servers.set(s.key, s);
    emit({ kind: "server", server: { ...s } });
    const lines = [`$ ${s.command}`, "", "> studio-web@0.4.2 dev", "> vite", "", "  VITE v8.3.6  ready in 412 ms", "", "  ➜  Local:   http://localhost:5173/", "  ➜  Network: use --host to expose"]; // taste-skill-ignore: literal vite output
    serverLogs.set(s.key, []);
    for (const l of lines) {
      await sleep(120);
      serverLogs.get(s.key)!.push(l);
      emit({ kind: "serverLog", key: s.key, lines: [l] });
      if (l.includes("localhost:5173")) {
        s.url = "http://localhost:5173";
        emit({ kind: "server", server: { ...s } });
      }
    }
    return { ...s };
  },
  serverStop: async (key) => {
    const s = servers.get(key);
    if (!s) return;
    s.state = "stopped";
    s.pid = null;
    serverLogs.get(key)?.push("— stopped (code 0)");
    emit({ kind: "serverLog", key, lines: ["— stopped (code 0)"] });
    emit({ kind: "server", server: { ...s } });
  },
  serverLogs: async (key) => serverLogs.get(key) ?? [],
  browserOpen: async (url) => (url.includes("://") ? url : `http://${url}`),
  browserBounds: async () => {},
  browserNav: async () => {},
  browserClose: async () => {},
  artifactShow: async () => false,
  artifactBounds: async () => {},
  artifactReload: async () => {},
  artifactClose: async () => {},
  artifactDelete: async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return true;
  },
  simDevices: async () => simDevices.map((device) => ({ ...device })),
  simBoot: async (udid) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const device = simDevices.find((x) => x.udid === udid);
    if (device) device.state = "Booted";
  },
  simShutdown: async (udid) => {
    const device = simDevices.find((x) => x.udid === udid);
    if (device) device.state = "Shutdown";
  },
  simAttach: async (udid) => {
    simAttached = udid;
    simDirty = true;
    emit({ kind: "simulator", udid, state: "ready", message: null });
  },
  simDetach: async () => {
    simAttached = null;
  },
  simSelect: async () => {},
  simFrame: async () => {
    if (!simDirty || !simAttached) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return new ArrayBuffer(0);
    }
    simDirty = false;
    return mockScreen();
  },
  simInput: async (line) => {
    if (line.startsWith("touch up") || line === "home") simDirty = true;
    simTouches += line.startsWith("touch down") ? 1 : 0;
  },
  simScreenshot: async () => "/Users/demo/Library/Caches/dev.betterharness.desktop/simulator/capture-1.png",
  simAppearance: async (_udid, value) => {
    if (value) {
      simDark = value === "dark";
      simDirty = true;
    }
    return simDark ? "dark" : "light";
  },
  attachments: async (cwd, paths) => {
    await sleep(20);
    return paths.map((p) => mockAttachment(cwd, p));
  },
  openAttachment: async (path) => !path.endsWith(".command"),
  updateStatus: async () => mockUpdate,
  updateCheck: async () => {
    setMockUpdate({ state: "checking" });
    await sleep(500);
    setMockUpdate({ state: "downloading", version: "0.2.0" });
    await sleep(900);
    setMockUpdate({ state: "ready", version: "0.2.0" });
    return mockUpdate;
  },
  updateInstall: async () => location.reload(),
  onUpdate: async (cb) => {
    updateListeners.add(cb);
  },
  cliUpdateStatus: async () => mockCliUpdate,
  cliUpdateCheck: async () => {
    setMockCliUpdate({ state: "checking" });
    await sleep(1200);
    setMockCliUpdate({ state: "updated", from: "2.1.319", version: "2.1.327" });
    return mockCliUpdate;
  },
  onCliUpdate: async (cb) => {
    cliUpdateListeners.add(cb);
  },
  appInfo: async () => ({ version: "0.1.0", claudePath: "/Users/demo/.local/bin/claude", claudeVersion: "2.1.319 (Claude Code)", home: "/Users/demo" }),
};
