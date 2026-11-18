// "/" (skills) and "@" (files, folders) mentions: their value in the message and their chip.
import { icon } from "./icons";

export interface CliCommand {
  name: string;
  description?: string | null;
}

/** A chip only appears on "/word" if it is a real command: "/usr/bin" stays text. */
let known = new Set<string>();
export const setKnownCommands = (list: CliCommand[]) => {
  known = new Set(list.map((c) => c.name));
};

/** Same syntax as Claude Code: a path with spaces goes in quotes. */
export const fileValue = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);
const pathOf = (value: string) => value.replace(/^@"?/, "").replace(/"$/, "");
const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;

export function kindOf(value: string): "skill" | "folder" | "file" {
  return value.startsWith("/") ? "skill" : pathOf(value).endsWith("/") ? "folder" : "file";
}

/** A skill is recognized by its "/": only files and folders get an icon. */
export const kindIcon = (kind: "skill" | "folder" | "file", size = 14) => (kind === "skill" ? "" : icon(kind, size));

export function buildMention(value: string, label: string): HTMLSpanElement {
  const kind = kindOf(value);
  const chip = document.createElement("span");
  chip.className = `mention is-${kind}`;
  chip.dataset.mention = value;
  chip.contentEditable = "false";
  chip.title = value.startsWith("/") ? value : pathOf(value);
  if (kind !== "skill") {
    const ic = document.createElement("span");
    ic.className = "mention-icon";
    ic.innerHTML = kindIcon(kind, 12);
    chip.append(ic);
  }
  chip.append(label);
  return chip;
}

const TOKEN = /(^|\s)(@"[^"\n]+"|@[^\s"]+|\/[a-zA-Z0-9][\w:.-]*)(?=\s|$)/g;

/** Text of a sent message: mentions turn back into chips, the rest stays text. */
export function appendWithMentions(parent: HTMLElement, text: string) {
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const value = m[2];
    if (value.startsWith("/") && !known.has(value.slice(1))) continue;
    const start = m.index + m[1].length;
    if (start > last) parent.append(text.slice(last, start));
    const path = pathOf(value);
    parent.append(buildMention(value, value.startsWith("/") ? value : path.startsWith("/") ? baseName(path) : path.replace(/\/$/, "")));
    last = start + value.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
