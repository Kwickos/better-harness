// Diffs: line rendering, diffs of editing tools (Edit, Write…) and the "Changes" tab.
import type { Api, GitDiff, GitFile, GitStatus } from "./api";
import { icon } from "./icons";
import { wrapWithCopy } from "./copy";
import { t } from "./i18n";
import { confirmMenu } from "./menu";
import { el } from "./transcript";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  no?: number;
}

/** Beyond this, the browser struggles: cut and say so. */
const MAX_LINES = 3000;
/** Beyond this, expanding is not animated, so layout isn't recomputed on every frame. */
const ANIMATED_LINES = 500;
/** Largest size compared line by line; beyond it, the block shows as replaced. */
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
      out.push({ kind: "hunk", text: m[3] || t("Line {n}", { n: newNo }) });
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

/** Longest common subsequence, to only mark lines that really change. */
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
      // On a tie, the removal comes before the addition, as in a Git diff.
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

/** Diff of an editing tool call, or null if the input doesn't describe one. */
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
      ...(i ? [{ kind: "hunk" as const, text: t("Edit {n}", { n: i + 1 }) }] : []),
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
  if (truncated || lines.length > MAX_LINES) box.append(el("div", "d-hunk", t("Diff truncated: too long to show in full.")));
  // What you want to reuse from a diff is the code it produces.
  const after = () => lines.filter((l) => l.kind === "add" || l.kind === "ctx").map((l) => l.text).join("\n");
  return wrapWithCopy(box, after, t("Copy new code"));
}

export function countsLabel(added: number | null | undefined, removed: number | null | undefined): HTMLElement {
  const box = el("span", "diff-count");
  if (added) box.append(el("span", "is-add", `+${added}`));
  if (removed) box.append(el("span", "is-del", `−${removed}`));
  return box;
}

// ---------------------------------------------------------------- "Changes" tab

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
    $("diff-empty-title").textContent = s?.isRepo ? t("No changes") : t("Not a Git repository");
    $("diff-empty-sub").textContent = s?.isRepo ? t("Changed files will appear here.") : t("This folder isn't tracked by Git.");
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
    if (f.status === "U") row.append(el("span", "srv-meta is-bad", t("conflict")));
    else if (f.added === null && f.removed === null) row.append(el("span", "srv-meta", t("binary")));
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
      b.setAttribute("aria-label", t("{action}: {path}", { action: title, path: f.path }));
      b.innerHTML = icon(ic);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run(b);
      });
      row.append(b);
    };
    if (f.status !== "D") action("folder", t("Show in Finder"), () => status && d.reveal(`${status.root}/${f.path}`));
    if (f.status !== "U") action("undo", t("Revert"), (b) => confirmDiscard(f, b));

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
    if (page.binary) inner.replaceChildren(el("p", "diff-note", t("Binary file.")));
    else if (!lines.length) inner.replaceChildren(el("p", "diff-note", t("No content differences.")));
    else inner.replaceChildren(renderLines(lines, page.truncated));
  }

  function confirmDiscard(f: GitFile, anchor: HTMLElement) {
    const isNew = f.status === "?" || f.status === "A";
    confirmMenu(
      anchor,
      isNew ? t("Remove this new file?") : t("Revert to the last version?"),
      isNew ? t("It goes to the Trash.") : t("The current version goes to the Trash."),
      isNew ? t("Remove") : t("Revert"),
      async () => {
        await d.guard(d.api.gitDiscard(d.cwd(), f.path));
        await refresh(true);
      },
      { align: "end" },
    );
  }

  return { refresh };
}
