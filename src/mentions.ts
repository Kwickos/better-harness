// Mentions « / » (skills) et « @ » (fichiers, dossiers) : leur valeur dans le message et leur pastille.
import { icon } from "./icons";

export interface CliCommand {
  name: string;
  description?: string | null;
}

/** Une pastille n'apparaît sur « /mot » que si c'est une vraie commande : « /usr/bin » reste du texte. */
let known = new Set<string>();
export const setKnownCommands = (list: CliCommand[]) => {
  known = new Set(list.map((c) => c.name));
};

/** Même écriture que Claude Code : un chemin avec des espaces passe entre guillemets. */
export const fileValue = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);
const pathOf = (value: string) => value.replace(/^@"?/, "").replace(/"$/, "");
const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;

export function kindOf(value: string): "skill" | "folder" | "file" {
  return value.startsWith("/") ? "skill" : pathOf(value).endsWith("/") ? "folder" : "file";
}

/** Une skill se reconnaît à son « / » : seuls les fichiers et dossiers ont une icône. */
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

/** Texte d'un message envoyé : les mentions redeviennent des pastilles, le reste reste du texte. */
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
