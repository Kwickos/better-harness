import type { Artifact, CliDefaults, ModelInfo, ToolResultEv } from "./api";
import type { IconName } from "./icons";
import { t } from "./i18n";

export const deleteNote = () => t("It goes to the Trash and also disappears from Claude Code.");

export const SIM_TOOL = "mcp__ios-simulator__control";
/** The tool the app serves to show files in the conversation (src-tauri/src/files_tool.rs). */
export const FILES_TOOL = "mcp__harness__send_files";
/** The tool that ends a turn with a next-step box (src-tauri/src/next_step.rs). */
export const NEXT_STEP_TOOL = "mcp__harness__next_step";

/** The box drawn after a turn: a click on a button sends its message, not its label. */
export interface NextStep {
  /** The tool call it comes from: a refused call takes its box away. */
  id: string;
  recap: string;
  ask: string;
  buttons: { label: string; message: string }[];
}

/** The box a `next_step` call asks for, or null if its input is not complete. */
export function nextStepOf(id: string, input: string): NextStep | null {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return null;
  }
  const o = (raw ?? {}) as { recap?: unknown; ask?: unknown; buttons?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const buttons = (Array.isArray(o.buttons) ? o.buttons : [])
    .map((b) => ({ label: str((b as { label?: unknown })?.label), message: str((b as { message?: unknown })?.message) }))
    .filter((b) => b.label && b.message)
    .slice(0, 2);
  const ask = str(o.ask);
  if (!ask || !buttons.length) return null;
  return { id, recap: str(o.recap), ask, buttons };
}

/** The files Claude wants to show, and the line that goes with them. */
export function sentFiles(input: string): { files: string[]; caption: string } {
  let a: { files?: unknown; caption?: unknown };
  try {
    a = JSON.parse(input) as typeof a;
  } catch {
    return { files: [], caption: "" };
  }
  const files = (typeof a.files === "string" ? [a.files] : Array.isArray(a.files) ? a.files : []).filter((f): f is string => typeof f === "string" && !!f.trim());
  return { files: files.slice(0, 20), caption: typeof a.caption === "string" ? a.caption.trim() : "" };
}

/** What Claude asks the simulator, in plain words: "tap 120, 340 · iPhone 17e". */
export function simulatorAction(input: string): string {
  let a: { action?: string; device?: string; x?: number; y?: number; x2?: number; y2?: number; text?: string };
  try {
    a = JSON.parse(input) as typeof a;
  } catch {
    return "";
  }
  const act: Record<string, string> = {
    list: t("list devices"),
    boot: t("boot"),
    screenshot: t("look at the screen"),
    tap: t("tap {x}, {y}", { x: String(a.x), y: String(a.y) }),
    swipe: t("swipe {x}, {y} → {x2}, {y2}", { x: String(a.x), y: String(a.y), x2: String(a.x2), y2: String(a.y2) }),
    type: t("type “{text}”", { text: a.text ?? "" }),
    key: t("key {text}", { text: a.text ?? "" }),
    home: t("home"),
    open_url: t("open {text}", { text: a.text ?? "" }),
  };
  const what = act[a.action ?? ""] ?? a.action ?? "";
  return a.device ? `${what} · ${a.device}` : what;
}

const fileBase = (path: string) => path.split("/").pop() ?? path;

/** What Claude asks the `Artifact` tool, in plain words: "publish report.html". */
export function artifactAction(input: string): string {
  let a: { action?: string; title?: string; file_path?: string; url?: string };
  try {
    a = JSON.parse(input) as typeof a;
  } catch {
    return "";
  }
  const name = a.title ?? (a.file_path ? fileBase(a.file_path) : "");
  const act: Record<string, string> = {
    publish: t("publish {name}", { name }).trim(),
    read: t("read an artifact"),
    list: t("list artifacts"),
    delete: t("delete an artifact"),
    open: t("open an artifact"),
    quickstart: t("prepare an artifact"),
    pin: t("pin an artifact"),
    unpin: t("unpin an artifact"),
  };
  return act[a.action ?? "publish"] ?? a.action ?? "";
}

const DELETED_KEY = "bh.artifacts.deleted";
function deletedArtifacts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DELETED_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
/** The transcript keeps the publish: without this list, a deleted artifact would come back when it is replayed. */
export function rememberDeletedArtifact(url: string) {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify([...deletedArtifacts().filter((x) => x !== url), url].slice(-500)));
  } catch {
    /* storage unavailable: the artifact would only reappear on replay */
  }
}

/**
 * Keeps the list up to date from an `Artifact` tool result, most recent first.
 * Returns the URL of the artifact to show, if any.
 */
export function updateArtifacts(list: Artifact[], input: string, ev: Pick<ToolResultEv, "artifact" | "isError">): string | null {
  if (ev.isError) return null;
  let a: { action?: string; asset?: boolean; path?: string; url?: string; title?: string };
  try {
    a = JSON.parse(input) as typeof a;
  } catch {
    return null;
  }
  const action = a.action ?? "publish";
  if (action === "open") return a.url ?? ev.artifact?.url ?? null;
  if (action === "delete") {
    // With `path`, only one of the artifact's attachments goes away.
    const at = a.path ? -1 : list.findIndex((x) => x.url === a.url);
    if (at >= 0) list.splice(at, 1);
    return null;
  }
  if (action !== "publish" || a.asset || !ev.artifact || deletedArtifacts().includes(ev.artifact.url)) return null;
  const { url, title, path } = ev.artifact;
  const at = list.findIndex((x) => x.url === url);
  const known = at >= 0 ? list.splice(at, 1)[0] : undefined;
  list.unshift({ url, title: title ?? a.title ?? known?.title ?? (path ? fileBase(path) : t("Artifact")), path: path ?? known?.path ?? null });
  return url;
}

// Labels are built on each call: they follow the interface language when it changes.
export const efforts = (): { id: string; label: string }[] => [
  { id: "low", label: t("Low") },
  { id: "medium", label: t("Medium") },
  { id: "high", label: t("High") },
  { id: "xhigh", label: t("Very high") },
  { id: "max", label: t("Max") },
];
export const effortLabel = (id: string | null | undefined) => efforts().find((e) => e.id === id)?.label ?? "";

export const modes = (): { id: string; label: string; icon: IconName }[] => [
  { id: "default", label: t("Ask"), icon: "hand" },
  { id: "acceptEdits", label: t("Accept edits"), icon: "pencil" },
  { id: "plan", label: t("Plan"), icon: "map" },
  { id: "auto", label: t("Auto"), icon: "magic" },
  { id: "bypassPermissions", label: t("Don't ask"), icon: "warning" },
];
export const modeOf = (id: string) => modes().find((m) => m.id === id) ?? modes()[0];

const MODELS_KEY = "bh.models";
/** `claude --version` of the CLI the cached list was asked from. */
const MODELS_CLI_KEY = "bh.models.cli";

let cache: ModelInfo[] | null = null;
function cached(): ModelInfo[] | null {
  if (!cache) {
    try {
      const raw = localStorage.getItem(MODELS_KEY);
      cache = raw ? (JSON.parse(raw) as ModelInfo[]) : null;
    } catch {
      cache = null;
    }
  }
  return cache?.length ? cache : null;
}
/** The models the CLI offers (reply to `initialize`): none written here, the list only comes from the CLI. */
export const models = (): ModelInfo[] => cached() ?? [];

/** CLI version the cached list belongs to: null if unknown, or if there is no list yet. */
export function modelsCli(): string | null {
  if (!cached()) return null;
  try {
    return localStorage.getItem(MODELS_CLI_KEY);
  } catch {
    return null;
  }
}

/** `cli`: the version that gave the list, when it is known. */
export function rememberModels(list: ModelInfo[], cli?: string) {
  cache = list;
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(list));
    if (cli) localStorage.setItem(MODELS_CLI_KEY, cli);
  } catch {
    /* storage unavailable: the list stays in memory */
  }
}

let cli: CliDefaults = { model: null, effort: null };
export const setCliDefaults = (d: CliDefaults) => {
  cli = d;
};

const cleanName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "");
/** "claude-opus-5-5" → "Opus 5.5". */
function nameFromId(id: string | null | undefined): string | null {
  const m = id ? /claude-([a-z]+)-(\d+)-(\d+)/.exec(id) : null;
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : null;
}
const modelName = (m: ModelInfo) => nameFromId(m.resolvedModel) ?? cleanName(m.displayName);
const defaultResolved = () => models().find((m) => m.value === "default")?.resolvedModel ?? null;
const findModel = (id: string) => models().find((m) => m.value === id || m.resolvedModel === id);
const explicit = (id: string | null | undefined) => (id && id !== "default" ? id : null);
/** The model set in the CLI settings, if any. */
const cliModel = () => explicit(cli.model);

/**
 * Models offered: the CLI's list as it sends it, without its "default" entry, one per name.
 * Some entries are full ids (Fable comes as `claude-fable-5-2[1m]`): they stay.
 */
export function modelChoices(): ModelInfo[] {
  const seen = new Set<string>();
  return models()
    .filter((m) => m.value !== "default")
    .map((m) => ({ ...m, displayName: modelName(m) }))
    .filter((m) => !seen.has(m.displayName) && !!seen.add(m.displayName));
}

/** Without an explicit choice, the model the CLI will use is the one checked. */
export function isCurrentModel(m: ModelInfo, id: string | null | undefined): boolean {
  const wanted = explicit(id) ?? cliModel();
  if (wanted) return m.value === wanted || m.resolvedModel === wanted;
  return !!m.resolvedModel && m.resolvedModel === defaultResolved();
}

function nameOf(id: string): string {
  const known = findModel(id);
  return known ? modelName(known) : (nameFromId(id) ?? id);
}

export function prettyModel(id: string | null | undefined, resolved?: string | null): string {
  const chosen = explicit(id);
  if (chosen) return nameOf(chosen);
  const running = nameFromId(resolved);
  if (running) return running;
  const configured = cliModel();
  if (configured) return nameOf(configured);
  return nameFromId(defaultResolved()) ?? t("Default");
}

/** Effort levels the model accepts; none if it doesn't support effort. */
export function effortLevels(id: string | null | undefined): { id: string; label: string }[] {
  const wanted = explicit(id) ?? cliModel();
  const m = wanted ? findModel(wanted) : models().find((x) => x.value === "default");
  if (m?.supportsEffort === false) return [];
  const allowed = m?.supportedEffortLevels;
  return allowed?.length ? efforts().filter((e) => allowed.includes(e.id)) : efforts();
}

/** The effort actually applied: the choice made here, otherwise the one from the CLI settings. */
export const effectiveEffort = (chosen: string | null | undefined) => chosen || cli.effort;
