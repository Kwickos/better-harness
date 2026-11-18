// The panel's "File" tab: a file previewed (image, PDF, audio, video) or edited as text
// (`.env`, configs…). The field of the head finds a file of the project, dot files included.
// A save refuses to overwrite a file changed on disk meanwhile (src-tauri/src/file_view.rs).
import type { Api, FileView } from "./api";
import { fmtNumber, t, tp } from "./i18n";
import { icon } from "./icons";
import { confirmMenu } from "./menu";
import { el } from "./transcript";

interface Deps {
  api: Api;
  cwd: () => string;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  reveal: (path: string) => void;
  /** Opens the file in its macOS app; `false` if it could run (then shown in the Finder). */
  openExternal: (path: string) => void;
  /** The tab must be shown (a file was just opened). */
  show: () => void;
  /** A file is open or not anymore: the bar button appears or goes. */
  changed: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function fileSize(bytes: number): string {
  if (bytes < 1024) return tp(bytes, "{n} byte", "{n} bytes");
  const units = ["{n} KB", "{n} MB", "{n} GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return t(units[i], { n: fmtNumber(v, { maximumFractionDigits: 1 }) });
}

export function initFileTab(d: Deps) {
  const field = $<HTMLInputElement>("file-q");
  const results = $("file-results");
  const view = $("file-view");
  const empty = $("file-empty");
  const save = $<HTMLButtonElement>("file-save");
  const actions = $("file-actions");
  let file: FileView | null = null;
  let editor: HTMLTextAreaElement | null = null;
  let saved = "";
  let found: string[] = [];
  let pick = 0;
  let searchSeq = 0;

  const dirty = () => !!editor && editor.value !== saved;
  /** Path shown in the field: relative to the project when inside it. */
  const shownPath = (path: string) => {
    const root = d.cwd().replace(/\/$/, "");
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  };

  function renderHead() {
    actions.hidden = !file;
    save.hidden = !dirty();
    if (document.activeElement !== field) field.value = file ? shownPath(file.path) : "";
    field.title = file?.path ?? "";
  }

  function render() {
    editor = null;
    const f = file;
    empty.hidden = !!f;
    view.querySelectorAll(":scope > :not(#file-empty)").forEach((n) => n.remove());
    if (!f) return renderHead();
    if (f.kind === "text") {
      const ta = el("textarea", "file-text");
      ta.spellcheck = false;
      ta.autocapitalize = "off";
      ta.setAttribute("autocorrect", "off");
      ta.value = f.text ?? "";
      ta.readOnly = f.readonly;
      ta.setAttribute("aria-label", f.name);
      ta.addEventListener("input", renderHead);
      ta.addEventListener("keydown", (e) => {
        // Tab indents rather than leaving the text.
        if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          document.execCommand("insertText", false, "\t");
        }
      });
      saved = ta.value;
      editor = ta;
      view.append(ta);
    } else if (f.kind === "image" && f.url) {
      const box = el("div", "file-media");
      const img = el("img");
      img.src = f.url;
      img.alt = f.name;
      img.draggable = false;
      box.append(img);
      view.append(box);
    } else if (f.kind === "pdf" && f.url) {
      const frame = el("iframe", "file-pdf");
      frame.src = f.url;
      frame.title = f.name;
      view.append(frame);
    } else if ((f.kind === "video" || f.kind === "audio") && f.url) {
      const box = el("div", "file-media");
      const media = el(f.kind);
      media.src = f.url;
      media.controls = true;
      media.preload = "metadata";
      box.append(media);
      view.append(box);
    } else {
      const box = el("div", "panel-empty");
      box.append(
        el("p", "panel-title", f.name),
        el("p", "panel-sub", f.kind === "large" ? t("Too large to edit here ({size}).", { size: fileSize(f.size) }) : t("No preview for this file ({size}).", { size: fileSize(f.size) })),
      );
      const open = el("button", "btn btn-soft", t("Open in its app"));
      open.type = "button";
      open.addEventListener("click", () => d.openExternal(f.path));
      box.append(open);
      view.append(box);
    }
    renderHead();
  }

  async function load(path: string, quiet = false) {
    const next = quiet ? await d.api.fileOpen(d.cwd(), path).catch(() => undefined) : await d.guard(d.api.fileOpen(d.cwd(), path));
    if (!next) return false;
    // Same content (a refresh after a tool): nothing moves, the caret stays put.
    if (quiet && file && next.path === file.path && next.modified === file.modified) return true;
    const scroll = quiet ? editor?.scrollTop ?? 0 : 0;
    file = next;
    render();
    if (editor && scroll) editor.scrollTop = scroll;
    d.changed();
    return true;
  }

  /** Leaves unsaved text only once the user agreed. */
  function whenLeaving(anchor: HTMLElement, go: () => void) {
    if (!dirty()) return go();
    confirmMenu(anchor, t("Discard your changes?"), t("{name} has unsaved changes.", { name: file?.name ?? "" }), t("Discard"), go, { align: "end" });
  }

  async function doSave(force = false) {
    const f = file;
    if (!f || !editor || !dirty()) return;
    const text = editor.value;
    try {
      const modified = await d.api.fileSave(f.path, text, force ? null : f.modified);
      f.modified = modified;
      f.text = text;
      f.size = new TextEncoder().encode(text).length;
      saved = text;
      renderHead();
    } catch (e) {
      if (String(e) !== "conflict") return void d.guard(Promise.reject(e));
      confirmMenu(save, t("The file changed on disk"), t("It was modified since you opened it. Overwrite it with your version?"), t("Overwrite"), () => void doSave(true), { align: "end" });
    }
  }

  // ------------------------------------------------------------ finding a file

  function renderResults() {
    results.hidden = !found.length || document.activeElement !== field;
    results.replaceChildren(
      ...found.map((p, i) => {
        const b = el("button", "menu-item");
        b.type = "button";
        b.tabIndex = -1;
        if (i === pick) b.classList.add("is-active");
        const cut = p.lastIndexOf("/");
        const ic = el("span", "mi-icon");
        ic.innerHTML = icon("file");
        const text = el("span", "mi-text");
        text.append(el("b", undefined, p.slice(cut + 1)));
        if (cut > 0) text.append(el("small", undefined, p.slice(0, cut)));
        b.append(ic, text);
        // Before the field loses focus (blur would close the list first).
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          choose(p);
        });
        return b;
      }),
    );
  }

  async function search() {
    const q = field.value.trim();
    const seq = ++searchSeq;
    const list = d.cwd() || q.startsWith("/") || q.startsWith("~") ? await d.api.mentionFiles(d.cwd(), q, true).catch(() => [] as string[]) : [];
    if (seq !== searchSeq) return;
    // Folders are only useful to go into, by typing: files only.
    found = list.filter((p) => !p.endsWith("/")).slice(0, 12);
    pick = 0;
    renderResults();
  }

  function choose(path: string) {
    whenLeaving(field, () => {
      found = [];
      results.hidden = true;
      field.blur();
      void load(path).then((ok) => ok && editor?.focus());
    });
  }

  field.addEventListener("focus", () => {
    field.select();
    void search();
  });
  field.addEventListener("input", () => void search());
  field.addEventListener("blur", () => {
    results.hidden = true;
    renderHead();
  });
  field.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!found.length) return;
      pick = (pick + (e.key === "ArrowDown" ? 1 : -1) + found.length) % found.length;
      renderResults();
      results.children[pick]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const typed = field.value.trim();
      const target = found[pick] ?? typed;
      if (target) choose(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      field.blur();
    }
  });

  save.addEventListener("click", () => void doSave());
  $("file-external").addEventListener("click", () => file && d.openExternal(file.path));
  $("file-reveal").addEventListener("click", () => file && d.reveal(file.path));
  $("file-close").addEventListener("click", (e) =>
    whenLeaving(e.currentTarget as HTMLElement, () => {
      file = null;
      render();
      d.changed();
    }),
  );
  view.addEventListener("keydown", (e) => {
    if (e.metaKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doSave();
    }
  });

  render();
  return {
    hasFile: () => !!file,
    /** Opens a file (absolute, or relative to the project) and shows the tab. */
    async open(path: string) {
      const go = async () => {
        if (await load(path)) d.show();
      };
      if (file && dirty()) {
        d.show();
        whenLeaving(field, () => void go());
      } else {
        await go();
      }
    },
    /** Puts the caret in the search field. */
    focusSearch() {
      field.focus();
    },
    /** Files may have changed (a tool ran, the window came back): an untouched file is read again. */
    refresh() {
      if (file && !dirty()) void load(file.path, true);
    },
  };
}
