import type { Artifact, CliDefaults, ModelInfo, ToolResultEv } from "./api";
import type { IconName } from "./icons";

export const DELETE_NOTE = "Elle part à la corbeille et disparaît aussi de Claude Code.";

export const SIM_TOOL = "mcp__ios-simulator__control";
/** L'outil servi par l'app pour montrer des fichiers dans la conversation (src-tauri/src/files_tool.rs). */
export const FILES_TOOL = "mcp__harness__send_files";

/** Les fichiers que Claude veut montrer, et la ligne qui les accompagne. */
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

/** Ce que Claude demande au simulateur, en clair : « toucher 120, 340 · iPhone 17e ». */
export function simulatorAction(input: string): string {
  let a: { action?: string; device?: string; x?: number; y?: number; x2?: number; y2?: number; text?: string };
  try {
    a = JSON.parse(input) as typeof a;
  } catch {
    return "";
  }
  const act: Record<string, string> = {
    list: "lister les appareils",
    boot: "démarrer",
    screenshot: "regarder l'écran",
    tap: `toucher ${a.x}, ${a.y}`,
    swipe: `glisser ${a.x}, ${a.y} → ${a.x2}, ${a.y2}`,
    type: `écrire « ${a.text ?? ""} »`,
    key: `touche ${a.text ?? ""}`,
    home: "accueil",
    open_url: `ouvrir ${a.text ?? ""}`,
  };
  const what = act[a.action ?? ""] ?? a.action ?? "";
  return a.device ? `${what} · ${a.device}` : what;
}

const fileBase = (path: string) => path.split("/").pop() ?? path;

/** Ce que Claude demande à l'outil `Artifact`, en clair : « publier rapport.html ». */
export function artifactAction(input: string): string {
  let a: { action?: string; title?: string; file_path?: string; url?: string };
  try {
    a = JSON.parse(input) as typeof a;
  } catch {
    return "";
  }
  const name = a.title ?? (a.file_path ? fileBase(a.file_path) : "");
  const act: Record<string, string> = {
    publish: `publier ${name}`.trim(),
    read: "lire un artefact",
    list: "lister les artefacts",
    delete: "supprimer un artefact",
    open: "ouvrir un artefact",
    quickstart: "préparer un artefact",
    pin: "épingler un artefact",
    unpin: "désépingler un artefact",
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
/** Le transcript garde la publication : sans cette liste, l'artefact supprimé reviendrait à sa relecture. */
export function rememberDeletedArtifact(url: string) {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify([...deletedArtifacts().filter((x) => x !== url), url].slice(-500)));
  } catch {
    /* stockage indisponible : l'artefact réapparaîtrait seulement à la relecture */
  }
}

/**
 * Tient la liste à jour d'après un résultat de l'outil `Artifact`, le plus récent en tête.
 * Renvoie l'adresse de l'artefact à montrer, s'il y en a un.
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
    // Avec `path`, seule une pièce jointe de l'artefact disparaît.
    const at = a.path ? -1 : list.findIndex((x) => x.url === a.url);
    if (at >= 0) list.splice(at, 1);
    return null;
  }
  if (action !== "publish" || a.asset || !ev.artifact || deletedArtifacts().includes(ev.artifact.url)) return null;
  const { url, title, path } = ev.artifact;
  const at = list.findIndex((x) => x.url === url);
  const known = at >= 0 ? list.splice(at, 1)[0] : undefined;
  list.unshift({ url, title: title ?? a.title ?? known?.title ?? (path ? fileBase(path) : "Artefact"), path: path ?? known?.path ?? null });
  return url;
}

export const EFFORTS: { id: string; label: string }[] = [
  { id: "low", label: "Bas" },
  { id: "medium", label: "Moyen" },
  { id: "high", label: "Élevé" },
  { id: "xhigh", label: "Très élevé" },
  { id: "max", label: "Max" },
];
export const effortLabel = (id: string | null | undefined) => EFFORTS.find((e) => e.id === id)?.label ?? "";

export const MODES: { id: string; label: string; icon: IconName }[] = [
  { id: "default", label: "Demander", icon: "hand" },
  { id: "acceptEdits", label: "Modifications auto", icon: "pencil" },
  { id: "plan", label: "Plan", icon: "map" },
  { id: "auto", label: "Auto", icon: "magic" },
  { id: "bypassPermissions", label: "Sans demander", icon: "warning" },
];
export const modeOf = (id: string) => MODES.find((m) => m.id === id) ?? MODES[0];

/** Liste de repli tant que le CLI n'a pas fourni la sienne (réponse à `initialize`). */
const FALLBACK: ModelInfo[] = [
  { value: "default", displayName: "Par défaut" },
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

let cache: ModelInfo[] | null = null;
export function models(): ModelInfo[] {
  if (!cache) {
    try {
      const raw = localStorage.getItem("bh.models");
      cache = raw ? (JSON.parse(raw) as ModelInfo[]) : null;
    } catch {
      cache = null;
    }
  }
  return cache?.length ? cache : FALLBACK;
}
export function rememberModels(list: ModelInfo[]) {
  cache = list;
  try {
    localStorage.setItem("bh.models", JSON.stringify(list));
  } catch {
    /* stockage indisponible : la liste reste en mémoire */
  }
}

let cli: CliDefaults = { model: null, effort: null };
export const setCliDefaults = (d: CliDefaults) => {
  cli = d;
};

const cleanName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "");
/** « claude-opus-5-5 » → « Opus 5.5 ». */
function nameFromId(id: string | null | undefined): string | null {
  const m = id ? /claude-([a-z]+)-(\d+)-(\d+)/.exec(id) : null;
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : null;
}
const modelName = (m: ModelInfo) => nameFromId(m.resolvedModel) ?? cleanName(m.displayName);
const defaultResolved = () => models().find((m) => m.value === "default")?.resolvedModel ?? null;
const findModel = (id: string) => models().find((m) => m.value === id || m.resolvedModel === id);
const explicit = (id: string | null | undefined) => (id && id !== "default" ? id : null);
/** Le modèle fixé dans les réglages du CLI, s'il y en a un. */
const cliModel = () => explicit(cli.model);

/** Modèles proposés : les alias principaux (Opus, Sonnet, Haiku…), un seul par famille. */
export const modelChoices = () =>
  models()
    .filter((m) => m.value !== "default" && !m.value.startsWith("claude-"))
    .map((m) => ({ ...m, displayName: modelName(m) }));

/** Sans choix explicite, c'est le modèle que le CLI utilisera qui est coché. */
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
  return nameFromId(defaultResolved()) ?? "Par défaut";
}

/** Niveaux d'effort que le modèle accepte ; aucun s'il n'en gère pas. */
export function effortLevels(id: string | null | undefined): { id: string; label: string }[] {
  const wanted = explicit(id) ?? cliModel();
  const m = wanted ? findModel(wanted) : models().find((x) => x.value === "default");
  if (m?.supportsEffort === false) return [];
  const allowed = m?.supportedEffortLevels;
  return allowed?.length ? EFFORTS.filter((e) => allowed.includes(e.id)) : EFFORTS;
}

/** L'effort réellement appliqué : le choix fait ici, sinon celui des réglages du CLI. */
export const effectiveEffort = (chosen: string | null | undefined) => chosen || cli.effort;
