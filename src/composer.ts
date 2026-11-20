// Input field: `contenteditable` rather than `textarea`, so a mention is a real element.
// Mentions are `contenteditable="false"`: arrow keys jump over them in one go and deleting
// removes them whole, with no dedicated keyboard code.
import type { Api } from "./api";
import { t } from "./i18n";
import { DUR, SCALE, enter, leave } from "./motion";
import { appendWithMentions, buildMention, fileValue, kindIcon, kindOf, setKnownCommands, type CliCommand } from "./mentions";
import { el } from "./transcript";

type Trigger = "/" | "@";
interface Item {
  value: string;
  label: string;
  /** Detail on the row: where this folder comes from. */
  hint?: string;
  /** Description shown in the bubble next to the selected row. */
  detail?: string | null;
}

interface Deps {
  api: Api;
  cwd: () => string;
  knownDirs: () => string[];
  home: (path: string) => string;
  onChange: () => void;
  onSubmit: () => void;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
}

const COMMANDS_MAX = 50;
const FILES_DEBOUNCE = 120;
const STORE = "bh.commands";
/** Same limit as `pasted.rs`. */
const PASTE_MAX_BYTES = 50 * 1024 * 1024;

/** A name that says nothing: a pasted screenshot gets a clearer one. */
const GENERIC_NAME = /^(image|blob)?(\.\w+)?$/i;

function pastedName(file: File): string {
  if (file.name && !GENERIC_NAME.test(file.name)) return file.name;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*$/, "") || "bin";
  return `${file.type.startsWith("image/") ? "screenshot" : "pasted"}.${ext}`;
}

/**
 * Files win over text only when the text is just their label: the Finder adds the file name,
 * a browser the image URL. Copied table cells come with a picture of them, but the text is what counts.
 */
function pastedFiles(data: DataTransfer | null): File[] {
  const files = [...(data?.files ?? [])];
  if (!files.length) return [];
  const text = data?.getData("text/plain").trim() ?? "";
  if (!text || /^https?:\/\/\S+$/.test(text)) return files;
  const names = new Set(files.map((f) => f.name));
  return text.split(/\r?\n|\r/).every((line) => names.has(line.trim()) || names.has(line.trim().split("/").pop() ?? "")) ? files : [];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;

function readStored(): CliCommand[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as CliCommand[];
  } catch {
    return [];
  }
}

/** Names starting with the query first, then those where it starts a word, then the rest. */
function rank(name: string, needle: string): number {
  const n = name.toLowerCase();
  if (n.startsWith(needle)) return 0;
  const i = n.indexOf(needle);
  if (i < 0) return -1;
  return /[:\-_.]/.test(n[i - 1]) ? 1 : 2;
}

export function initComposer(d: Deps) {
  const input = $("input");
  const menu = $("mention-menu");
  const list = $("mention-list");
  const bubble = $("mention-detail");

  const commands = new Map<string, CliCommand[]>();
  let lastCommands = readStored();
  setKnownCommands(lastCommands);
  let loadingCommands = false;
  let trigger: Trigger | null = null;
  let query = "";
  let items: Item[] = [];
  let index = 0;
  let shown = false;
  let filesTimer = 0;
  let filesAsked = 0;

  // ------------------------------------------------------------ text

  /** The message text: a mention yields its value, not its label. */
  function text(): string {
    let out = "";
    const walk = (node: Node) => {
      for (const child of node.childNodes) {
        if (child instanceof HTMLElement && child.dataset.mention) out += child.dataset.mention;
        else if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
        else if (child.nodeName === "BR") out += "\n";
        else {
          if (child.nodeName === "DIV" && out && !out.endsWith("\n")) out += "\n";
          walk(child);
        }
      }
    };
    walk(input);
    return out.replace(/ /g, " ");
  }

  function changed() {
    input.classList.toggle("is-empty", text().trim().length === 0);
    d.onChange();
  }

  function focus() {
    input.focus();
    const sel = window.getSelection();
    if (sel && !input.contains(sel.anchorNode)) {
      sel.selectAllChildren(input);
      sel.collapseToEnd();
    }
  }

  /** Puts a message back in the field, its mentions turned back into chips, the caret at the end. */
  function setText(value: string) {
    input.replaceChildren();
    appendWithMentions(input, value);
    close();
    changed();
    input.focus();
    const sel = window.getSelection();
    sel?.selectAllChildren(input);
    sel?.collapseToEnd();
  }

  function clear() {
    input.replaceChildren();
    close();
    changed();
  }

  // ------------------------------------------------------------ token being typed

  function typedToken() {
    const sel = window.getSelection();
    if (!sel?.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !input.contains(node)) return null;
    const upto = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const m = /(?:^|\s)([/@])(\S*)$/.exec(upto);
    if (!m) return null;
    return { node: node as Text, trigger: m[1] as Trigger, query: m[2], start: sel.anchorOffset - m[2].length - 1, end: sel.anchorOffset };
  }

  function syncTrigger() {
    const token = typedToken();
    const nextTrigger = token?.trigger ?? null;
    const nextQuery = token?.query ?? "";
    // Runs on every keystroke, arrows included: the selection only goes back to the top if the token changes.
    if (nextTrigger === trigger && nextQuery === query) return;
    trigger = nextTrigger;
    query = nextQuery;
    index = 0;
    refreshItems();
  }

  // ------------------------------------------------------------ suggestions

  function commandItems(): Item[] {
    const source = commands.get(d.cwd()) ?? lastCommands;
    const needle = query.toLowerCase();
    return source
      // Names starting with "__" are internal to the CLI: they aren't run by hand.
      .filter((c) => !c.name.startsWith("__"))
      .map((c) => ({ c, r: rank(c.name, needle) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
      .slice(0, COMMANDS_MAX)
      .map(({ c }) => ({ value: `/${c.name}`, label: `/${c.name}`, detail: c.description }));
  }

  function loadCommands() {
    const cwd = d.cwd();
    if (loadingCommands || !cwd) return;
    loadingCommands = true;
    d.api
      .listCommands(cwd)
      .then((found) => {
        commands.set(cwd, found);
        lastCommands = found;
        setKnownCommands(found);
        try {
          localStorage.setItem(STORE, JSON.stringify(found));
        } catch {
          // Without storage, the list is read again on next launch.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        loadingCommands = false;
        if (trigger === "/") {
          items = commandItems();
          render();
        }
      });
  }

  /** Other known projects, to mention a folder outside this one. */
  function projectItems(needle: string, taken: Set<string>): Item[] {
    const n = needle.toLowerCase();
    return d
      .knownDirs()
      .filter((dir) => dir !== d.cwd() && baseName(dir).toLowerCase().includes(n))
      .map((dir) => `${dir.replace(/\/$/, "")}/`)
      .filter((dir) => !taken.has(dir))
      .map((dir) => ({ value: fileValue(dir), label: baseName(dir), hint: d.home(dir) }));
  }

  function fileItem(path: string): Item {
    return path.startsWith("/") ? { value: fileValue(path), label: baseName(path), hint: d.home(path) } : { value: fileValue(path), label: path.replace(/\/$/, "") };
  }

  function loadFiles() {
    window.clearTimeout(filesTimer);
    const asked = ++filesAsked;
    const wanted = query;
    filesTimer = window.setTimeout(async () => {
      const found = await d.api.mentionFiles(d.cwd(), wanted).catch(() => [] as string[]);
      if (asked !== filesAsked || trigger !== "@") return;
      const absolute = wanted.startsWith("/") || wanted.startsWith("~");
      items = [...found.map(fileItem), ...(absolute ? [] : projectItems(wanted, new Set(found)))].slice(0, COMMANDS_MAX);
      index = Math.min(index, Math.max(0, items.length - 1));
      render();
    }, FILES_DEBOUNCE);
  }

  function refreshItems() {
    window.clearTimeout(filesTimer);
    if (trigger === "/") {
      items = commandItems();
      loadCommands();
    } else if (trigger === "@") {
      loadFiles();
      return;
    } else {
      items = [];
    }
    render();
  }

  // ------------------------------------------------------------ menu

  function renderDetail() {
    const item = items[index];
    bubble.hidden = !item?.detail;
    if (item?.detail) bubble.replaceChildren(el("b", undefined, item.label), el("p", undefined, item.detail));
  }

  function select(i: number) {
    index = i;
    for (const [n, row] of [...list.children].entries()) row.setAttribute("aria-selected", String(n === index));
    list.children[index]?.scrollIntoView({ block: "nearest" });
    renderDetail();
  }

  function render() {
    const waiting = trigger === "/" && items.length === 0 && loadingCommands;
    const open = trigger !== null && (items.length > 0 || waiting);
    if (open) {
      list.replaceChildren(
        ...(waiting
          ? [el("div", "menu-note", t("Loading skills…"))]
          : items.map((item, i) => {
              const row = el("button", "mention-item");
              row.type = "button";
              row.setAttribute("role", "option");
              row.setAttribute("aria-selected", String(i === index));
              const glyph = kindIcon(kindOf(item.value));
              if (glyph) {
                const ic = el("span", "mi-icon");
                ic.innerHTML = glyph;
                row.append(ic);
              }
              row.append(el("span", "mention-label", item.label));
              if (item.hint) row.append(el("span", "mention-hint", item.hint));
              // On `mousedown`: the field keeps focus and the caret.
              row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                accept(item);
              });
              row.addEventListener("mouseenter", () => select(i));
              return row;
            })),
      );
      renderDetail();
    }
    if (open && !shown) {
      shown = true;
      menu.hidden = false;
      void enter(menu, { opacity: "0", transform: `scale(${SCALE.medium})` }, { duration: DUR.fast });
    } else if (!open && shown) {
      shown = false;
      void leave(menu, { opacity: 0, transform: `scale(${SCALE.tiny})` }).then((done) => {
        if (done && !shown) {
          menu.hidden = true;
          menu.style.removeProperty("opacity");
          menu.style.removeProperty("transform");
        }
      });
    }
  }

  function close() {
    filesAsked++;
    window.clearTimeout(filesTimer);
    trigger = null;
    query = "";
    items = [];
    render();
  }

  function accept(item: Item) {
    const chip = buildMention(item.value, item.label);
    const space = document.createTextNode(" ");
    const token = typedToken();
    if (token) {
      const after = token.node.splitText(token.start);
      after.deleteData(0, token.end - token.start);
      token.node.parentNode?.insertBefore(chip, after);
      after.parentNode?.insertBefore(space, after);
    } else {
      input.append(chip, space);
    }
    void enter(chip, { opacity: "0", filter: "blur(2px)" }, { duration: DUR.quick, ease: "easeInOut" });
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(space);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    input.focus();
    close();
    changed();
  }

  /** Adds a file at the end of the message, like a typed mention. */
  function attach(path: string) {
    // A field emptied by hand can keep a line break: the file then goes on the first line.
    const before = text().trim() ? text() : "";
    setText(`${before}${before && !/\s$/.test(before) ? " " : ""}${fileValue(path)} `);
  }

  // ------------------------------------------------------------ events

  input.addEventListener("input", () => {
    changed();
    syncTrigger();
  });
  input.addEventListener("keyup", (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) syncTrigger();
  });
  input.addEventListener("click", syncTrigger);
  input.addEventListener("blur", close);
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const files = pastedFiles(e.clipboardData);
    if (!files.length) {
      document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
      return;
    }
    void (async () => {
      for (const file of files) {
        // Stopped here rather than in Rust, which would only refuse it once read into memory.
        const saved = file.size > PASTE_MAX_BYTES ? Promise.reject(t("{name} is over 50 MB: drag it in instead.", { name: file.name || pastedName(file) })) : d.api.savePasted(file, pastedName(file));
        const path = await d.guard(saved);
        if (path) attach(path);
      }
    })();
  });

  // Files dragged anywhere on the window land in the message; the field shows it will take them.
  const form = input.closest("form") ?? input;
  void d.api.onFileDrop((e) => {
    // A modal (settings) covers the conversation: nothing to drop into.
    const covered = document.querySelector("dialog[open]") !== null;
    if (e.type === "over") {
      if (e.files !== null) form.classList.toggle("is-dropping", e.files && !covered);
      return;
    }
    form.classList.remove("is-dropping");
    if (e.type === "drop" && !covered) for (const path of e.paths) attach(path);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (shown && items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        select((index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[index]);
        return;
      }
    }
    if (shown && e.key === "Escape") {
      // Otherwise Esc would also interrupt Claude: the menu goes first.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      d.onSubmit();
    }
  });

  input.classList.add("is-empty");

  return {
    text,
    setText,
    attach,
    clear,
    focus,
    setPlaceholder: (value: string) => {
      input.dataset.placeholder = value;
    },
  };
}
