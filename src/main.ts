import "./errors";
import { tauriApi, type UpdateState, type UsageWindows, type Api, type ContextUsage, type HistoryEntry, type PermissionEv, type ProcStat, type SessionInfo, type Settings, type UiEvent } from "./api";
import { icon, type IconName } from "./icons";
import { DELETE_NOTE, effectiveEffort, effortLabel, effortLevels, isCurrentModel, MODES, modeOf, modelChoices, prettyModel, rememberDeletedArtifact, rememberModels, setCliDefaults, SIM_TOOL, simulatorAction, artifactAction } from "./labels";
import { closeMenu, confirmMenu, menuElement, menuItem, onMenuChange, segmented, showMenu, type MenuEntry } from "./menu";
import { animateOut, DUR, enter, flipY, goLive, heightIn, heightOut, iconIn, leave, motionLive, swapText, textIn } from "./motion";
import { initComposer } from "./composer";
import { renderLines, toolDiff } from "./diff";
import { decorateCode, wrapWithCopy } from "./copy";
import { renderMarkdown } from "./markdown";
import { questionCard } from "./question";
import { initPanel } from "./panel";
import { initSettings } from "./settings";
import { initWorld } from "./world";
import { initAttachments } from "./attachments";
import { SessionView, TranscriptRenderer, el, type BlockView, type Item, type ToolView } from "./transcript";

// Hors de Tauri (navigateur), un backend simulé permet de travailler l'interface.
const inTauri = "__TAURI_INTERNALS__" in window;
const api: Api = inTauri ? tauriApi : (await import("./mock")).mockApi;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const paintIcons = (root: ParentNode = document) => {
  for (const n of root.querySelectorAll<HTMLElement>("[data-icon]")) if (!n.firstChild) n.innerHTML = icon(n.dataset.icon as IconName);
};
paintIcons();

const views = new Map<string, SessionView>();
const rss = new Map<string, ProcStat>();
const contexts = new Map<string, ContextUsage>();
let active: string | null = null;
let settings: Settings;
let history: HistoryEntry[] = [];
let appHome = "";
/** Dossier des conversations lancées sans projet. */
let scratchDir = "";
/** Conversation pas encore créée : elle naît au premier message envoyé. `cwd` vide : sans dossier. */
const draft: { cwd: string; model: string | null; mode: string; effort: string | null; advisor: string | null } = { cwd: "", model: null, mode: "default", effort: null, advisor: null };

const renderer = new TranscriptRenderer(
  $("transcript"),
  $("items"),
  $("stream"),
  () => {
    const v = activeView();
    if (v?.info.cliId) {
      v.historyLimit *= 2;
      void loadHistoryInto(v, v.info.cliId);
    }
  },
  {
    edit: (text) => composer.setText(text),
    retry: (text) => void sendText(text),
  },
  (tv, settled) => attachmentsUi.render(tv, currentCwd(), settled),
);
const attachmentsUi = initAttachments({ api, guard, reveal, overlayChanged: () => panel.syncBrowser() });

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const home = (p: string) => (appHome && p.startsWith(appHome) ? `~${p.slice(appHome.length)}` : p);
const NO_FOLDER = "Sans dossier";
const projectName = (cwd: string) => (cwd === scratchDir ? NO_FOLDER : base(cwd));
const nf = new Intl.NumberFormat("fr-FR");
const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".", ",")} Go` : `${Math.round(mb)} Mo`);

let toastTimer = 0;
function toast(text: string) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("is-leaving");
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => animateOut(t, "is-leaving", () => (t.hidden = true)), 4000);
}

async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast(String(e));
    return undefined;
  }
}

function openExternal(url: string) {
  if (inTauri) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  else window.open(url, "_blank", "noopener");
}

function view(info: SessionInfo): SessionView {
  let v = views.get(info.sid);
  if (!v) {
    v = new SessionView(info);
    views.set(info.sid, v);
  } else {
    v.info = info;
  }
  return v;
}

const activeView = () => (active ? views.get(active) : undefined);
const currentCwd = () => activeView()?.info.cwd ?? (draft.cwd || scratchDir);
const activityOf = (v: SessionView) => (v.perms.size || v.info.pendingPermissions ? "wait" : v.info.state === "busy" ? "busy" : "");

function reveal(path: string) {
  if (inTauri) void import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(path));
}

const composer = initComposer({
  api,
  cwd: currentCwd,
  knownDirs: () => knownDirs(),
  home,
  onChange: () => renderComposer(),
  onSubmit: () => $("composer").dispatchEvent(new Event("submit", { cancelable: true })),
});

function removeArtifact(url: string) {
  rememberDeletedArtifact(url);
  for (const v of views.values()) v.artifacts = v.artifacts.filter((a) => a.url !== url);
}

const panel = initPanel({ api, inTauri, cwd: currentCwd, sid: () => active, guard, openExternal, reveal, attach: (path) => composer.attach(path), artifacts: () => activeView()?.artifacts ?? [], removeArtifact });
// Monde pixel art : une créature par Claude de la conversation (mode Pixel art seulement).
const world = initWorld({
  active: () => active,
  modelOf: (sid) => {
    const v = sid ? views.get(sid) : undefined;
    return v ? prettyModel(v.info.model, v.init?.model) : prettyModel(draft.model);
  },
});
const settingsUi = initSettings({
  api,
  guard,
  home,
  onHistoryChanged: () => void refreshHistory(),
  onSaved: (s) => {
    settings = s;
    if (!active) {
      draft.model = s.defaultModel;
      draft.effort = s.defaultEffort;
      draft.mode = s.defaultPermissionMode;
      renderComposer();
    }
  },
  onClose: () => panel.syncBrowser(),
});
async function openSettings() {
  closeMenu();
  await settingsUi.open();
  panel.syncBrowser();
}

// ---------------------------------------------------------------- fondus de bord de liste

function watchFade(node: HTMLElement) {
  const update = () => {
    node.classList.toggle("is-scrolled", node.scrollTop > 4);
    node.classList.toggle("at-end", node.scrollHeight - node.scrollTop - node.clientHeight < 4);
  };
  node.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(node);
  new MutationObserver(update).observe(node, { childList: true, subtree: true });
  update();
}
for (const n of document.querySelectorAll<HTMLElement>(".fade-y")) watchFade(n);

// ---------------------------------------------------------------- barre latérale

interface Thread {
  title: string;
  cwd: string;
  time: number;
  sid?: string;
  hist?: HistoryEntry;
  activity: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Préférence d'affichage : tant pis si elle n'est pas gardée.
  }
}

const expanded = new Set<string>();
const collapsed = new Set<string>(readJson<string[]>("bh.projects.collapsed", []));
let projectOrder = readJson<string[]>("bh.projects.order", []);
/** Pendant un glisser-déposer, la liste ne doit pas être reconstruite sous le pointeur. */
let reordering = false;
let justDragged = false;
/** Conversations en cours d'archivage ou de suppression : elles quittent la liste tout de suite. */
const removing = new Set<string>();
let sidebarQueued = false;
let sidebarKey = "";
/** La conversation dont le fil d'Ariane affiche le titre : un titre qui change s'y fond. */
let crumbSid: string | null = null;
const query = () => ($("search") as HTMLInputElement).value.trim().toLowerCase();

function threads(): Thread[] {
  const q = query();
  const openIds = new Set<string>();
  const out: Thread[] = [];
  for (const v of views.values()) {
    if (v.info.cliId) openIds.add(v.info.cliId);
    if (v.info.cliId && removing.has(v.info.cliId)) continue;
    out.push({ title: v.info.title, cwd: v.info.cwd, time: v.info.lastActiveMs, sid: v.info.sid, activity: activityOf(v) });
  }
  for (const h of history) if (!openIds.has(h.cliId) && !removing.has(h.cliId)) out.push({ title: h.title, cwd: h.cwd, time: h.mtimeMs, hist: h, activity: "" });
  return out.filter((t) => !q || `${t.title} ${t.cwd}`.toLowerCase().includes(q)).sort((a, b) => b.time - a.time);
}

function renderSidebar() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  requestAnimationFrame(() => {
    sidebarQueued = false;
    drawSidebar();
  });
}

function drawSidebar() {
  // Ne pas remplacer une ligne dont le menu est ouvert : il perdrait son ancre.
  if (menuElement() || reordering) return;
  const list = threads();
  // `collapsed` n'y figure pas : replier agit sur la ligne en place, pour que l'animation se joue.
  const key = JSON.stringify([active, [...expanded], projectOrder, query(), list.map((t) => [t.sid ?? t.hist?.cliId, t.title, t.activity, t.cwd])]);
  if (key === sidebarKey) return;
  sidebarKey = key;
  const groups = new Map<string, Thread[]>();
  for (const t of list) {
    const g = groups.get(t.cwd);
    if (g) g.push(t);
    else groups.set(t.cwd, [t]);
  }
  const nav = $("threads");
  if (groups.size === 0) {
    nav.replaceChildren(el("div", "side-empty", query() ? "Aucun résultat." : "Aucune conversation."));
    return;
  }
  const q = query();
  const before = snapshotSidebar(nav);
  const queryChanged = q !== lastSidebarQuery;
  lastSidebarQuery = q;
  nav.replaceChildren(...orderedGroups(groups).map(([cwd, items]) => projectSection(cwd, items, q)));
  // Seul un titre qui déborde s'estompe au repos : un titre qui tient juste reste net.
  for (const title of nav.querySelectorAll<HTMLElement>(".thread-title")) title.classList.toggle("is-long", title.scrollWidth > title.clientWidth);
  if (skipSidebarMotion || queryChanged || !motionLive()) skipSidebarMotion = false;
  else animateSidebar(nav, before);
}

let lastSidebarQuery = "";
/** Après un glisser-déposer, tout est déjà à sa place : pas de seconde animation. */
let skipSidebarMotion = false;

interface Spot {
  top: number;
  node: HTMLElement;
}

function snapshotSidebar(nav: HTMLElement): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  const origin = nav.getBoundingClientRect().top - nav.scrollTop;
  for (const node of nav.querySelectorAll<HTMLElement>(".group, .thread")) {
    if (node.dataset.key) spots.set(node.dataset.key, { top: node.getBoundingClientRect().top - origin, node });
  }
  return spots;
}

/** Les lignes qui changent de place glissent, les nouvelles apparaissent, celles qui partent s'estompent. */
function animateSidebar(nav: HTMLElement, before: Map<string, Spot>) {
  const origin = nav.getBoundingClientRect().top - nav.scrollTop;
  const seen = new Set<string>();
  for (const sec of nav.querySelectorAll<HTMLElement>(".group")) {
    const key = sec.dataset.key!;
    seen.add(key);
    const top = sec.getBoundingClientRect().top - origin;
    const old = before.get(key);
    const moved = old ? old.top - top : 0;
    if (old) flipY(sec, moved);
    else void enter(sec, { opacity: "0" }, { duration: DUR.fast });
    if (sec.classList.contains("is-collapsed")) continue;
    for (const row of sec.querySelectorAll<HTMLElement>(".thread")) {
      const rowKey = row.dataset.key!;
      seen.add(rowKey);
      const was = before.get(rowKey);
      // La ligne suit déjà son projet : seul l'écart propre à la ligne s'anime.
      if (was) {
        flipY(row, was.top - (row.getBoundingClientRect().top - origin) - moved);
        // Le titre généré remplace le début du message : il se fond sans à-coup.
        const title = row.querySelector<HTMLElement>(".thread-title");
        if (title && was.node.querySelector(".thread-title")?.textContent !== title.textContent) textIn(title);
      } else if (old) void enter(row, { opacity: "0" }, { duration: DUR.fast });
    }
  }
  for (const [key, spot] of before) {
    if (seen.has(key) || !spot.node.classList.contains("thread")) continue;
    // Conversation archivée ou supprimée : son fantôme s'efface à l'ancienne place.
    const ghost = spot.node.cloneNode(true) as HTMLElement;
    ghost.classList.add("thread-ghost");
    ghost.style.top = `${spot.top}px`;
    nav.append(ghost);
    void leave(ghost, { opacity: 0 }).then(() => ghost.remove());
  }
}

/** Les projets déjà rangés gardent leur place ; un nouveau projet arrive en tête. */
function orderedGroups(groups: Map<string, Thread[]>): [string, Thread[]][] {
  const rank = new Map(projectOrder.map((cwd, i) => [cwd, i]));
  const all = [...groups];
  return [...all.filter(([cwd]) => !rank.has(cwd)), ...all.filter(([cwd]) => rank.has(cwd)).sort((a, b) => rank.get(a[0])! - rank.get(b[0])!)];
}

function projectSection(cwd: string, items: Thread[], q: string): HTMLElement {
  const sec = el("section", "group");
  sec.dataset.cwd = cwd;
  sec.dataset.key = `project:${cwd}`;
  const folded = !q && collapsed.has(cwd);
  sec.classList.toggle("is-collapsed", folded);

  const head = el("div", "group-head");
  head.title = home(cwd);
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", String(!folded));
  const chev = el("span", "group-chev");
  chev.innerHTML = icon("chevronRight");
  head.append(el("span", "group-name", projectName(cwd)), chev);
  // Replié, un projet garde le signal de ses conversations : il ne faut pas rater une demande d'accord.
  const activity = items.some((t) => t.activity === "wait") ? "wait" : items.some((t) => t.activity === "busy") ? "busy" : "";
  if (activity) {
    const st = el("span", `thread-state group-state is-${activity}`);
    st.innerHTML = icon(activity === "wait" ? "hand" : "spinner", 14);
    head.append(st);
  }
  const add = el("button", "icon-btn");
  add.type = "button";
  add.title = `Nouvelle conversation dans ${projectName(cwd)}`;
  add.setAttribute("aria-label", add.title);
  add.innerHTML = icon("plus");
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    newConversation(cwd);
  });
  head.append(add);
  head.addEventListener("click", () => {
    if (!justDragged) toggleProject(sec, cwd);
  });
  head.addEventListener("keydown", (e) => {
    if (e.target !== head) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleProject(sec, cwd);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveProject(cwd, e.key === "ArrowUp" ? -1 : 1);
    }
  });
  head.addEventListener("pointerdown", (e) => startProjectDrag(e, sec));

  const fold = el("div", `fold${folded ? " is-closed" : ""}`);
  fold.inert = folded;
  const inner = el("div");
  const ul = el("ul", "threads");
  const limit = q || expanded.has(cwd) ? items.length : 5;
  for (const t of items.slice(0, limit)) ul.append(threadRow(t));
  inner.append(ul);
  if (items.length > limit) {
    const more = el("button", "group-more", `${items.length - limit} de plus`);
    more.type = "button";
    more.addEventListener("click", () => {
      expanded.add(cwd);
      renderSidebar();
    });
    inner.append(more);
  }
  fold.append(inner);
  sec.append(head, fold);
  return sec;
}

function toggleProject(sec: HTMLElement, cwd: string) {
  if (query()) return;
  const folded = !collapsed.has(cwd);
  if (folded) collapsed.add(cwd);
  else collapsed.delete(cwd);
  saveJson("bh.projects.collapsed", [...collapsed]);
  sec.classList.toggle("is-collapsed", folded);
  sec.querySelector(".group-head")?.setAttribute("aria-expanded", String(!folded));
  const fold = sec.querySelector<HTMLElement>(".fold");
  if (fold) {
    fold.classList.toggle("is-closed", folded);
    fold.inert = folded;
  }
  // Le fondu de bas de liste dépend de la hauteur finale.
  window.setTimeout(() => $("threads").dispatchEvent(new Event("scroll")), 300);
}

function saveProjectOrder(visible: string[]) {
  // Les projets hors de la liste actuelle gardent leur rang relatif, à la suite.
  projectOrder = [...visible, ...projectOrder.filter((cwd) => !visible.includes(cwd))];
  saveJson("bh.projects.order", projectOrder);
  renderSidebar();
}

const visibleProjects = () => [...$("threads").querySelectorAll<HTMLElement>(".group")].map((s) => s.dataset.cwd!);

function moveProject(cwd: string, delta: number) {
  const order = visibleProjects();
  const from = order.indexOf(cwd);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  order.splice(to, 0, order.splice(from, 1)[0]);
  saveProjectOrder(order);
  requestAnimationFrame(() => requestAnimationFrame(() => $("threads").querySelector<HTMLElement>(`.group[data-cwd="${CSS.escape(cwd)}"] .group-head`)?.focus()));
}

const DRAG_THRESHOLD = 4;
const GROUP_GAP = 12;
const EDGE = 28;

/** Glisser un projet par son en-tête. Fait au pointeur : Tauri intercepte le glisser-déposer HTML. */
function startProjectDrag(down: PointerEvent, sec: HTMLElement) {
  if (down.button !== 0 || query() || (down.target as HTMLElement).closest("button")) return;
  const nav = $("threads");
  const sections = [...nav.querySelectorAll<HTMLElement>(".group")];
  if (sections.length < 2) return;
  const from = sections.indexOf(sec);
  let to = from;
  let dragging = false;
  let lastY = down.clientY;
  let spots: { top: number; height: number }[] = [];
  let startY = 0;
  let frame = 0;
  const pointerY = () => lastY - nav.getBoundingClientRect().top + nav.scrollTop;

  const update = () => {
    const dy = pointerY() - startY;
    sec.style.transform = `translateY(${dy}px)`;
    const mid = spots[from].top + dy + spots[from].height / 2;
    const target = spots.filter((s, i) => i !== from && mid > s.top + s.height / 2).length;
    if (target === to) return;
    to = target;
    const shift = spots[from].height + GROUP_GAP;
    sections.forEach((s, i) => {
      if (i === from) return;
      const moved = from < to && i > from && i <= to ? -shift : from > to && i >= to && i < from ? shift : 0;
      s.style.transform = moved ? `translateY(${moved}px)` : "";
    });
  };
  // Défilement près des bords, pour atteindre les projets hors de vue.
  const autoScroll = () => {
    const r = nav.getBoundingClientRect();
    const speed = lastY < r.top + EDGE ? -6 : lastY > r.bottom - EDGE ? 6 : 0;
    if (speed) {
      const before = nav.scrollTop;
      nav.scrollTop += speed;
      if (nav.scrollTop !== before) update();
    }
    frame = requestAnimationFrame(autoScroll);
  };
  const begin = () => {
    dragging = true;
    reordering = true;
    closeMenu();
    const top = nav.getBoundingClientRect().top - nav.scrollTop;
    spots = sections.map((s) => {
      const r = s.getBoundingClientRect();
      return { top: r.top - top, height: r.height };
    });
    startY = down.clientY - nav.getBoundingClientRect().top + nav.scrollTop;
    nav.classList.add("is-reordering");
    sec.classList.add("is-dragging");
    document.documentElement.classList.add("is-grabbing");
    frame = requestAnimationFrame(autoScroll);
  };
  const move = (e: PointerEvent) => {
    lastY = e.clientY;
    if (!dragging) {
      if (Math.abs(lastY - down.clientY) < DRAG_THRESHOLD) return;
      begin();
    }
    update();
  };
  const finish = (commit: boolean) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", onKey, true);
    if (!dragging) return;
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove("is-grabbing");
    justDragged = true;
    window.setTimeout(() => (justDragged = false));
    const target = commit ? to : from;
    const final = target > from ? spots[target].top + spots[target].height - spots[from].top - spots[from].height : target < from ? spots[target].top - spots[from].top : 0;
    if (!commit) sections.forEach((s) => s !== sec && (s.style.transform = ""));
    sec.classList.remove("is-dragging");
    sec.classList.add("is-settling");
    sec.style.transform = final ? `translateY(${final}px)` : "";
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      nav.classList.remove("is-reordering");
      sec.classList.remove("is-settling");
      for (const s of sections) s.style.transform = "";
      reordering = false;
      skipSidebarMotion = true;
      if (target === from) return renderSidebar();
      const order = sections.map((s) => s.dataset.cwd!);
      order.splice(target, 0, order.splice(from, 1)[0]);
      saveProjectOrder(order);
    };
    sec.addEventListener("transitionend", settle, { once: true });
    window.setTimeout(settle, 320);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && dragging) {
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(false);
    }
  };
  // Sur le document : un geste rapide peut quitter l'en-tête dès le premier mouvement.
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", onKey, true);
}

onMenuChange(() => {
  if (!menuElement()) renderSidebar();
});

function threadRow(t: Thread): HTMLElement {
  const li = el("li", "thread");
  li.dataset.key = t.hist?.cliId ?? (t.sid ? (views.get(t.sid)?.info.cliId ?? t.sid) : t.title);
  li.setAttribute("aria-current", String(!!t.sid && t.sid === active));
  // Calculée au survol : la mémoire ne doit pas obliger à reconstruire la liste.
  li.addEventListener("mouseenter", () => {
    const m = t.sid ? rss.get(t.sid) : undefined;
    li.title = `${t.title}\n${home(t.cwd)}${m ? `\n${fmtMb(m.rssMb)} en mémoire` : ""}`;
  });
  li.append(el("span", "thread-title", t.title));
  if (t.activity) {
    const st = el("span", `thread-state is-${t.activity}`);
    st.title = t.activity === "wait" ? "Attend ton accord" : "En cours";
    st.innerHTML = icon(t.activity === "wait" ? "hand" : "spinner", 14);
    li.append(st);
  }
  const more = el("button", "icon-btn thread-more");
  more.type = "button";
  more.setAttribute("aria-label", `Actions pour ${t.title}`);
  more.innerHTML = icon("more");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    threadMenu(t, more);
  });
  li.append(more);
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    threadMenu(t, more);
  });
  li.addEventListener("click", () => {
    if (t.sid) void activate(t.sid);
    else if (t.hist) void openHistory(t.hist);
  });
  return li;
}

async function removeConversation(cliId: string, action: () => Promise<void>) {
  removing.add(cliId);
  renderSidebar();
  await guard(action());
  await refreshHistory();
  removing.delete(cliId);
  renderSidebar();
}

function threadMenu(t: Thread, anchor: HTMLElement) {
  const v = t.sid ? views.get(t.sid) : undefined;
  const cliId = t.hist?.cliId ?? v?.info.cliId;
  const opts = { minWidth: 170 };
  // Conversation jamais lancée : rien sur le disque, il n'y a qu'à la fermer.
  if (!cliId) {
    showMenu(anchor, [{ label: "Fermer", icon: "close", run: () => void guard(api.close(t.sid!)) }], opts);
    return;
  }
  const archive = () => void removeConversation(cliId, () => api.setArchived(cliId, true));
  const remove = () => void removeConversation(cliId, () => api.deleteConversation(cliId));
  const busy = v?.info.state === "busy";
  showMenu(
    anchor,
    [
      { label: "Archiver", icon: "archive", run: () => (busy ? confirmMenu(anchor, "Claude est en train de répondre", "Archiver arrête sa réponse.", "Archiver", archive) : archive()) },
      { label: "Supprimer", icon: "trash", danger: true, run: () => confirmMenu(anchor, "Supprimer cette conversation ?", DELETE_NOTE, "Supprimer", remove) },
    ],
    opts,
  );
}

/** Le dernier clic l'emporte : une conversation lente à s'ouvrir ne doit pas passer devant. */
let navigation = 0;

async function openHistory(h: HistoryEntry) {
  const asked = ++navigation;
  const info = await guard(api.createSession({ cwd: h.cwd, resume: h.cliId, title: h.title }));
  if (info) {
    view(info);
    renderSidebar();
    if (asked === navigation) await activate(info.sid);
  }
}

let historyTimer = 0;
async function refreshHistory() {
  const q = query();
  history = (await guard(api.listHistory(q ? 80 : 60, q || undefined))) ?? [];
  renderSidebar();
}
$("search").addEventListener("input", () => {
  renderSidebar();
  window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(refreshHistory, 220);
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    (e.target as HTMLInputElement).value = "";
    (e.target as HTMLInputElement).blur();
    renderSidebar();
    void refreshHistory();
  }
});

// ---------------------------------------------------------------- en-tête, composer, état

function renderMain() {
  const v = activeView();
  $("main").classList.toggle("is-new", !v);
  $("transcript").hidden = !v;
  $("start").hidden = !!v;
  $("folder-btn").hidden = !!v;
  $("more").hidden = !v;
  const crumb = $("crumb");
  if (v) {
    const title = el("b", undefined, v.info.title);
    const renamed = crumbSid === v.info.sid && crumb.querySelector("b")?.textContent !== v.info.title;
    crumb.replaceChildren(el("span", "crumb-dir", projectName(v.info.cwd)), title);
    crumb.title = home(v.info.cwd);
    if (renamed) textIn(title);
    crumbSid = v.info.sid;
  } else {
    crumb.replaceChildren();
    crumbSid = null;
  }
  composer.setPlaceholder(v ? "Répondre à Claude" : "Que doit faire Claude ?");
  renderComposer();
  renderLimit();
  renderWorking();
}

/** Icône qui change, ou bouton qui apparaît : l'icône arrive sans à-coup. */
function setIcon(node: HTMLElement, name: IconName) {
  if (node.dataset.current === name) return;
  const first = !node.dataset.current;
  node.dataset.current = name;
  node.innerHTML = icon(name);
  if (!first && motionLive()) iconIn(node);
}
function setShown(button: HTMLElement, shown: boolean) {
  if (button.hidden === !shown) return;
  button.hidden = !shown;
  if (shown && motionLive()) iconIn(button.querySelector<HTMLElement>("[data-icon]"));
}

function renderComposer() {
  const v = activeView();
  swapText($("folder-name"), draft.cwd ? base(draft.cwd) : NO_FOLDER);
  setIcon($("folder-icon"), draft.cwd ? "folder" : "folderDashed");
  $("folder-btn").title = draft.cwd ? home(draft.cwd) : "";
  const modelId = v ? v.info.model : draft.model;
  swapText($("model-name"), prettyModel(modelId, v?.init?.model) + ((v ? v.info.advisor : draft.advisor) ? " + Opus" : ""));
  const eff = effectiveEffort(v ? v.info.effort : draft.effort);
  swapText($("effort-name"), eff && effortLevels(modelId).some((e) => e.id === eff) ? effortLabel(eff) : "");
  const mode = modeOf(v ? v.info.permissionMode : draft.mode);
  setIcon($("mode-icon"), mode.icon);
  swapText($("mode-name"), mode.label);
  $("mode-btn").dataset.mode = mode.id;
  const busy = v?.info.state === "busy";
  const has = composer.text().trim().length > 0;
  // Pendant une réponse : « stop » ; si on tape, « envoyer » réapparaît pour mettre en file.
  setShown($("stop"), busy);
  setShown($("send"), !busy || has);
  ($("send") as HTMLButtonElement).disabled = !has;
  renderContext();
}

/** Jauge du contexte : anneau discret, détail au clic. */
function renderContext() {
  const btn = $("ctx-btn");
  const ctx = active ? contexts.get(active) : undefined;
  btn.hidden = !ctx;
  if (!ctx) return;
  const ratio = Math.min(1, ctx.totalTokens / Math.max(1, ctx.maxTokens));
  const c = 2 * Math.PI * 6;
  btn.dataset.level = ratio > 0.9 ? "full" : ratio > 0.7 ? "high" : "ok";
  btn.title = `Contexte : ${Math.round(ratio * 100)} % utilisé`;
  btn.innerHTML = `<svg class="ctx-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="6" fill="none" stroke-width="2"/><circle class="used" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(ratio * c).toFixed(2)} ${c.toFixed(2)}"/></svg>`;
}

let ctxTimer = 0;
function refreshContext(sid: string) {
  window.clearTimeout(ctxTimer);
  ctxTimer = window.setTimeout(async () => {
    const ctx = await api.contextUsage(sid).catch(() => null);
    if (ctx) {
      contexts.set(sid, ctx);
      if (sid === active) renderContext();
    }
  }, 400);
}

$("ctx-btn").addEventListener("click", (e) => {
  const ctx = active ? contexts.get(active) : undefined;
  if (!ctx) return;
  const pct = Math.round((ctx.totalTokens / Math.max(1, ctx.maxTokens)) * 100);
  const used = ctx.categories.filter((c) => c.kind === "used" && c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const box = el("div");
  const total = el("div", "ctx-total");
  total.append(el("b", undefined, `${nf.format(ctx.totalTokens)} tokens`), el("span", "soft", ` sur ${nf.format(ctx.maxTokens)} (${pct} %)`));
  const bar = el("div", "ctx-bar");
  for (const c of used.slice(0, 5)) {
    const s = el("span");
    s.style.width = `${(c.tokens / Math.max(1, ctx.maxTokens)) * 100}%`;
    bar.append(s);
  }
  box.append(total, bar);
  for (const c of used.slice(0, 6)) {
    const r = el("div", "ctx-row");
    r.append(el("span", undefined, c.name), el("span", undefined, nf.format(c.tokens)));
    box.append(r);
  }
  const entries: MenuEntry[] = [{ custom: box }, { sep: true }, { label: "Compacter la conversation", hint: "Résume l'historique pour libérer de la place", icon: "sparkle", run: () => sendText("/compact") }];
  showMenu(e.currentTarget as HTMLElement, entries, { place: "above", align: "end", minWidth: 260 });
});

function renderWorking() {
  const v = activeView();
  const show = !!v && v.info.state === "busy" && !renderer.streaming && v.perms.size === 0;
  $("working").hidden = !show;
  if (show) $("working-label").textContent = v!.stream.thinking ? "Claude réfléchit" : "Claude travaille";
}

function renderLimit() {
  const b = $("limit");
  const rl = activeView()?.rateLimit;
  if (!rl || rl.status === "allowed") {
    b.hidden = true;
    return;
  }
  const when = rl.resetsAt ? fmtReset(rl.resetsAt) : "bientôt";
  b.textContent = rl.status === "rejected" ? `Limite d'utilisation atteinte, réinitialisation ${when}` : `Limite d'utilisation bientôt atteinte (réinitialisation ${when})`;
  b.classList.toggle("is-error", rl.status === "rejected");
  b.hidden = false;
}

function fmtReset(seconds: number) {
  const d = new Date(seconds * 1000);
  const time = { hour: "2-digit", minute: "2-digit" } as const;
  return d.toDateString() === new Date().toDateString() ? `à ${d.toLocaleTimeString("fr-FR", time)}` : d.toLocaleString("fr-FR", { weekday: "long", ...time });
}

// ---------------------------------------------------------------- limite restante

// Lue dans les réponses du modèle (`rate_limit_event`), donc sans requête supplémentaire. Elle vaut pour
// tout le compte : on garde la dernière connue d'une ouverture à l'autre.
const USAGE_LABELS: Record<string, string> = { five_hour: "5 heures", seven_day: "Semaine" };
let usage: UsageWindows = {};
try {
  usage = JSON.parse(localStorage.getItem("bh.usage") ?? "{}") as UsageWindows;
} catch {
  usage = {};
}
let usageTimer = 0;

function usageRows() {
  return Object.keys(USAGE_LABELS)
    .filter((k) => usage[k])
    .map((k) => {
      const w = usage[k];
      const expired = w.resetsAt * 1000 <= Date.now();
      return { label: USAGE_LABELS[k], resetsAt: w.resetsAt, expired, left: expired ? 100 : Math.max(0, Math.round((1 - w.utilization) * 100)) };
    });
}

function renderUsage() {
  const btn = $("usage-btn");
  const rows = usageRows();
  btn.hidden = rows.length === 0;
  window.clearTimeout(usageTimer);
  if (!rows.length) return;
  const left = Math.min(...rows.map((r) => r.left));
  $("usage-value").textContent = `${left} %`;
  btn.dataset.level = left === 0 ? "out" : left <= 10 ? "low" : "ok";
  // Une fenêtre qui se réinitialise redonne du crédit sans qu'aucun événement n'arrive.
  const next = Math.min(...rows.filter((r) => !r.expired).map((r) => r.resetsAt * 1000));
  if (Number.isFinite(next)) usageTimer = window.setTimeout(renderUsage, Math.min(next - Date.now() + 1000, 2 ** 31 - 1));
}

function setUsage(windows: UsageWindows) {
  usage = windows;
  try {
    localStorage.setItem("bh.usage", JSON.stringify(windows));
  } catch {
    // Sans stockage, la limite s'affiche quand même jusqu'à la fermeture.
  }
  renderUsage();
}

$("usage-btn").addEventListener("click", (e) => {
  const entries: MenuEntry[] = [{ heading: "Limite restante" }];
  for (const r of usageRows()) {
    const row = el("div", "limit-row");
    const top = el("div", "limit-top");
    top.append(el("b", undefined, r.label), el("span", undefined, `${r.left} % ${r.left > 1 ? "restants" : "restant"}`));
    const bar = el("div", "ctx-bar");
    const fill = el("span");
    fill.style.width = `${r.left}%`;
    bar.append(fill);
    row.append(top, bar);
    if (!r.expired) row.append(el("small", undefined, `Réinitialisation ${fmtReset(r.resetsAt)}`));
    entries.push({ custom: row });
  }
  showMenu(e.currentTarget as HTMLElement, entries, { place: "above", align: "end", minWidth: 240 });
});

renderUsage();

// ---------------------------------------------------------------- mises à jour

let updateState: UpdateState = { state: "idle" };
function renderUpdate(s: UpdateState) {
  updateState = s;
  const btn = $("update-btn");
  btn.hidden = s.state !== "ready";
  if (s.state === "ready") btn.title = `Better Harness ${s.version} est téléchargée`;
}
$("update-btn").addEventListener("click", (e) => {
  if (updateState.state !== "ready") return;
  const busy = [...views.values()].some((v) => v.info.state === "busy");
  showMenu(
    e.currentTarget as HTMLElement,
    [
      { heading: `Better Harness ${updateState.version}` },
      { note: busy ? "Les réponses en cours s'arrêtent. Les conversations reprennent après le redémarrage." : "L'app redémarre, les conversations restent." },
      { label: "Redémarrer", icon: "update", run: () => void guard(api.updateInstall()) },
    ],
    { place: "above", minWidth: 250 },
  );
});
void api.onUpdate(renderUpdate);
void api.updateStatus().then(renderUpdate, () => undefined);

// ---------------------------------------------------------------- menus du composer et de l'en-tête

/** Modèle et effort que le CLI appliquera dans ce dossier si on ne lui impose rien. */
async function refreshCliDefaults() {
  const d = await api.cliDefaults(currentCwd() || null).catch(() => null);
  if (d) {
    setCliDefaults(d);
    renderComposer();
  }
}

// Un choix dans le composer ne vaut que pour cette conversation : les défauts se règlent dans les Réglages.
function pick(kind: "model" | "mode" | "effort" | "advisor", value: string | null) {
  const v = activeView();
  if (v) {
    if (kind === "model") void guard(api.setModel(v.info.sid, value));
    else if (kind === "mode") void guard(api.setPermissionMode(v.info.sid, value ?? "default"));
    else if (kind === "advisor") void guard(api.setAdvisor(v.info.sid, value));
    else void guard(api.setEffort(v.info.sid, value));
  } else {
    if (kind === "model") draft.model = value;
    else if (kind === "mode") draft.mode = value ?? "default";
    else if (kind === "advisor") draft.advisor = value;
    else draft.effort = value;
    renderComposer();
  }
}

$("model-btn").addEventListener("click", (e) => {
  const v = activeView();
  const modelId = v ? v.info.model : draft.model;
  const levels = effortLevels(modelId);
  const entries: MenuEntry[] = modelChoices().map((m) => ({ label: m.displayName, checked: isCurrentModel(m, modelId), run: () => pick("model", m.value) }));
  // Le modèle choisi travaille et consulte Opus aux moments clés : utile avec Sonnet ou Haiku.
  const advisor = v ? v.info.advisor : draft.advisor;
  entries.push({ sep: true }, { label: "Conseiller Opus", detail: "Consulté aux moments clés", checked: !!advisor, run: () => pick("advisor", advisor ? null : "opus") });
  if (levels.length) {
    const eff = effectiveEffort(v ? v.info.effort : draft.effort) ?? "";
    entries.push({ heading: "Effort" }, { custom: segmented(levels, eff, (id) => pick("effort", id)) });
  }
  showMenu(e.currentTarget as HTMLElement, entries, { place: "above", minWidth: 250 });
});
$("mode-btn").addEventListener("click", (e) => {
  const v = activeView();
  const cur = v ? v.info.permissionMode : draft.mode;
  showMenu(e.currentTarget as HTMLElement, MODES.map((m) => ({ label: m.label, icon: m.icon, checked: m.id === cur, danger: m.id === "bypassPermissions", run: () => pick("mode", m.id) })), { place: "above", minWidth: 210 });
});

function knownDirs(): string[] {
  return [...new Set([...(settings?.recentDirs ?? []), ...history.map((h) => h.cwd)])].filter((d) => d && d !== scratchDir);
}
async function chooseFolder() {
  let dir: string | null = null;
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, multiple: false, defaultPath: draft.cwd || appHome || undefined });
    dir = typeof r === "string" ? r : null;
  } else {
    dir = window.prompt("Dossier de travail", draft.cwd) || null;
  }
  if (dir) setDraftCwd(dir);
}
function setDraftCwd(dir: string) {
  draft.cwd = dir === scratchDir ? "" : dir;
  renderComposer();
  void refreshCliDefaults();
  panel.contextChanged();
  composer.focus();
}
/** Filtre affiché seulement si la liste est assez longue pour en avoir besoin. */
const FOLDER_FILTER_FROM = 7;

$("folder-btn").addEventListener("click", (e) => {
  const dirs = knownDirs();
  // Deux projets du même nom se distinguent par leur dossier parent.
  const names = new Map<string, number>();
  for (const d of dirs) names.set(base(d), (names.get(base(d)) ?? 0) + 1);
  const parent = (d: string) => base(d.slice(0, d.length - base(d).length - 1));
  const box = el("div", "folder-menu");
  const list = el("div", "folder-list");
  const fill = (q: string) => {
    const needle = q.trim().toLowerCase();
    const rows = dirs.filter((d) => !needle || d.toLowerCase().includes(needle)).map((d) =>
      menuItem({ label: base(d), detail: (names.get(base(d)) ?? 0) > 1 ? parent(d) : undefined, title: home(d), icon: "folder", checked: d === draft.cwd, run: () => setDraftCwd(d) }),
    );
    if (!needle || NO_FOLDER.toLowerCase().includes(needle)) rows.unshift(menuItem({ label: NO_FOLDER, icon: "folderDashed", checked: !draft.cwd, run: () => setDraftCwd("") }));
    list.replaceChildren(...(rows.length ? rows : [el("div", "menu-note", "Aucun dossier trouvé.")]));
  };
  fill("");
  let field: HTMLInputElement | null = null;
  if (dirs.length + 1 >= FOLDER_FILTER_FROM) {
    const f = el("input", "menu-filter");
    f.type = "search";
    f.placeholder = "Filtrer";
    f.spellcheck = false;
    f.setAttribute("aria-label", "Filtrer les dossiers");
    f.addEventListener("input", () => fill(f.value));
    f.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        list.querySelector<HTMLElement>(".menu-item")?.click();
      }
    });
    field = f;
    box.append(f);
  }
  box.append(list);
  showMenu(e.currentTarget as HTMLElement, [{ custom: box }, { sep: true }, { label: "Choisir un dossier…", icon: "plus", run: () => void chooseFolder() }], { place: "above", minWidth: 260 });
  // Le menu s'ouvre au-dessus du bouton : sa hauteur ne doit pas bouger pendant le filtrage.
  list.style.height = `${list.offsetHeight}px`;
  field?.focus();
});

$("more").addEventListener("click", (e) => {
  const v = activeView();
  if (!v) return;
  const live = v.info.state === "ready" || v.info.state === "busy";
  const anchor = e.currentTarget as HTMLElement;
  const close = () => void guard(api.close(v.info.sid));
  const entries: MenuEntry[] = [
    { label: "Afficher dans le Finder", icon: "folder", run: () => reveal(v.info.cwd) },
  ];
  if (live) entries.push({ sep: true }, { label: "Suspendre le processus", hint: "Libère la mémoire, reprise au prochain message", icon: "cpu", run: () => void guard(api.suspend(v.info.sid)) });
  entries.push({ sep: true }, {
    label: "Fermer la conversation",
    icon: "close",
    danger: true,
    run: () => (v.info.state === "busy" ? confirmMenu(anchor, "Claude est en train de répondre", "Fermer arrête sa réponse.", "Fermer", close, { align: "end" }) : close()),
  });
  showMenu(anchor, entries, { align: "end", minWidth: 250 });
});

// ---------------------------------------------------------------- permissions

const permCards = new Map<string, HTMLElement>();
function renderPerms() {
  const v = activeView();
  const box = $("perms");
  const wanted = v ? [...v.perms.values()] : [];
  const keyOf = (p: PermissionEv) => `${v?.info.sid}:${p.requestId}`;
  const keep = new Set(wanted.map(keyOf));
  // Une demande qui part ou qui arrive fait glisser le composer au lieu de le faire sauter.
  for (const [key, card] of permCards) {
    if (keep.has(key)) continue;
    permCards.delete(key);
    void heightOut(card).then(() => card.remove());
  }
  for (const p of wanted) {
    if (permCards.has(keyOf(p))) continue;
    const question = p.toolName === "AskUserQuestion" ? questionBar(v!, p) : null;
    const card = question ?? permBar(v!, p);
    permCards.set(keyOf(p), card);
    box.append(card);
    void heightIn(card);
    // Rien en cours de frappe : le clavier passe directement aux réponses.
    if (question && !composer.text().trim()) question.querySelector<HTMLElement>(".q-option")?.focus({ preventScroll: true });
  }
  renderWorking();
}

const PERM_VERBS: Record<string, string> = {
  [SIM_TOOL]: "Simulateur",
  Artifact: "Artefact",
  Bash: "Exécuter",
  Edit: "Modifier",
  MultiEdit: "Modifier",
  NotebookEdit: "Modifier",
  Write: "Écrire",
  Read: "Lire",
  WebFetch: "Ouvrir",
  WebSearch: "Rechercher",
  Grep: "Rechercher",
  Glob: "Rechercher",
  Task: "Lancer un agent",
  ExitPlanMode: "Valider le plan",
  Agent: "Lancer un agent",
};

/**
 * Ce sur quoi porte l'action, en une ligne : commande, nom de fichier, adresse…
 * Lu par motif et non avec JSON.parse : une grosse entrée (Write) arrive tronquée au milieu.
 */
function permTarget(p: PermissionEv): string {
  if (p.toolName === "ExitPlanMode") return "";
  if (p.toolName === SIM_TOOL) return simulatorAction(p.input);
  if (p.toolName === "Artifact") return artifactAction(p.input);
  if (p.toolName === "Bash") return p.input.split("\n")[0];
  const field = (key: string) => {
    const raw = new RegExp(`"${key}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(p.input)?.[1];
    if (raw === undefined) return null;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };
  const path = field("file_path") ?? field("notebook_path");
  if (path) return base(path);
  return (field("url") ?? field("query") ?? field("pattern") ?? field("description") ?? field("[^\"]+") ?? "").split("\n")[0];
}

function planOf(p: PermissionEv): string | null {
  if (p.toolName !== "ExitPlanMode") return null;
  try {
    const plan = (JSON.parse(p.input) as { plan?: unknown }).plan;
    return typeof plan === "string" ? plan : null;
  } catch {
    return null;
  }
}

function questionBar(v: SessionView, p: PermissionEv): HTMLElement | null {
  const settle = (decision: "allow" | "deny", answers?: Record<string, string>, message?: string) => {
    v.perms.delete(p.requestId);
    renderPerms();
    renderSidebar();
    void guard(api.respondPermission(v.info.sid, p.requestId, decision, answers, message));
    composer.focus();
  };
  return questionCard(
    p.input,
    (answers) => settle("allow", answers),
    () => settle("deny", undefined, "L'utilisateur a préféré ne pas répondre à cette question."),
  );
}

function permBar(v: SessionView, p: PermissionEv): HTMLElement {
  const card = el("div", "perm");
  const target = permTarget(p);
  const main = el("button", "perm-main");
  main.type = "button";
  main.setAttribute("aria-expanded", "false");
  const chev = el("span", "perm-chev");
  chev.innerHTML = icon("chevronRight");
  main.append(el("span", "perm-verb", PERM_VERBS[p.toolName] ?? p.toolName.replace(/^mcp__/, "").replace(/__/g, " ")), el("code", "perm-target", target), chev);

  const detail = el("div", "perm-detail");
  detail.hidden = true;
  const why = p.description ?? p.title;
  if (why) detail.append(el("p", undefined, why));
  const diff = toolDiff(p.toolName, p.input);
  const plan = planOf(p);
  if (plan !== null) {
    // Un plan se lit avant de se valider : il est déjà ouvert.
    const body = el("div", "md perm-plan");
    body.innerHTML = renderMarkdown(plan);
    decorateCode(body);
    detail.append(body);
    detail.hidden = false;
    main.setAttribute("aria-expanded", "true");
  } else {
    detail.append(diff ? renderLines(diff.lines) : wrapWithCopy(el("pre", undefined, p.input)));
  }
  // Rien à déplier si la ligne dit déjà tout.
  main.disabled = !why && target === p.input && p.input.length <= 60;
  chev.hidden = main.disabled;
  main.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
    main.setAttribute("aria-expanded", String(!detail.hidden));
  });

  const actions = el("div", "perm-actions");
  const mk = (label: string, decision: "allow" | "always" | "deny", cls: string) => {
    const b = el("button", `btn ${cls}`, label);
    b.type = "button";
    b.addEventListener("click", () => {
      v.perms.delete(p.requestId);
      renderPerms();
      renderSidebar();
      void guard(api.respondPermission(v.info.sid, p.requestId, decision));
    });
    return b;
  };
  actions.append(mk("Refuser", "deny", "btn-ghost"));
  if (p.canAlways && plan === null) actions.append(mk("Toujours", "always", "btn-ghost"));
  actions.append(mk(plan === null ? "Autoriser" : "Valider", "allow", "btn-primary"));
  card.append(main, actions, detail);
  return card;
}

// ---------------------------------------------------------------- navigation

/** Temps maximal pendant lequel l'ancien écran attend un historique encore en lecture. */
const HISTORY_HOLD_MS = 250;

async function activate(sid: string) {
  closeMenu();
  const asked = ++navigation;
  const clickedAt = performance.now();
  active = sid;
  world.wake();
  renderSidebar();
  void api.focus(sid);
  void refreshCliDefaults();
  const v = views.get(sid);
  // Tout se prépare avant l'échange : l'ancien écran reste affiché et vivant pendant ce temps.
  if (v && !v.historyLoaded && v.info.cliId) {
    let late = false;
    const load = loadHistoryInto(v, v.info.cliId, false).then(async () => {
      if (!late || active !== sid) return;
      await prerenderMarkdown(v, performance.now() + HISTORY_HOLD_MS);
      if (active === sid) renderer.mount(v, true);
    });
    await Promise.race([load, new Promise((r) => window.setTimeout(r, HISTORY_HOLD_MS))]);
    late = true;
    if (asked !== navigation) return;
  }
  if (v) await prerenderMarkdown(v, clickedAt + HISTORY_HOLD_MS);
  if (asked !== navigation) return;
  showConversation(v);
  if (v && (v.info.state === "ready" || v.info.state === "busy")) refreshContext(sid);
  composer.focus();
}

/** Calcule le Markdown par petites tranches, des derniers messages aux premiers : ce sont eux qu'on voit. */
async function prerenderMarkdown(v: SessionView, deadline: number) {
  let slice = performance.now();
  for (let i = v.items.length - 1; i >= 0; i--) {
    const it = v.items[i];
    if (it.k !== "assistant") continue;
    for (const b of it.blocks) {
      if (b.t !== "text" || b.html) continue;
      b.html = renderMarkdown(b.text);
      if (performance.now() - slice < 8) continue;
      if (performance.now() > deadline) return;
      await new Promise((r) => window.setTimeout(r));
      slice = performance.now();
    }
  }
}

function newConversation(cwd?: string) {
  closeMenu();
  navigation++;
  active = null;
  world.wake();
  if (cwd) draft.cwd = cwd === scratchDir ? "" : cwd;
  // Chaque nouvelle conversation repart des vrais défauts : un essai sur la précédente ne la suit pas.
  draft.model = settings.defaultModel;
  draft.effort = settings.defaultEffort;
  draft.mode = settings.defaultPermissionMode;
  void refreshCliDefaults();
  void api.focus(null);
  showConversation(undefined);
  composer.focus();
}

function showConversation(v: SessionView | undefined) {
  if (v) v.artifactToShow = null;
  const moving = motionLive();
  const box = $("composer");
  const wasNew = $("main").classList.contains("is-new");
  const fromTop = box.getBoundingClientRect().top;
  const titleBefore = $("crumb").textContent;
  // L'ancien fil part en fondu avant que `renderMain` ne masque sa zone.
  renderer.mount(v, moving);
  renderMain();
  renderer.afterShow();
  renderWorking();
  renderPerms();
  renderSidebar();
  panel.contextChanged();
  if (!moving) return;
  // Le composer passe du centre au bas de la fenêtre en glissant.
  if (wasNew !== !v) flipY(box, fromTop - box.getBoundingClientRect().top);
  if (!v && wasNew !== !v) void enter($("start"), { opacity: "0", transform: "translateY(4px)" }, { delay: DUR.stagger });
  if ($("crumb").textContent !== titleBefore) void enter($("crumb"), { opacity: "0.4" }, { duration: DUR.quick });
}

async function loadHistoryInto(v: SessionView, cliId: string, mount = true) {
  v.historyLoaded = true;
  const page = await guard(api.loadTranscript(v.info.sid, cliId, v.historyLimit));
  if (!page) return;
  v.reset();
  for (const ev of page.events) applyToView(v, ev);
  v.hasMore = page.hasMore;
  // Relire l'historique ne doit pas rouvrir le panneau sur un ancien artefact.
  v.artifactToShow = null;
  if (active === v.info.sid) panel.artifactsChanged();
  if (mount && active === v.info.sid) renderer.mount(v);
}

// ---------------------------------------------------------------- événements du cœur

function applyToView(v: SessionView, ev: UiEvent): { item?: Item; added?: BlockView[]; tool?: ToolView } {
  switch (ev.kind) {
    case "user":
      return { item: v.addUser(ev.text) };
    case "assistant":
      if (ev.parent) {
        const parent = v.tools.get(ev.parent);
        if (parent) parent.sub++;
        return { tool: parent };
      }
      v.stream = { text: "", thinking: false };
      return v.addAssistant(ev.id, ev.blocks);
    case "toolResult":
      return { tool: v.addToolResult(ev) };
    default:
      return {};
  }
}

function onEvent(ev: UiEvent) {
  world.onEvent(ev);
  switch (ev.kind) {
    case "server":
    case "serverLog":
    case "browser":
    case "simulator":
    case "artifactReady":
      panel.onEvent(ev);
      return;
    case "sessionUpdate": {
      const prev = views.get(ev.session.sid)?.info.state;
      const v = view(ev.session);
      if (ev.session.state === "busy" && prev !== "busy") v.busySince = Date.now();
      renderSidebar();
      if (ev.session.sid === active) renderMain();
      return;
    }
    case "sessionRemoved":
      views.delete(ev.sid);
      contexts.delete(ev.sid);
      if (active === ev.sid) newConversation();
      void refreshHistory();
      return;
    case "capabilities":
      rememberModels(ev.models);
      renderComposer();
      return;
  }
  const v = ev.sid ? views.get(ev.sid) : undefined;
  if (!v) {
    if (ev.kind === "notice" && ev.level !== "info") toast(ev.text);
    return;
  }
  const shown = ev.sid === active && renderer.mounted === v;
  switch (ev.kind) {
    case "delta":
      if (ev.replace || v.stream.thinking !== ev.thinking) v.stream = { text: ev.text, thinking: ev.thinking };
      else v.stream.text += ev.text;
      // La réflexion n'est pas affichée en direct : l'indicateur suffit, elle reste consultable ensuite.
      if (shown && !ev.thinking) renderer.setStream(ev.text, ev.replace);
      if (shown) renderWorking();
      return;
    case "assistant":
    case "toolResult":
    case "user": {
      const r = applyToView(v, ev);
      if (!shown) return;
      if (ev.kind === "toolResult") {
        panel.filesChanged();
        if (r.tool?.name === "Artifact") panel.artifactsChanged();
        if (v.artifactToShow) panel.showArtifact(v.artifactToShow);
        v.artifactToShow = null;
      }
      if (ev.kind === "assistant" && !ev.parent) renderer.setStream("", true);
      if (r.item) renderer.upsert(r.item, r.added);
      if (r.tool) renderer.updateTool(r.tool);
      renderWorking();
      return;
    }
    case "init":
      v.init = ev;
      if (shown) {
        renderComposer();
        panel.sessionStarted();
      }
      refreshContext(v.info.sid);
      return;
    case "status":
      v.status = ev.status;
      return;
    case "rateLimit":
      v.rateLimit = ev;
      if (ev.windows) setUsage(ev.windows);
      if (shown) renderLimit();
      return;
    case "permission":
      v.perms.set(ev.requestId, ev);
      if (shown) renderPerms();
      else toast(`« ${v.info.title} » attend ton accord (${ev.toolName}).`);
      renderSidebar();
      return;
    case "permissionDone":
      v.perms.delete(ev.requestId);
      if (shown) renderPerms();
      renderSidebar();
      return;
    case "result": {
      if (shown) panel.filesChanged();
      v.stream = { text: "", thinking: false };
      v.status = null;
      const it = v.addResult(ev);
      if (shown) {
        renderer.setStream("", true);
        renderer.upsert(it);
        renderWorking();
      }
      refreshContext(v.info.sid);
      return;
    }
    case "notice": {
      const it = v.addNotice(ev.level, ev.text);
      if (shown) renderer.upsert(it);
      return;
    }
  }
}

// ---------------------------------------------------------------- saisie

async function sendText(text: string) {
  let v = activeView();
  if (!v) {
    const dir = draft.cwd || scratchDir;
    if (!dir) return void $("folder-btn").click();
    const info = await guard(api.createSession({ cwd: dir, model: draft.model, permissionMode: draft.mode, effort: draft.effort, advisor: draft.advisor }));
    if (!info) return;
    v = view(info);
    await activate(info.sid);
  }
  renderer.upsert(v.addUser(text));
  void guard(api.send(v.info.sid, text));
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = composer.text().trim();
  if (!text) return;
  composer.clear();
  void sendText(text);
});
$("stop").addEventListener("click", () => active && void guard(api.interrupt(active)));
$("new-session").addEventListener("click", () => newConversation());
$("open-settings").addEventListener("click", () => void openSettings());

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (menuElement()) return;
    const v = activeView();
    if (v?.info.state === "busy" && !document.querySelector("dialog[open]") && document.activeElement !== $("search")) void guard(api.interrupt(v.info.sid));
    return;
  }
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  if (e.shiftKey && k === "b") {
    e.preventDefault();
    panel.toggle("browser");
  } else if (e.shiftKey && k === "s") {
    e.preventDefault();
    panel.toggle("servers");
  } else if (e.shiftKey && k === "d") {
    e.preventDefault();
    panel.toggle("diff");
  } else if (e.shiftKey && k === "m") {
    e.preventDefault();
    panel.toggle("simulator");
  } else if (e.shiftKey && k === "a") {
    e.preventDefault();
    panel.toggle("artifacts");
  } else if (k === "n") {
    e.preventDefault();
    newConversation();
  } else if (k === "k") {
    e.preventDefault();
    ($("search") as HTMLInputElement).focus();
  } else if (k === ",") {
    e.preventDefault();
    void openSettings();
  }
});

// Liens dans les messages : un lien local s'ouvre dans le navigateur intégré, les autres à l'extérieur.
$("transcript").addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  // Un artefact de cette conversation s'ouvre dans le panneau.
  if (activeView()?.artifacts.some((x) => x.url === a.href)) panel.showArtifact(a.href, true);
  else if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/.test(a.href)) panel.openUrl(a.href);
  else if (/^https?:\/\//.test(a.href)) openExternal(a.href);
});

// ---------------------------------------------------------------- mémoire (infobulles)

async function pollMetrics() {
  if (document.hidden) return;
  const m = await api.metrics().catch(() => undefined);
  if (!m) return;
  rss.clear();
  for (const [sid, st] of m.sessions) rss.set(sid, st);
}
window.addEventListener("focus", () => {
  void pollMetrics();
  panel.filesChanged();
});
document.addEventListener("visibilitychange", () => void api.setVisible(!document.hidden));

// ---------------------------------------------------------------- démarrage

async function boot() {
  await api.subscribe(onEvent);
  settings = await api.getSettings();
  scratchDir = await api.scratchDir().catch(() => "");
  // `app_info` lance `claude --version` : on ne bloque pas le démarrage dessus.
  void api.appInfo().then((i) => {
    appHome = i.home;
    sidebarKey = "";
    renderSidebar();
    renderMain();
  }, () => undefined);
  draft.model = settings.defaultModel;
  draft.mode = settings.defaultPermissionMode;
  draft.effort = settings.defaultEffort;
  const lastDir = settings.recentDirs[0] ?? "";
  draft.cwd = lastDir === scratchDir ? "" : lastDir;
  for (const info of await api.listSessions()) view(info);
  const first = [...views.values()].sort((a, b) => b.info.lastActiveMs - a.info.lastActiveMs)[0];
  if (first) await activate(first.info.sid);
  else newConversation();
  renderSidebar();
  // Fenêtre encore masquée : on la montre complète, pas de liste qui se remplit sous les yeux.
  await refreshHistory();
  drawSidebar();
  goLive();
  if (!settings.recentDirs.length && history[0] && history[0].cwd !== scratchDir) {
    draft.cwd = history[0].cwd;
    renderComposer();
  }
}
void boot().finally(() => {
  // La fenêtre attend d'être peinte pour s'afficher : sinon, elle s'ouvre sur un fond blanc.
  window.setTimeout(() => void api.appReady().catch(() => undefined), 30);
});
