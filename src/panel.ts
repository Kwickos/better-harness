// Side panel: built-in browser (a real WKWebView placed by the Rust core),
// servers (the project's dev servers + the conversation's MCP servers), changes and iOS simulator.
import type { Api, Artifact, McpServerStatus, Rect, ServerInfo, UiEvent } from "./api";
import { initArtifactTab } from "./artifacts";
import { copyButton } from "./copy";
import { initDiffTab } from "./diff";
import { t, tp } from "./i18n";
import { icon } from "./icons";
import { menuElement, onMenuChange } from "./menu";
import { DIST, DUR, enter, iconIn, leave, staggerIn } from "./motion";
import { initSimulatorTab } from "./simulator";
import { el } from "./transcript";

type Tab = "browser" | "servers" | "diff" | "simulator" | "artifacts";

/** State shown next to an MCP server (translated when shown): nothing while all is well. */
const MCP_STATES: Record<string, string> = { connected: "", disabled: "", failed: "failed", pending: "connecting…", "needs-auth": "needs auth" };

interface Deps {
  api: Api;
  inTauri: boolean;
  cwd: () => string;
  sid: () => string | null;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  openExternal: (url: string) => void;
  reveal: (path: string) => void;
  attach: (path: string) => void;
  artifacts: () => Artifact[];
  removeArtifact: (url: string) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`bh.${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`bh.${k}`, v);
    } catch {
      /* preference not remembered */
    }
  },
};

export function initPanel(d: Deps) {
  const panel = $("panel");
  const view = $("b-view");
  const frame = $("b-frame") as HTMLIFrameElement;
  const urlIn = $("b-url") as HTMLInputElement;
  let open = store.get("panel.open") === "1";
  const savedTab = store.get("panel.tab");
  let tab: Tab = savedTab === "servers" || savedTab === "diff" || savedTab === "simulator" || savedTab === "artifacts" ? savedTab : "browser";
  let wasOpen = open;
  let shownTab = tab;
  let shownCwd = d.cwd();
  let opening = false;
  const diffTab = initDiffTab({ api: d.api, cwd: d.cwd, guard: d.guard, reveal: d.reveal });
  const simTab = initSimulatorTab({ api: d.api, guard: d.guard, attach: d.attach });
  const artifactView = $("art-view");
  const artifactTab = initArtifactTab({
    api: d.api,
    inTauri: d.inTauri,
    guard: d.guard,
    openExternal: d.openExternal,
    list: d.artifacts,
    remove: (url) => {
      d.removeArtifact(url);
      artifactTab.refresh();
      renderArtifactToggle();
    },
    canShow: () => open && tab === "artifacts" && !opening && !document.querySelector("dialog[open]") && !overlapsMenu(artifactView),
  });
  let filesTimer = 0;
  let browserUrl: string | null = null;
  let live = false;
  let servers: ServerInfo[] = [];
  let selected: string | null = null;
  const logs = new Map<string, string[]>();
  let mcp: McpServerStatus[] | null = null;

  const savedW = Number(store.get("panel.w"));
  if (savedW > 300) panel.style.width = `${savedW}px`;

  function render() {
    // The panel slides without changing width: the conversation is laid out only once.
    const fresh = open && (!wasOpen || shownTab !== tab);
    if (open) {
      panel.classList.remove("is-closing");
      panel.hidden = false;
      if (!wasOpen) {
        opening = true;
        void enter(panel, { opacity: "0", transform: `translateX(${DIST.base}px)` }, { duration: DUR.slow }).then((done) => {
          if (!done) return;
          opening = false;
          syncBrowser();
        });
      } else if (shownTab !== tab) {
        void enter($(`tab-${tab}`), { opacity: "0" }, { duration: DUR.quick, ease: "easeInOut" });
      }
    } else if (wasOpen) {
      opening = false;
      panel.classList.add("is-closing");
      void leave(panel, { opacity: 0, transform: `translateX(${DIST.base}px)` }, { duration: DUR.medium }).then((done) => {
        if (!done || open) return;
        panel.hidden = true;
        panel.classList.remove("is-closing");
        panel.style.removeProperty("opacity");
        panel.style.removeProperty("transform");
      });
    } else {
      panel.hidden = true;
    }
    wasOpen = open;
    shownTab = tab;
    for (const id of ["browser", "servers", "diff", "simulator", "artifacts"] as const) {
      $(`toggle-${id}`).setAttribute("aria-pressed", String(open && tab === id));
      $(`tab-${id}`).hidden = tab !== id;
    }
    if (open && tab === "servers") void refreshServers().then(() => fresh && staggerIn([...$("tab-servers").querySelectorAll<HTMLElement>(".srv")]));
    if (open && tab === "diff") void diffTab.refresh().then(() => fresh && staggerIn([...$("diff-list").querySelectorAll<HTMLElement>(".diff-file")]));
    simTab.setVisible(open && tab === "simulator");
    artifactTab.setVisible(open && tab === "artifacts");
    renderArtifactToggle();
    renderEmpty();
    syncBrowser();
  }

  /** The button only exists for a conversation that has artifacts, or while the tab is open. */
  function renderArtifactToggle() {
    const button = $("toggle-artifacts");
    const wanted = d.artifacts().length > 0 || (open && tab === "artifacts");
    if (wanted && button.hidden) {
      button.hidden = false;
      iconIn(button.firstElementChild as HTMLElement);
    } else if (!wanted) {
      button.hidden = true;
    }
  }

  function toggle(next: Tab) {
    if (open && tab === next) open = false;
    else {
      open = true;
      tab = next;
    }
    store.set("panel.open", open ? "1" : "0");
    store.set("panel.tab", tab);
    render();
    if (open && tab === "browser" && !live) urlIn.focus();
  }

  // ------------------------------------------------------------ browser

  const rect = (): Rect => {
    const r = view.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  async function navigate(raw: string) {
    const target = raw.trim();
    if (!target) return;
    if (d.inTauri) {
      const url = await d.guard(d.api.browserOpen(target, rect()));
      if (!url) return;
      browserUrl = url;
    } else {
      browserUrl = target.includes("://") ? target : `http://${target}`;
      frame.src = browserUrl;
      frame.hidden = false;
    }
    live = true;
    urlIn.value = browserUrl;
    urlIn.blur();
    renderEmpty();
    syncBrowser();
  }

  function overlapsMenu(target: HTMLElement = view) {
    const m = menuElement();
    if (!m) return false;
    const a = m.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  // The native view sits above the HTML: move it away when a dialog or a menu would cover it.
  // Hiding is immediate (a rAF can be suspended while the window is hidden);
  // only repositioning is batched per frame.
  let queued = false;
  const shouldShow = () => open && tab === "browser" && !opening && !document.querySelector("dialog[open]") && !overlapsMenu();
  function syncBrowser() {
    artifactTab.sync();
    if (!d.inTauri || !live) return;
    if (!shouldShow()) {
      void d.api.browserBounds(rect(), false);
      return;
    }
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      void d.api.browserBounds(rect(), shouldShow());
    });
  }
  new ResizeObserver(syncBrowser).observe(view);
  window.addEventListener("resize", syncBrowser);
  onMenuChange(syncBrowser);

  function renderEmpty() {
    $("b-empty").hidden = live;
    $("b-view").classList.toggle("is-live", live);
    const urls = servers.filter((s) => s.state === "running" && s.url);
    $("b-suggest").replaceChildren(
      ...urls.map((s) => {
        const c = el("button", "chip", s.url!.replace(/^https?:\/\//, ""));
        c.type = "button";
        c.title = s.name;
        c.addEventListener("click", () => void navigate(s.url!));
        return c;
      }),
    );
  }

  $("b-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void navigate(urlIn.value);
  });
  urlIn.addEventListener("focus", () => urlIn.select());
  for (const [id, action] of [
    ["b-back", "back"],
    ["b-forward", "forward"],
    ["b-reload", "reload"],
  ] as const) {
    $(id).addEventListener("click", () => {
      if (!live) return;
      if (d.inTauri) void d.guard(d.api.browserNav(action));
      else if (action === "reload") frame.src = frame.src;
    });
  }
  $("b-external").addEventListener("click", () => browserUrl && d.openExternal(browserUrl));

  // ------------------------------------------------------------ dev servers

  async function refreshServers() {
    const cwd = d.cwd();
    const [list] = await Promise.all([cwd ? d.guard(d.api.serversList(cwd)) : [], refreshMcp()]);
    servers = list ?? [];
    renderServers();
    renderEmpty();
  }

  /** Empty sections disappear; if none is left, a single sentence. */
  function renderServersEmpty() {
    const none = servers.length === 0 && !mcp?.length;
    $("srv-empty").hidden = !none;
    $("srv-empty-sub").textContent = d.cwd() ? t("Add a dev script to package.json, or a .claude/launch.json file.") : t("Open a conversation to see its servers.");
  }

  function renderServers() {
    $("srv-section").hidden = servers.length === 0;
    $("srv-list").replaceChildren(...servers.map(serverRow));
    renderServersEmpty();
  }

  function serverRow(s: ServerInfo): HTMLElement {
    const running = s.state === "running";
    const li = el("li", `srv${running ? " is-on" : ""}`);
    li.setAttribute("aria-current", String(s.key === selected));
    li.title = s.command;
    li.append(el("span", "srv-name", s.name));
    if (running && s.url) {
      const u = el("button", "srv-url", s.url.replace(/^https?:\/\//, ""));
      u.type = "button";
      u.title = t("Open in the built-in browser");
      u.addEventListener("click", (e) => {
        e.stopPropagation();
        openUrl(s.url!);
      });
      li.append(u);
    } else if (running) {
      li.append(el("span", "srv-meta", t("running")));
    } else if (s.state === "crashed") {
      li.append(el("span", "srv-meta is-bad", t("error")));
    }
    const run = el("button", "icon-btn srv-act");
    run.type = "button";
    run.dataset.action = running ? "stop" : "start";
    run.title = running ? t("Stop") : t("Start");
    run.setAttribute("aria-label", running ? t("Stop {name}", { name: s.name }) : t("Start {name}", { name: s.name }));
    run.innerHTML = icon(running ? "stop" : "play");
    run.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (running) void d.guard(d.api.serverStop(s.key));
      else {
        logs.set(s.key, []);
        renderLogs();
        const info = await d.guard(d.api.serverStart(s.cwd, s.id));
        if (info) upsert(info);
      }
    });
    li.append(run);
    li.addEventListener("click", () => void selectServer(s));
    return li;
  }

  /** A click on the row opens or closes its log; nothing to open while it is empty. */
  async function selectServer(s: ServerInfo) {
    if (selected === s.key) {
      selected = null;
    } else {
      const lines = (await d.guard(d.api.serverLogs(s.key))) ?? [];
      if (lines.length === 0 && s.state !== "running") return;
      logs.set(s.key, lines);
      selected = s.key;
    }
    renderServers();
    renderLogs();
  }

  function renderLogs() {
    const s = servers.find((x) => x.key === selected);
    $("logs-box").hidden = !s;
    if (!s) return;
    $("logs-title").textContent = t("{name} log", { name: s.name });
    const pre = $("logs");
    pre.textContent = (logs.get(s.key) ?? []).join("\n");
    pre.scrollTop = pre.scrollHeight;
  }
  $("logs-close").before(copyButton(() => $("logs").textContent ?? "", "Copy log", "sm"));
  $("logs-close").addEventListener("click", () => {
    selected = null;
    renderServers();
    renderLogs();
  });

  function upsert(info: ServerInfo) {
    const i = servers.findIndex((s) => s.key === info.key);
    if (i >= 0) servers[i] = info;
    else if (info.cwd === d.cwd()) servers.push(info);
    renderServers();
    renderEmpty();
  }

  // ------------------------------------------------------------ MCP servers

  let mcpTimer = 0;
  async function refreshMcp() {
    const sid = d.sid();
    mcp = sid ? ((await d.api.mcpStatus(sid).catch(() => null))?.mcpServers ?? null) : null;
    renderMcp();
    // A server that is connecting changes state on its own.
    window.clearTimeout(mcpTimer);
    if (open && tab === "servers" && mcp?.some((m) => m.status === "pending")) mcpTimer = window.setTimeout(() => void refreshMcp(), 2000);
  }

  function renderMcp() {
    $("mcp-section").hidden = !mcp?.length;
    $("mcp-list").replaceChildren(...(mcp ?? []).map(mcpRow));
    renderServersEmpty();
  }

  function mcpRow(m: McpServerStatus): HTMLElement {
    const li = el("li", `srv${m.status === "connected" ? " is-on" : ""}`);
    const tools = m.tools?.length ?? 0;
    li.title = `${m.transport ?? ""} ${tp(tools, "{n} tool", "{n} tools")}`.trim();
    li.append(el("span", "srv-name", m.name));
    const state = m.status in MCP_STATES ? MCP_STATES[m.status] && t(MCP_STATES[m.status]) : m.status;
    if (state) li.append(el("span", `srv-meta${m.status === "failed" || m.status === "needs-auth" ? " is-bad" : ""}`, state));
    const sid = d.sid();
    if (sid && m.status === "failed") {
      const r = el("button", "icon-btn srv-act");
      r.type = "button";
      r.title = t("Reconnect");
      r.setAttribute("aria-label", t("Reconnect {name}", { name: m.name }));
      r.innerHTML = icon("reload");
      r.addEventListener("click", async () => {
        await d.guard(d.api.mcpReconnect(sid, m.name));
        void refreshMcp();
      });
      li.append(r);
    }
    if (sid) {
      const sw = el("input", "switch");
      sw.type = "checkbox";
      sw.checked = m.status !== "disabled";
      sw.title = sw.checked ? t("Disable") : t("Enable");
      sw.setAttribute("aria-label", sw.checked ? t("Disable {name}", { name: m.name }) : t("Enable {name}", { name: m.name }));
      sw.addEventListener("change", async () => {
        await d.guard(d.api.mcpToggle(sid, m.name, sw.checked));
        void refreshMcp();
      });
      li.append(sw);
    }
    return li;
  }

  // ------------------------------------------------------------ resizing

  const handle = $("panel-resize");
  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    const body = $("main").getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const w = Math.max(340, Math.min(body.right - ev.clientX, body.width - 420));
      panel.style.width = `${w}px`;
      syncBrowser();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      store.set("panel.w", String(Math.round(panel.getBoundingClientRect().width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });

  // The panel's only controls: these bar buttons (clicking the active one again closes it).
  $("toggle-browser").addEventListener("click", () => toggle("browser"));
  $("toggle-servers").addEventListener("click", () => toggle("servers"));
  $("toggle-diff").addEventListener("click", () => toggle("diff"));
  $("toggle-simulator").addEventListener("click", () => toggle("simulator"));
  $("toggle-artifacts").addEventListener("click", () => toggle("artifacts"));

  function openUrl(url: string) {
    open = true;
    tab = "browser";
    store.set("panel.open", "1");
    store.set("panel.tab", "browser");
    render();
    void navigate(url);
  }

  function onEvent(ev: UiEvent) {
    if (ev.kind === "server") upsert(ev.server);
    else if (ev.kind === "serverLog") {
      const buf = logs.get(ev.key) ?? [];
      buf.push(...ev.lines);
      if (buf.length > 500) buf.splice(0, buf.length - 500);
      logs.set(ev.key, buf);
      if (ev.key === selected) {
        const pre = $("logs");
        const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.append(`${pre.textContent ? "\n" : ""}${ev.lines.join("\n")}`);
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      }
    } else if (ev.kind === "browser") {
      browserUrl = ev.url;
      if (document.activeElement !== urlIn) urlIn.value = ev.url;
    } else if (ev.kind === "artifactReady") {
      artifactTab.ready();
    } else if (ev.kind === "simulator") {
      simTab.onEvent(ev);
      // Claude starts acting: show the screen, without leaving another open tab.
      if (ev.state === "agent" && (!open || tab === "simulator")) {
        open = true;
        tab = "simulator";
        store.set("panel.open", "1");
        store.set("panel.tab", tab);
        render();
      }
    }
  }

  render();
  return {
    /** A conversation's process just started: its MCP servers are known. */
    sessionStarted() {
      if (open && tab === "servers") void refreshMcp();
    },
    toggle,
    onEvent,
    openUrl,
    syncBrowser,
    /** A page was just published: show it, without leaving another open tab unless explicitly asked. */
    showArtifact(url: string, force = false) {
      artifactTab.select(url);
      renderArtifactToggle();
      if (!force && open && tab !== "artifacts") return;
      open = true;
      tab = "artifacts";
      store.set("panel.open", "1");
      store.set("panel.tab", tab);
      render();
    },
    artifactsChanged() {
      artifactTab.refresh();
      renderArtifactToggle();
    },
    /** The displayed project or conversation changed. */
    contextChanged() {
      artifactTab.refresh();
      renderArtifactToggle();
      const cwd = d.cwd();
      const moved = cwd !== shownCwd;
      shownCwd = cwd;
      // Another project: the list crossfades, without a jolt.
      const settle = () => {
        const list = $(`tab-${tab}`).querySelector<HTMLElement>(".panel-scroll");
        if (moved && list) void enter(list, { opacity: "0" }, { duration: DUR.fast });
      };
      if (open && tab === "servers") void refreshServers().then(settle);
      if (open && tab === "diff") void diffTab.refresh().then(settle);
    },
    /** A tool just ran, or the window came back to the front: files may have changed. */
    filesChanged() {
      if (!open || tab !== "diff") return;
      window.clearTimeout(filesTimer);
      filesTimer = window.setTimeout(() => void diffTab.refresh(), 500);
    },
  };
}
