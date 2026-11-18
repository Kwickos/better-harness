// Diffs : rendu des lignes, diff des outils d'édition (Edit, Write…) et onglet « Modifications ».
import type { Api, GitDiff, GitFile, GitStatus } from "./api";
import { icon } from "./icons";
import { wrapWithCopy } from "./copy";
import { confirmMenu } from "./menu";
import { el } from "./transcript";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  no?: number;
}

/** Au-delà, le navigateur peine : on coupe et on le dit. */
const MAX_LINES = 3000;
/** Au-delà, déplier se fait sans animation pour ne pas recalculer la mise en page à chaque image. */
const ANIMATED_LINES = 500;
/** Taille maximale comparée ligne à ligne ; au-delà, le bloc est affiché comme remplacé. */
const LCS_LINES = 80;
const CONTEXT = 2;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function parseUnified(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      out.push({ kind: "hunk", text: m[3] || `Ligne ${newNo}` });
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1), no: newNo++ });
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", text: line.slice(1), no: oldNo++ });
    } else if (line.startsWith(" ")) {
      out.push({ kind: "ctx", text: line.slice(1), no: newNo++ });
      oldNo++;
    } else if (line.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return out;
}

/** Plus longue sous-suite commune, pour ne marquer que les lignes qui changent vraiment. */
function lcsLines(a: string[], b: string[]): DiffLine[] {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1])) {
      // À égalité, le retrait passe avant l'ajout, comme dans un diff Git.
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  return out;
}

export function editLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle: DiffLine[] =
    midA.length <= LCS_LINES && midB.length <= LCS_LINES
      ? lcsLines(midA, midB)
      : [...midA.map((text) => ({ kind: "del" as const, text })), ...midB.map((text) => ({ kind: "add" as const, text }))];
  return [
    ...a.slice(Math.max(0, head - CONTEXT), head).map((text) => ({ kind: "ctx" as const, text })),
    ...middle,
    ...a.slice(a.length - tail, a.length - tail + CONTEXT).map((text) => ({ kind: "ctx" as const, text })),
  ];
}

export interface ToolDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Diff d'un appel d'outil d'édition, ou null si l'entrée n'en décrit pas un. */
export function toolDiff(name: string, input: string): ToolDiff | null {
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  let lines: DiffLine[] | null = null;
  if (name === "Edit" && str(o.old_string) !== null && str(o.new_string) !== null) {
    lines = editLines(o.old_string as string, o.new_string as string);
  } else if (name === "MultiEdit" && Array.isArray(o.edits)) {
    lines = (o.edits as Record<string, unknown>[]).flatMap((e, i) => [
      ...(i ? [{ kind: "hunk" as const, text: `Modification ${i + 1}` }] : []),
      ...editLines(str(e.old_string) ?? "", str(e.new_string) ?? ""),
    ]);
  } else if (name === "Write" && str(o.content) !== null) {
    lines = (o.content as string).split("\n").map((text) => ({ kind: "add" as const, text }));
  } else if (name === "NotebookEdit" && str(o.new_source) !== null) {
    lines = (o.new_source as string).split("\n").map((text) => ({ kind: "add" as const, text }));
  }
  if (!lines) return null;
  return { lines, added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
}

const SIGNS: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: "", hunk: "" };

export function renderLines(lines: DiffLine[], truncated = false): HTMLElement {
  const box = el("div", "diff");
  if (!lines.some((l) => l.no !== undefined)) box.classList.add("no-numbers");
  const inner = el("div", "diff-lines");
  for (const l of lines.slice(0, MAX_LINES)) {
    if (l.kind === "hunk") {
      inner.append(el("div", "d-hunk", l.text));
      continue;
    }
    const row = el("div", `d-line is-${l.kind}`);
    row.append(el("span", "d-no", l.no === undefined ? "" : String(l.no)), el("span", "d-sign", SIGNS[l.kind]), el("span", "d-text", l.text));
    inner.append(row);
  }
  box.append(inner);
  if (truncated || lines.length > MAX_LINES) box.append(el("div", "d-hunk", "Diff tronqué : il est trop long pour être affiché en entier."));
  // Ce qu'on veut réutiliser d'un diff, c'est le code qu'il produit.
  const after = () => lines.filter((l) => l.kind === "add" || l.kind === "ctx").map((l) => l.text).join("\n");
  return wrapWithCopy(box, after, "Copier le nouveau code");
}

export function countsLabel(added: number | null | undefined, removed: number | null | undefined): HTMLElement {
  const box = el("span", "diff-count");
  if (added) box.append(el("span", "is-add", `+${added}`));
  if (removed) box.append(el("span", "is-del", `−${removed}`));
  return box;
}

// ---------------------------------------------------------------- onglet « Modifications »

interface DiffDeps {
  api: Api;
  cwd: () => string;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  reveal: (path: string) => void;
}

export function initDiffTab(d: DiffDeps) {
  let status: GitStatus | null = null;
  let key = "";
  const expanded = new Set<string>();
  const diffs = new Map<string, GitDiff>();

  async function refresh(force = false) {
    const cwd = d.cwd();
    const next = cwd ? await d.guard(d.api.gitStatus(cwd)) : null;
    if (next === undefined || d.cwd() !== cwd) return;
    const nextKey = JSON.stringify([cwd, next]);
    if (nextKey === key && !force) return;
    if (status?.root !== next?.root) expanded.clear();
    key = nextKey;
    status = next;
    diffs.clear();
    render();
  }

  function render() {
    const s = status;
    const files = s?.files ?? [];
    $("diff-branch").textContent = s?.branch ?? "";
    const total = $("diff-total");
    total.replaceChildren(countsLabel(files.reduce((n, f) => n + (f.added ?? 0), 0), files.reduce((n, f) => n + (f.removed ?? 0), 0)));
    const empty = $("diff-empty");
    empty.hidden = files.length > 0;
    $("diff-empty-title").textContent = s?.isRepo ? "Aucune modification" : "Pas de dépôt Git";
    $("diff-empty-sub").textContent = s?.isRepo ? "Les fichiers modifiés apparaîtront ici." : "Ce dossier n'est pas suivi par Git.";
    $("diff-list").replaceChildren(...files.map(fileRow));
    $("diff-note").hidden = !s?.truncated;
  }

  function fileRow(f: GitFile): HTMLElement {
    const li = el("li", "diff-file");
    const isOpen = expanded.has(f.path);
    const row = el("div", "diff-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", String(isOpen));
    row.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const cut = f.path.lastIndexOf("/");
    const name = el("span", `diff-name${f.status === "D" ? " is-gone" : ""}`, f.path.slice(cut + 1));
    row.append(name);
    if (cut > 0) row.append(el("span", "diff-dir", f.path.slice(0, cut)));
    else row.append(el("span", "diff-dir"));
    if (f.status === "U") row.append(el("span", "srv-meta is-bad", "conflit"));
    else if (f.added === null && f.removed === null) row.append(el("span", "srv-meta", "binaire"));
    else row.append(countsLabel(f.added, f.removed));

    const fold = el("div", `fold${isOpen ? "" : " is-closed"}`);
    const inner = el("div");
    fold.append(inner);
    const toggle = async () => {
      if (expanded.has(f.path)) {
        expanded.delete(f.path);
        fold.classList.add("is-closed");
        row.setAttribute("aria-expanded", "false");
        return;
      }
      expanded.add(f.path);
      row.setAttribute("aria-expanded", "true");
      await fill(f, inner, fold);
      requestAnimationFrame(() => fold.classList.remove("is-closed"));
    };
    row.addEventListener("click", () => void toggle());
    row.addEventListener("keydown", (e) => {
      if (e.target === row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        void toggle();
      }
    });

    const action = (ic: "folder" | "undo", title: string, run: (b: HTMLElement) => void) => {
      const b = el("button", "icon-btn diff-act");
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", `${title} : ${f.path}`);
      b.innerHTML = icon(ic);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run(b);
      });
      row.append(b);
    };
    if (f.status !== "D") action("folder", "Afficher dans le Finder", () => status && d.reveal(`${status.root}/${f.path}`));
    if (f.status !== "U") action("undo", "Rétablir", (b) => confirmDiscard(f, b));

    li.append(row, fold);
    if (isOpen) void fill(f, inner, fold);
    return li;
  }

  async function fill(f: GitFile, inner: HTMLElement, fold: HTMLElement) {
    const cwd = d.cwd();
    let page = diffs.get(f.path);
    if (!page) {
      page = await d.guard(d.api.gitDiff(cwd, f.path));
      if (!page) return;
      diffs.set(f.path, page);
    }
    const lines = page.binary ? [] : parseUnified(page.text);
    fold.classList.toggle("no-anim", lines.length > ANIMATED_LINES);
    if (page.binary) inner.replaceChildren(el("p", "diff-note", "Fichier binaire."));
    else if (!lines.length) inner.replaceChildren(el("p", "diff-note", "Aucune différence de contenu."));
    else inner.replaceChildren(renderLines(lines, page.truncated));
  }

  function confirmDiscard(f: GitFile, anchor: HTMLElement) {
    const isNew = f.status === "?" || f.status === "A";
    confirmMenu(
      anchor,
      isNew ? "Retirer ce nouveau fichier ?" : "Rétablir la dernière version ?",
      isNew ? "Il part à la corbeille." : "La version actuelle part à la corbeille.",
      isNew ? "Retirer" : "Rétablir",
      async () => {
        await d.guard(d.api.gitDiscard(d.cwd(), f.path));
        await refresh(true);
      },
      { align: "end" },
    );
  }

  return { refresh };
}
