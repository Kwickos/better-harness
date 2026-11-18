// Champ de saisie : `contenteditable` plutôt que `textarea`, pour qu'une mention soit un vrai élément.
// Elles sont `contenteditable="false"` : les flèches les franchissent d'un coup et la suppression
// les retire entières, sans code clavier dédié.
import type { Api } from "./api";
import { DUR, SCALE, enter, leave } from "./motion";
import { appendWithMentions, buildMention, fileValue, kindIcon, kindOf, setKnownCommands, type CliCommand } from "./mentions";
import { el } from "./transcript";

type Trigger = "/" | "@";
interface Item {
  value: string;
  label: string;
  /** Précision sur la ligne : d'où vient ce dossier. */
  hint?: string;
  /** Description affichée dans la bulle à côté de la ligne sélectionnée. */
  detail?: string | null;
}

interface Deps {
  api: Api;
  cwd: () => string;
  knownDirs: () => string[];
  home: (path: string) => string;
  onChange: () => void;
  onSubmit: () => void;
}

const COMMANDS_MAX = 50;
const FILES_DEBOUNCE = 120;
const STORE = "bh.commands";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const baseName = (path: string) => path.replace(/\/$/, "").split("/").pop() ?? path;

function readStored(): CliCommand[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "[]") as CliCommand[];
  } catch {
    return [];
  }
}

/** Les noms qui commencent par la saisie d'abord, puis ceux où elle commence un mot, puis le reste. */
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

  // ------------------------------------------------------------ texte

  /** Le texte du message : une mention rend sa valeur, pas son libellé. */
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

  /** Remet un message dans le champ, ses mentions redevenues des pastilles, le curseur à la fin. */
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

  // ------------------------------------------------------------ jeton en cours de frappe

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
    // Tourne à chaque frappe, flèches comprises : la sélection ne revient en tête que si le jeton change.
    if (nextTrigger === trigger && nextQuery === query) return;
    trigger = nextTrigger;
    query = nextQuery;
    index = 0;
    refreshItems();
  }

  // ------------------------------------------------------------ propositions

  function commandItems(): Item[] {
    const source = commands.get(d.cwd()) ?? lastCommands;
    const needle = query.toLowerCase();
    return source
      // Les noms en « __ » sont internes au CLI : ils ne se lancent pas à la main.
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
          // Sans stockage, la liste se relira au prochain lancement.
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

  /** Les autres projets connus, pour mentionner un dossier hors de celui-ci. */
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
          ? [el("div", "menu-note", "Lecture des skills…")]
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
              // Au `mousedown` : le champ garde le focus et le curseur.
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

  // ------------------------------------------------------------ événements

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
    document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
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
      // Sinon Échap interromprait aussi Claude : le menu passe d'abord.
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
    /** Ajoute un fichier en fin de message, comme une mention tapée. */
    attach(path: string) {
      const before = text();
      setText(`${before}${before && !/\s$/.test(before) ? " " : ""}${fileValue(path)} `);
    },
    clear,
    focus,
    setPlaceholder: (value: string) => {
      input.dataset.placeholder = value;
    },
  };
}
