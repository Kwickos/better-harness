import { fmtMb, fmtNumber, lang, onLangChange, setLang, t, tp, translateDom } from "./i18n";
import "./errors";
import { tauriApi, type UpdateState, type UsageWindows, type Api, type ContextUsage, type HistoryEntry, type PermissionEv, type ProcStat, type SessionInfo, type Settings, type UiEvent } from "./api";
import { icon, type IconName } from "./icons";
import { deleteNote, effectiveEffort, effortLabel, effortLevels, isCurrentModel, modes, modeOf, modelChoices, modelsCli, prettyModel, rememberDeletedArtifact, rememberModels, setCliDefaults, SIM_TOOL, simulatorAction, artifactAction, NEXT_STEP_TOOL, nextStepOf, type NextStep } from "./labels";
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

// Outside Tauri (in a browser), a mock backend lets you work on the UI.
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
/** Folder for conversations started without a project. */
let scratchDir = "";
/** Conversation not created yet: it is born with the first message sent. Empty `cwd`: no folder. */
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
const noFolder = () => t("No folder");
const projectName = (cwd: string) => (cwd === scratchDir ? noFolder() : base(cwd));

let toastTimer = 0;
function toast(text: string) {
  const box = $("toast");
  box.textContent = text;
  box.classList.remove("is-leaving");
  box.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => animateOut(box, "is-leaving", () => (box.hidden = true)), 4000);
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
// Pixel art world: one creature per Claude in the conversation (Pixel art mode only).
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
    const otherCli = s.claudePath !== settings.claudePath;
    settings = s;
    if (otherCli) void api.appInfo().then((i) => refreshModels(i.claudeVersion), () => undefined);
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

// ---------------------------------------------------------------- list edge fades

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

// ---------------------------------------------------------------- sidebar

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
    // Display preference: no harm if it isn't kept.
  }
}

const expanded = new Set<string>();
const collapsed = new Set<string>(readJson<string[]>("bh.projects.collapsed", []));
let projectOrder = readJson<string[]>("bh.projects.order", []);
/** During a drag, the list must not be rebuilt under the pointer. */
let reordering = false;
let justDragged = false;
/** Conversations being archived or deleted: they leave the list right away. */
const removing = new Set<string>();
let sidebarQueued = false;
let sidebarKey = "";
/** The conversation whose title the breadcrumb shows: a title that changes fades in there. */
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
  // Don't replace a row whose menu is open: the menu would lose its anchor.
  if (menuElement() || reordering) return;
  const list = threads();
  // `collapsed` is left out: folding acts on the row in place, so the animation plays.
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
    nav.replaceChildren(el("div", "side-empty", query() ? t("No results.") : t("No conversations.")));
    return;
  }
  const q = query();
  const before = snapshotSidebar(nav);
  const queryChanged = q !== lastSidebarQuery;
  lastSidebarQuery = q;
  nav.replaceChildren(...orderedGroups(groups).map(([cwd, items]) => projectSection(cwd, items, q)));
  // Only a title that overflows fades out at rest: a title that just fits stays sharp.
  for (const title of nav.querySelectorAll<HTMLElement>(".thread-title")) title.classList.toggle("is-long", title.scrollWidth > title.clientWidth);
  if (skipSidebarMotion || queryChanged || !motionLive()) skipSidebarMotion = false;
  else animateSidebar(nav, before);
}

let lastSidebarQuery = "";
/** After a drag, everything is already in place: no second animation. */
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

/** Rows that move slide, new ones appear, leaving ones fade out. */
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
      // The row already follows its project: only its own offset animates.
      if (was) {
        flipY(row, was.top - (row.getBoundingClientRect().top - origin) - moved);
        // The generated title replaces the start of the message: it fades in smoothly.
        const title = row.querySelector<HTMLElement>(".thread-title");
        if (title && was.node.querySelector(".thread-title")?.textContent !== title.textContent) textIn(title);
      } else if (old) void enter(row, { opacity: "0" }, { duration: DUR.fast });
    }
  }
  for (const [key, spot] of before) {
    if (seen.has(key) || !spot.node.classList.contains("thread")) continue;
    // Archived or deleted conversation: its ghost fades out at the old spot.
    const ghost = spot.node.cloneNode(true) as HTMLElement;
    ghost.classList.add("thread-ghost");
    ghost.style.top = `${spot.top}px`;
    nav.append(ghost);
    void leave(ghost, { opacity: 0 }).then(() => ghost.remove());
  }
}

/** Projects already ordered keep their place; a new project comes first. */
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
  // Folded, a project still shows its conversations' state: an approval request must not be missed.
  const activity = items.some((t) => t.activity === "wait") ? "wait" : items.some((t) => t.activity === "busy") ? "busy" : "";
  if (activity) {
    const st = el("span", `thread-state group-state is-${activity}`);
    st.innerHTML = icon(activity === "wait" ? "hand" : "spinner", 14);
    head.append(st);
  }
  const add = el("button", "icon-btn");
  add.type = "button";
  add.title = t("New conversation in {name}", { name: projectName(cwd) });
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
    const more = el("button", "group-more", t("{n} more", { n: items.length - limit }));
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
  // The bottom fade depends on the final height.
  window.setTimeout(() => $("threads").dispatchEvent(new Event("scroll")), 300);
}

function saveProjectOrder(visible: string[]) {
  // Projects outside the current list keep their relative order, after the others.
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

/** Drags a project by its header. Done with pointer events: Tauri intercepts HTML drag and drop. */
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
  // Scrolls near the edges, to reach projects out of view.
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
  // On the document: a fast gesture can leave the header on its first move.
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", onKey, true);
}

onMenuChange(() => {
  if (!menuElement()) renderSidebar();
});

function threadRow(thread: Thread): HTMLElement {
  const li = el("li", "thread");
  li.dataset.key = thread.hist?.cliId ?? (thread.sid ? (views.get(thread.sid)?.info.cliId ?? thread.sid) : thread.title);
  li.setAttribute("aria-current", String(!!thread.sid && thread.sid === active));
  // Computed on hover: memory use must not force a list rebuild.
  li.addEventListener("mouseenter", () => {
    const m = thread.sid ? rss.get(thread.sid) : undefined;
    li.title = `${thread.title}\n${home(thread.cwd)}${m ? `\n${t("{size} in memory", { size: fmtMb(m.rssMb) })}` : ""}`;
  });
  li.append(el("span", "thread-title", thread.title));
  if (thread.activity) {
    const st = el("span", `thread-state is-${thread.activity}`);
    st.title = thread.activity === "wait" ? t("Waiting for your approval") : t("In progress");
    st.innerHTML = icon(thread.activity === "wait" ? "hand" : "spinner", 14);
    li.append(st);
  }
  const more = el("button", "icon-btn thread-more");
  more.type = "button";
  more.setAttribute("aria-label", t("Actions for {title}", { title: thread.title }));
  more.innerHTML = icon("more");
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    threadMenu(thread, more);
  });
  li.append(more);
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    threadMenu(thread, more);
  });
  li.addEventListener("click", () => {
    if (thread.sid) void activate(thread.sid);
    else if (thread.hist) void openHistory(thread.hist);
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

function threadMenu(thread: Thread, anchor: HTMLElement) {
  const v = thread.sid ? views.get(thread.sid) : undefined;
  const cliId = thread.hist?.cliId ?? v?.info.cliId;
  const opts = { minWidth: 170 };
  // Conversation never started: nothing on disk, it only needs closing.
  if (!cliId) {
    showMenu(anchor, [{ label: t("Close"), icon: "close", run: () => void guard(api.close(thread.sid!)) }], opts);
    return;
  }
  const archive = () => void removeConversation(cliId, () => api.setArchived(cliId, true));
  const remove = () => void removeConversation(cliId, () => api.deleteConversation(cliId));
  const busy = v?.info.state === "busy";
  showMenu(
    anchor,
    [
      { label: t("Archive"), icon: "archive", run: () => (busy ? confirmMenu(anchor, t("Claude is replying"), t("Archiving stops its reply."), t("Archive"), archive) : archive()) },
      { label: t("Delete"), icon: "trash", danger: true, run: () => confirmMenu(anchor, t("Delete this conversation?"), deleteNote(), t("Delete"), remove) },
    ],
    opts,
  );
}

/** The last click wins: a conversation slow to open must not jump ahead. */
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

// ---------------------------------------------------------------- header, composer, status

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
  composer.setPlaceholder(v ? t("Reply to Claude") : t("What should Claude do?"));
  renderComposer();
  renderLimit();
  renderWorking();
}

/** An icon that changes, or a button that appears: the icon comes in smoothly. */
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
  swapText($("folder-name"), draft.cwd ? base(draft.cwd) : noFolder());
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
  // During a reply: "stop"; typing brings "send" back, to queue the message.
  setShown($("stop"), busy);
  setShown($("send"), !busy || has);
  ($("send") as HTMLButtonElement).disabled = !has;
  renderContext();
  renderNextStep();
}

// ---------------------------------------------------------------- next step

let nextCard: HTMLElement | null = null;
let nextKey = "";

/** The box of the last turn, while there is nothing else to do: Claude idle, no request waiting. */
function shownNextStep(): NextStep | null {
  const v = activeView();
  if (!v?.nextStep || v.info.state === "busy" || v.perms.size > 0) return null;
  return v.nextStep;
}

function renderNextStep() {
  const step = shownNextStep();
  const key = step ? `${active}\n${lang()}\n${step.id}` : "";
  if (key === nextKey) return;
  nextKey = key;
  const old = nextCard;
  nextCard = null;
  if (old) void heightOut(old).then(() => old.remove());
  if (!step) return;
  const card = nextStepBox(step);
  nextCard = card;
  $("next-step").append(card);
  void heightIn(card);
}

/** Recap, question, buttons. A button sends its full message, which its tooltip shows. */
function nextStepBox(step: NextStep): HTMLElement {
  const card = el("div", "next");
  const close = el("button", "icon-btn sm next-close");
  close.type = "button";
  close.title = t("Close");
  close.setAttribute("aria-label", t("Close"));
  close.innerHTML = icon("close");
  close.addEventListener("click", () => dismissNextStep());
  if (step.recap) card.append(el("p", "next-recap", step.recap));
  const actions = el("div", "next-actions");
  step.buttons.forEach((b, i) => {
    const btn = el("button", i === 0 ? "btn btn-primary" : "btn next-alt", b.label);
    btn.type = "button";
    btn.title = b.message;
    btn.addEventListener("click", () => void sendText(b.message));
    actions.append(btn);
  });
  card.append(el("p", "next-ask", step.ask), actions, close);
  return card;
}

function dismissNextStep(): boolean {
  const v = activeView();
  if (!v || !shownNextStep()) return false;
  v.nextStep = null;
  renderNextStep();
  return true;
}

/** Context gauge: a discreet ring, details on click. */
function renderContext() {
  const btn = $("ctx-btn");
  const ctx = active ? contexts.get(active) : undefined;
  btn.hidden = !ctx;
  if (!ctx) return;
  const ratio = Math.min(1, ctx.totalTokens / Math.max(1, ctx.maxTokens));
  const c = 2 * Math.PI * 6;
  btn.dataset.level = ratio > 0.9 ? "full" : ratio > 0.7 ? "high" : "ok";
  btn.title = t("Context: {pct}% used", { pct: Math.round(ratio * 100) });
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
  total.append(el("b", undefined, t("{n} tokens", { n: fmtNumber(ctx.totalTokens) })), el("span", "soft", ` ${t("of {max} ({pct}%)", { max: fmtNumber(ctx.maxTokens), pct })}`));
  const bar = el("div", "ctx-bar");
  for (const c of used.slice(0, 5)) {
    const s = el("span");
    s.style.width = `${(c.tokens / Math.max(1, ctx.maxTokens)) * 100}%`;
    bar.append(s);
  }
  box.append(total, bar);
  for (const c of used.slice(0, 6)) {
    const r = el("div", "ctx-row");
    r.append(el("span", undefined, c.name), el("span", undefined, fmtNumber(c.tokens)));
    box.append(r);
  }
  const entries: MenuEntry[] = [{ custom: box }, { sep: true }, { label: t("Compact conversation"), hint: t("Summarizes the history to free up space"), icon: "sparkle", run: () => sendText("/compact") }];
  showMenu(e.currentTarget as HTMLElement, entries, { place: "above", align: "end", minWidth: 260 });
});

function renderWorking() {
  const v = activeView();
  const show = !!v && v.info.state === "busy" && !renderer.streaming && v.perms.size === 0;
  $("working").hidden = !show;
  if (show) $("working-label").textContent = v!.stream.thinking ? t("Claude is thinking") : t("Claude is working");
}

function renderLimit() {
  const b = $("limit");
  const rl = activeView()?.rateLimit;
  if (!rl || rl.status === "allowed") {
    b.hidden = true;
    return;
  }
  const when = rl.resetsAt ? fmtReset(rl.resetsAt) : t("soon");
  b.textContent = rl.status === "rejected" ? t("Usage limit reached, resets {when}", { when }) : t("Usage limit almost reached (resets {when})", { when });
  b.classList.toggle("is-error", rl.status === "rejected");
  b.hidden = false;
}

function fmtReset(seconds: number) {
  const d = new Date(seconds * 1000);
  const time = d.toLocaleTimeString(lang(), { timeStyle: "short" });
  if (d.toDateString() === new Date().toDateString()) return t("at {time}", { time });
  return t("{day} at {time}", { day: d.toLocaleDateString(lang(), { weekday: "long" }), time });
}

// ---------------------------------------------------------------- remaining usage

// Read from the model's responses (`rate_limit_event`), so no extra request. It applies to the
// whole account: the last known value is kept from one launch to the next.
const usageLabels = (): Record<string, string> => ({ five_hour: t("5 hours"), seven_day: t("Week") });
let usage: UsageWindows = {};
try {
  usage = JSON.parse(localStorage.getItem("bh.usage") ?? "{}") as UsageWindows;
} catch {
  usage = {};
}
let usageTimer = 0;

function usageRows() {
  const labels = usageLabels();
  return Object.keys(labels)
    .filter((k) => usage[k])
    .map((k) => {
      const w = usage[k];
      const expired = w.resetsAt * 1000 <= Date.now();
      return { label: labels[k], resetsAt: w.resetsAt, expired, left: expired ? 100 : Math.max(0, Math.round((1 - w.utilization) * 100)) };
    });
}

function renderUsage() {
  const btn = $("usage-btn");
  const rows = usageRows();
  btn.hidden = rows.length === 0;
  window.clearTimeout(usageTimer);
  if (!rows.length) return;
  const left = Math.min(...rows.map((r) => r.left));
  $("usage-value").textContent = t("{n}%", { n: left });
  btn.dataset.level = left === 0 ? "out" : left <= 10 ? "low" : "ok";
  // A window that resets gives usage back without any event arriving.
  const next = Math.min(...rows.filter((r) => !r.expired).map((r) => r.resetsAt * 1000));
  if (Number.isFinite(next)) usageTimer = window.setTimeout(renderUsage, Math.min(next - Date.now() + 1000, 2 ** 31 - 1));
}

function setUsage(windows: UsageWindows) {
  usage = windows;
  try {
    localStorage.setItem("bh.usage", JSON.stringify(windows));
  } catch {
    // Without storage, the limit still shows until the app closes.
  }
  renderUsage();
}

$("usage-btn").addEventListener("click", (e) => {
  const entries: MenuEntry[] = [{ heading: t("Remaining usage") }];
  for (const r of usageRows()) {
    const row = el("div", "limit-row");
    const top = el("div", "limit-top");
    top.append(el("b", undefined, r.label), el("span", undefined, tp(r.left, "{n}% left", "{n}% left")));
    const bar = el("div", "ctx-bar");
    const fill = el("span");
    fill.style.width = `${r.left}%`;
    bar.append(fill);
    row.append(top, bar);
    if (!r.expired) row.append(el("small", undefined, t("Resets {when}", { when: fmtReset(r.resetsAt) })));
    entries.push({ custom: row });
  }
  showMenu(e.currentTarget as HTMLElement, entries, { place: "above", align: "end", minWidth: 240 });
});

renderUsage();

// ---------------------------------------------------------------- updates

let updateState: UpdateState = { state: "idle" };
function renderUpdate(s: UpdateState) {
  updateState = s;
  const btn = $("update-btn");
  btn.hidden = s.state !== "ready";
  if (s.state === "ready") btn.title = t("Better Harness {version} downloaded", { version: s.version });
}
$("update-btn").addEventListener("click", (e) => {
  if (updateState.state !== "ready") return;
  const busy = [...views.values()].some((v) => v.info.state === "busy");
  showMenu(
    e.currentTarget as HTMLElement,
    [
      { heading: `Better Harness ${updateState.version}` },
      { note: busy ? t("Replies in progress stop. Conversations resume after the restart.") : t("The app restarts, conversations stay.") },
      { label: t("Restart"), icon: "update", run: () => void guard(api.updateInstall()) },
    ],
    { place: "above", minWidth: 250 },
  );
});
void api.onUpdate(renderUpdate);
void api.updateStatus().then(renderUpdate, () => undefined);

// ---------------------------------------------------------------- composer and header menus

/** Model and effort the CLI will apply in this folder if nothing is forced on it. */
async function refreshCliDefaults() {
  const d = await api.cliDefaults(currentCwd() || null).catch(() => null);
  if (d) {
    setCliDefaults(d);
    renderComposer();
  }
}

/**
 * The picker offers the models of the CLI installed now. Sessions send them when they start;
 * after a `claude update` (another version than the one of the cached list), they are asked at
 * once, so the list of the previous version isn't shown until then.
 */
async function refreshModels(version: string | null) {
  if (!version || version === modelsCli()) return;
  const list = await api.cliModels(currentCwd()).catch(() => null);
  if (!list?.length) return;
  rememberModels(list, version);
  renderComposer();
}

// A choice in the composer only applies to this conversation: defaults are set in Settings.
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
  // The chosen model does the work and consults Opus at key moments: useful with Sonnet or Haiku.
  const advisor = v ? v.info.advisor : draft.advisor;
  entries.push({ sep: true }, { label: t("Opus advisor"), detail: t("Consulted at key moments"), checked: !!advisor, run: () => pick("advisor", advisor ? null : "opus") });
  if (levels.length) {
    const eff = effectiveEffort(v ? v.info.effort : draft.effort) ?? "";
    entries.push({ heading: t("Effort") }, { custom: segmented(levels, eff, (id) => pick("effort", id)) });
  }
  showMenu(e.currentTarget as HTMLElement, entries, { place: "above", minWidth: 250 });
});
$("mode-btn").addEventListener("click", (e) => {
  const v = activeView();
  const cur = v ? v.info.permissionMode : draft.mode;
  showMenu(e.currentTarget as HTMLElement, modes().map((m) => ({ label: m.label, icon: m.icon, checked: m.id === cur, danger: m.id === "bypassPermissions", run: () => pick("mode", m.id) })), { place: "above", minWidth: 210 });
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
    dir = window.prompt(t("Working folder"), draft.cwd) || null;
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
/** Filter shown only when the list is long enough to need one. */
const FOLDER_FILTER_FROM = 7;

$("folder-btn").addEventListener("click", (e) => {
  const dirs = knownDirs();
  // Two projects with the same name are told apart by their parent folder.
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
    if (!needle || noFolder().toLowerCase().includes(needle)) rows.unshift(menuItem({ label: noFolder(), icon: "folderDashed", checked: !draft.cwd, run: () => setDraftCwd("") }));
    list.replaceChildren(...(rows.length ? rows : [el("div", "menu-note", t("No folders found."))]));
  };
  fill("");
  let field: HTMLInputElement | null = null;
  if (dirs.length + 1 >= FOLDER_FILTER_FROM) {
    const f = el("input", "menu-filter");
    f.type = "search";
    f.placeholder = t("Filter");
    f.spellcheck = false;
    f.setAttribute("aria-label", t("Filter folders"));
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
  showMenu(e.currentTarget as HTMLElement, [{ custom: box }, { sep: true }, { label: t("Choose a folder…"), icon: "plus", run: () => void chooseFolder() }], { place: "above", minWidth: 260 });
  // The menu opens above the button: its height must not change while filtering.
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
    { label: t("Show in Finder"), icon: "folder", run: () => reveal(v.info.cwd) },
  ];
  if (live) entries.push({ sep: true }, { label: t("Suspend process"), hint: t("Frees memory, resumes on the next message"), icon: "cpu", run: () => void guard(api.suspend(v.info.sid)) });
  entries.push({ sep: true }, {
    label: t("Close conversation"),
    icon: "close",
    danger: true,
    run: () => (v.info.state === "busy" ? confirmMenu(anchor, t("Claude is replying"), t("Closing stops its reply."), t("Close"), close, { align: "end" }) : close()),
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
  // A request that leaves or arrives slides the composer instead of making it jump.
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
    // Nothing being typed: the keyboard goes straight to the answers.
    if (question && !composer.text().trim()) question.querySelector<HTMLElement>(".q-option")?.focus({ preventScroll: true });
  }
  renderWorking();
  renderNextStep();
}

const permVerbs = (): Record<string, string> => ({
  [SIM_TOOL]: t("Simulator"),
  Artifact: t("Artifact"),
  Bash: t("Run"),
  Edit: t("Edit"),
  MultiEdit: t("Edit"),
  NotebookEdit: t("Edit"),
  Write: t("Write"),
  Read: t("Read"),
  WebFetch: t("Open"),
  WebSearch: t("Search"),
  Grep: t("Search"),
  Glob: t("Search"),
  Task: t("Start an agent"),
  ExitPlanMode: t("Approve plan"),
  Agent: t("Start an agent"),
});

/**
 * What the action is about, in one line: command, file name, address…
 * Read by pattern, not with JSON.parse: a large input (Write) arrives cut off in the middle.
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
    () => settle("deny", undefined, "The user chose not to answer this question."),
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
  main.append(el("span", "perm-verb", permVerbs()[p.toolName] ?? p.toolName.replace(/^mcp__/, "").replace(/__/g, " ")), el("code", "perm-target", target), chev);

  const detail = el("div", "perm-detail");
  detail.hidden = true;
  const why = p.description ?? p.title;
  if (why) detail.append(el("p", undefined, why));
  const diff = toolDiff(p.toolName, p.input);
  const plan = planOf(p);
  if (plan !== null) {
    // A plan is read before it is approved: it starts open.
    const body = el("div", "md perm-plan");
    body.innerHTML = renderMarkdown(plan);
    decorateCode(body);
    detail.append(body);
    detail.hidden = false;
    main.setAttribute("aria-expanded", "true");
  } else {
    detail.append(diff ? renderLines(diff.lines) : wrapWithCopy(el("pre", undefined, p.input)));
  }
  // Nothing to expand if the line already says it all.
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
  actions.append(mk(t("Deny"), "deny", "btn-ghost"));
  if (p.canAlways && plan === null) actions.append(mk(t("Always"), "always", "btn-ghost"));
  actions.append(mk(plan === null ? t("Allow") : t("Approve"), "allow", "btn-primary"));
  card.append(main, actions, detail);
  return card;
}

// ---------------------------------------------------------------- navigation

/** Longest time the old screen waits for a history still being read. */
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
  // Everything is prepared before the swap: the old screen stays shown and live meanwhile.
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

/** Renders Markdown in small slices, from the last messages to the first: those are the ones in view. */
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
  // Each new conversation starts from the real defaults: a tweak on the previous one doesn't carry over.
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
  // The old thread fades out before `renderMain` hides its area.
  renderer.mount(v, moving);
  renderMain();
  renderer.afterShow();
  renderWorking();
  renderPerms();
  renderSidebar();
  panel.contextChanged();
  if (!moving) return;
  // The composer slides from the middle to the bottom of the window.
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
  // Reloading the history must not reopen the panel on an old artifact.
  v.artifactToShow = null;
  if (active === v.info.sid) panel.artifactsChanged();
  if (mount && active === v.info.sid) renderer.mount(v);
}

// ---------------------------------------------------------------- core events

function applyToView(v: SessionView, ev: UiEvent): { item?: Item; added?: BlockView[]; tool?: ToolView } {
  switch (ev.kind) {
    case "user":
      v.nextStep = null;
      return { item: v.addUser(ev.text) };
    case "assistant":
      if (ev.parent) {
        const parent = v.tools.get(ev.parent);
        if (parent) parent.sub++;
        return { tool: parent };
      }
      v.stream = { text: "", thinking: false };
      for (const b of ev.blocks) if (b.t === "tool" && b.name === NEXT_STEP_TOOL) v.nextStep = nextStepOf(b.id, b.input) ?? v.nextStep;
      return v.addAssistant(ev.id, ev.blocks);
    case "toolResult":
      // A refused box (input to fix) is not shown: the model calls again.
      if (ev.isError && v.nextStep?.id === ev.toolUseId) v.nextStep = null;
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
      // Thinking isn't shown live: the indicator is enough, and it can still be read afterwards.
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
      else toast(t("“{title}” is waiting for your approval ({tool}).", { title: v.info.title, tool: ev.toolName }));
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

// ---------------------------------------------------------------- input

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
  v.nextStep = null;
  renderNextStep();
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
    if (document.querySelector("dialog[open]") || document.activeElement === $("search")) return;
    if (v?.info.state === "busy") void guard(api.interrupt(v.info.sid));
    else dismissNextStep();
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

// Links in messages: a local link opens in the built-in browser, others open outside.
$("transcript").addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  // An artifact from this conversation opens in the panel.
  if (activeView()?.artifacts.some((x) => x.url === a.href)) panel.showArtifact(a.href, true);
  else if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/.test(a.href)) panel.openUrl(a.href);
  else if (/^https?:\/\//.test(a.href)) openExternal(a.href);
});

// ---------------------------------------------------------------- memory (tooltips)

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

// ---------------------------------------------------------------- boot

async function boot() {
  await api.subscribe(onEvent);
  settings = await api.getSettings();
  setLang(settings.language);
  translateDom();
  void api.setLanguage(lang()).catch(() => undefined);
  // Language switched in Settings: everything on screen is redrawn in place, no reload.
  onLangChange(() => {
    void api.setLanguage(lang()).catch(() => undefined);
    sidebarKey = "";
    renderSidebar();
    renderMain();
    renderContext();
    renderUsage();
    renderUpdate(updateState);
    renderPerms();
    renderer.refresh();
  });
  scratchDir = await api.scratchDir().catch(() => "");
  // `app_info` runs `claude --version`: boot doesn't wait for it.
  void api.appInfo().then((i) => {
    appHome = i.home;
    sidebarKey = "";
    renderSidebar();
    renderMain();
    void refreshModels(i.claudeVersion);
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
  // Window still hidden: show it complete, not with a list filling up before the user's eyes.
  await refreshHistory();
  drawSidebar();
  goLive();
  if (!settings.recentDirs.length && history[0] && history[0].cwd !== scratchDir) {
    draft.cwd = history[0].cwd;
    renderComposer();
  }
}
void boot().finally(() => {
  // The window waits to be painted before showing: otherwise it opens on a white background.
  window.setTimeout(() => void api.appReady().catch(() => undefined), 30);
});
