// Typed bridge to the Rust core (src-tauri/src/commands.rs).
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SessionState = "idle" | "starting" | "ready" | "busy" | "suspended";

export interface SessionInfo {
  sid: string;
  cliId: string | null;
  cwd: string;
  title: string;
  model: string | null;
  permissionMode: string;
  state: SessionState;
  pid: number | null;
  mcpLabel: string;
  effort: string | null;
  advisor: string | null;
  lastActiveMs: number;
  pendingPermissions: number;
}

export type Block =
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "tool"; id: string; name: string; summary: string; input: string };

export interface ResultEv {
  kind: "result";
  sid: string;
  isError: boolean;
  subtype: string;
  text: string | null;
  durationMs: number;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PermissionEv {
  kind: "permission";
  sid: string;
  requestId: string;
  toolName: string;
  title: string | null;
  description: string | null;
  input: string;
  canAlways: boolean;
}

export interface RateLimitEv {
  kind: "rateLimit";
  sid: string;
  status: string;
  resetsAt: number | null;
  window: string | null;
  windows?: UsageWindows | null;
}

/** Account limit windows: share used (0 to 1) and reset time (seconds since the epoch). */
export type UsageWindows = Record<string, { utilization: number; resetsAt: number }>;

export interface InitEv {
  kind: "init";
  sid: string;
  model: string;
  tools: number;
  mcp: { name: string; status: string }[];
}

export interface ToolResultEv {
  kind: "toolResult";
  sid: string;
  toolUseId: string;
  parent: string | null;
  isError: boolean;
  text: string;
  truncated: boolean;
  /** The structured result points to an artifact. */
  artifact?: { url: string; title: string | null; path: string | null } | null;
}

/** An artifact of the conversation: its claude.ai address and, if there is one, its local file. */
export interface Artifact {
  url: string;
  title: string;
  path: string | null;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/** Model and effort the CLI uses when none is imposed on it. */
export interface CliDefaults {
  model: string | null;
  effort: string | null;
}

export interface GitFile {
  path: string;
  oldPath: string | null;
  status: "M" | "A" | "D" | "R" | "U" | "?";
  added: number | null;
  removed: number | null;
}

export interface GitStatus {
  isRepo: boolean;
  root: string;
  hasHead: boolean;
  branch: string | null;
  files: GitFile[];
  truncated: boolean;
}

export interface GitDiff {
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface ServerInfo {
  key: string;
  cwd: string;
  id: string;
  name: string;
  command: string;
  source: string;
  state: "stopped" | "running" | "crashed";
  url: string | null;
  pid: number | null;
}

export interface ContextUsage {
  categories: { id: string; name: string; tokens: number; kind: string }[];
  totalTokens: number;
  maxTokens: number;
}

export interface McpServerStatus {
  name: string;
  status: string;
  transport?: string;
  source?: string;
  tools?: { name: string }[];
}

export type UiEvent =
  | { kind: "sessionUpdate"; session: SessionInfo }
  | { kind: "sessionRemoved"; sid: string }
  | InitEv
  | { kind: "delta"; sid: string; text: string; thinking: boolean; replace: boolean }
  | { kind: "assistant"; sid: string; id: string; parent: string | null; blocks: Block[] }
  | ToolResultEv
  | { kind: "user"; sid: string; text: string }
  | PermissionEv
  | { kind: "permissionDone"; sid: string; requestId: string }
  | { kind: "status"; sid: string; status: string | null }
  | RateLimitEv
  | ResultEv
  | { kind: "notice"; sid: string | null; level: string; text: string }
  | { kind: "capabilities"; sid: string; models: ModelInfo[]; plan: string | null }
  | { kind: "server"; server: ServerInfo }
  | { kind: "serverLog"; key: string; lines: string[] }
  | { kind: "browser"; url: string; loading: boolean }
  | { kind: "artifactReady" }
  | { kind: "simulator"; udid: string; state: "ready" | "no-input" | "error" | "ended" | "agent"; message: string | null };

export interface HistoryEntry {
  cliId: string;
  cwd: string;
  title: string;
  mtimeMs: number;
  size: number;
}

export interface McpEntry {
  name: string;
  scope: string;
  transport: string;
  detail: string;
}

export interface ProcStat {
  rssMb: number;
  cpu: number;
  procs: number;
}

export interface Metrics {
  harness: ProcStat;
  sessions: [string, ProcStat][];
  totalRssMb: number;
}

export interface Settings {
  settingsVersion?: number;
  claudePath: string | null;
  /** Runs `claude update` at launch, then every 6 hours. */
  cliAutoUpdate: boolean;
  maxLive: number;
  idleMinutes: number;
  defaultModel: string | null;
  defaultEffort: string | null;
  defaultPermissionMode: string;
  mcpMode: "all" | "selected";
  mcpSelected: string[];
  partialMessages: boolean;
  allTools: boolean;
  recentDirs: string[];
  /** "en" (default), "fr" or "system" (src/i18n.ts). */
  language: string;
}

/** State of automatic updates (src-tauri/src/updates.rs). */
export type UpdateState =
  | { state: "idle" | "checking" | "upToDate" }
  | { state: "downloading" | "ready"; version: string }
  | { state: "error"; message: string };

/** State of the claude CLI updates (src-tauri/src/cli_updates.rs). */
export type CliUpdateState =
  | { state: "idle" | "checking" }
  | { state: "upToDate"; version: string }
  | { state: "updated"; from: string; version: string }
  | { state: "error"; message: string };

export interface AppInfo {
  version: string;
  claudePath: string | null;
  claudeVersion: string | null;
  home: string;
}

export interface CreateOpts {
  cwd: string;
  model?: string | null;
  permissionMode?: string | null;
  mcp?: string[] | null;
  resume?: string | null;
  title?: string | null;
  effort?: string | null;
  advisor?: string | null;
}

export const tauriApi = {
  subscribe(cb: (e: UiEvent) => void) {
    const ch = new Channel<UiEvent>();
    ch.onmessage = cb;
    return invoke<void>("subscribe", { onEvent: ch });
  },
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),
  createSession: (opts: CreateOpts) => invoke<SessionInfo>("create_session", { opts }),
  send: (sid: string, text: string) => invoke<void>("send_message", { sid, text }),
  interrupt: (sid: string) => invoke<void>("interrupt", { sid }),
  respondPermission: (sid: string, requestId: string, decision: "allow" | "always" | "deny", answers?: Record<string, string>, message?: string) =>
    invoke<void>("respond_permission", { sid, requestId, decision, answers, message }),
  setPermissionMode: (sid: string, mode: string) => invoke<void>("set_permission_mode", { sid, mode }),
  setModel: (sid: string, model: string | null) => invoke<void>("set_model", { sid, model }),
  suspend: (sid: string) => invoke<void>("suspend_session", { sid }),
  close: (sid: string) => invoke<void>("close_session", { sid }),
  focus: (sid: string | null) => invoke<void>("focus_session", { sid }),
  setVisible: (visible: boolean) => invoke<void>("set_visible", { visible }),
  listHistory: (limit: number, query?: string) => invoke<HistoryEntry[]>("list_history", { limit, query }),
  scratchDir: () => invoke<string>("scratch_dir"),
  appReady: () => invoke<void>("app_ready"),
  listCommands: (cwd: string) => invoke<{ name: string; description?: string | null }[]>("list_commands", { cwd }),
  cliModels: (cwd: string) => invoke<ModelInfo[]>("cli_models", { cwd }),
  mentionFiles: (cwd: string, query: string) => invoke<string[]>("mention_files", { cwd, query }),
  cliDefaults: (cwd: string | null) => invoke<CliDefaults>("cli_defaults", { cwd }),
  gitStatus: (cwd: string) => invoke<GitStatus>("git_status", { cwd }),
  gitDiff: (cwd: string, path: string) => invoke<GitDiff>("git_diff", { cwd, path }),
  gitDiscard: (cwd: string, path: string) => invoke<void>("git_discard", { cwd, path }),
  listArchived: () => invoke<HistoryEntry[]>("list_archived"),
  setArchived: (cliId: string, archived: boolean) => invoke<void>("set_archived", { cliId, archived }),
  deleteConversation: (cliId: string) => invoke<void>("delete_conversation", { cliId }),
  loadTranscript: (sid: string, cliId: string, limit: number) =>
    invoke<{ events: UiEvent[]; hasMore: boolean }>("load_transcript", { sid, cliId, limit }),
  listMcp: (cwd: string) => invoke<McpEntry[]>("list_mcp", { cwd }),
  metrics: () => invoke<Metrics>("get_metrics"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setLanguage: (lang: string) => invoke<void>("set_language", { lang }),
  appInfo: () => invoke<AppInfo>("app_info"),
  setEffort: (sid: string, effort: string | null) => invoke<void>("set_effort", { sid, effort }),
  setAdvisor: (sid: string, advisor: string | null) => invoke<void>("set_advisor", { sid, advisor }),
  contextUsage: (sid: string) => invoke<ContextUsage | null>("context_usage", { sid }),
  mcpStatus: (sid: string) => invoke<{ mcpServers: McpServerStatus[] } | null>("mcp_status", { sid }),
  mcpToggle: (sid: string, name: string, enabled: boolean) => invoke<void>("mcp_toggle", { sid, name, enabled }),
  mcpReconnect: (sid: string, name: string) => invoke<void>("mcp_reconnect", { sid, name }),
  serversList: (cwd: string) => invoke<ServerInfo[]>("servers_list", { cwd }),
  serverStart: (cwd: string, id: string) => invoke<ServerInfo>("server_start", { cwd, id }),
  serverStop: (key: string) => invoke<void>("server_stop", { key }),
  serverLogs: (key: string) => invoke<string[]>("server_logs", { key }),
  browserOpen: (url: string, r: Rect) => invoke<string>("browser_open", { url, ...r }),
  browserBounds: (r: Rect, visible: boolean) => invoke<void>("browser_bounds", { ...r, visible }),
  browserNav: (action: "back" | "forward" | "reload") => invoke<void>("browser_nav", { action }),
  browserClose: () => invoke<void>("browser_close"),
  artifactShow: (path: string, w: number, h: number) => invoke<boolean>("artifact_show", { path, w, h }),
  artifactBounds: (r: Rect, visible: boolean) => invoke<void>("artifact_bounds", { ...r, visible }),
  artifactReload: () => invoke<void>("artifact_reload"),
  artifactClose: () => invoke<void>("artifact_close"),
  artifactDelete: (url: string) => invoke<boolean>("artifact_delete", { url }),
  simDevices: () => invoke<SimDevice[]>("sim_devices"),
  simBoot: (udid: string) => invoke<void>("sim_boot", { udid }),
  simShutdown: (udid: string) => invoke<void>("sim_shutdown", { udid }),
  simAttach: (udid: string) => invoke<void>("sim_attach", { udid }),
  simDetach: () => invoke<void>("sim_detach"),
  simSelect: (udid: string | null) => invoke<void>("sim_select", { udid }),
  /** A JPEG image, or an empty buffer if the screen hasn't changed. */
  simFrame: () => invoke<ArrayBuffer>("sim_frame"),
  simInput: (line: string) => invoke<void>("sim_input", { line }),
  simScreenshot: (udid: string) => invoke<string>("sim_screenshot", { udid }),
  simAppearance: (udid: string, value?: "light" | "dark") => invoke<string>("sim_appearance", { udid, value: value ?? null }),
  attachments: async (cwd: string, paths: string[]) =>
    (await invoke<Attachment[]>("attachments", { cwd, paths })).map((a) => (a.image ? { ...a, url: convertFileSrc(a.path) } : a)),
  /** `false`: the file could run, better to show it in the Finder. */
  openAttachment: (path: string) => invoke<boolean>("open_attachment", { path }),
  updateStatus: () => invoke<UpdateState>("update_status"),
  /** Looks for a newer version and downloads it. */
  updateCheck: () => invoke<UpdateState>("update_check"),
  /** Installs the downloaded version and relaunches the app. */
  updateInstall: () => invoke<void>("update_install"),
  onUpdate: async (cb: (s: UpdateState) => void) => {
    await listen<UpdateState>("update", (e) => cb(e.payload));
  },
  cliUpdateStatus: () => invoke<CliUpdateState>("cli_update_status"),
  /** Runs `claude update` now. */
  cliUpdateCheck: () => invoke<CliUpdateState>("cli_update_check"),
  onCliUpdate: async (cb: (s: CliUpdateState) => void) => {
    await listen<CliUpdateState>("cli-update", (e) => cb(e.payload));
  },
};

/** A file Claude shows in the conversation (`send_files` tool). */
export interface Attachment {
  path: string;
  name: string;
  exists: boolean;
  size: number;
  image: boolean;
  /** Dimensions read from the image header, when the format allows it. */
  width: number | null;
  height: number | null;
  /** Image address for the view, added on the UI side. */
  url?: string;
}

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Api = typeof tauriApi;
