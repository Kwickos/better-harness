// Panneau latéral : navigateur intégré (vraie WKWebView placée par le cœur Rust),
// serveurs (dev servers du projet + serveurs MCP de la conversation), modifications et simulateur iOS.
import type { Api, Artifact, McpServerStatus, Rect, ServerInfo, UiEvent } from "./api";
import { initArtifactTab } from "./artifacts";
import { copyButton } from "./copy";
import { initDiffTab } from "./diff";
import { icon } from "./icons";
import { menuElement, onMenuChange } from "./menu";
import { DIST, DUR, enter, iconIn, leave, staggerIn } from "./motion";
import { initSimulatorTab } from "./simulator";
import { el } from "./transcript";

type Tab = "browser" | "servers" | "diff" | "simulator" | "artifacts";

/** État affiché à côté d'un serveur MCP : rien tant que tout va bien. */
const MCP_STATES: Record<string, string> = { connected: "", disabled: "", failed: "échec", pending: "connexion…", "needs-auth": "à authentifier" };

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
      /* préférence non mémorisée */
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
    // Le panneau glisse sans changer de largeur : la conversation n'est mise en page qu'une fois.
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
    for (const t of ["browser", "servers", "diff", "simulator", "artifacts"] as const) {
      $(`toggle-${t}`).setAttribute("aria-pressed", String(open && tab === t));
      $(`tab-${t}`).hidden = tab !== t;
    }
    if (open && tab === "servers") void refreshServers().then(() => fresh && staggerIn([...$("tab-servers").querySelectorAll<HTMLElement>(".srv")]));
    if (open && tab === "diff") void diffTab.refresh().then(() => fresh && staggerIn([...$("diff-list").querySelectorAll<HTMLElement>(".diff-file")]));
    simTab.setVisible(open && tab === "simulator");
    artifactTab.setVisible(open && tab === "artifacts");
    renderArtifactToggle();
    renderEmpty();
    syncBrowser();
  }

  /** Le bouton n'existe que pour une conversation qui a des artefacts, ou tant que l'onglet est ouvert. */
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

  function toggle(t: Tab) {
    if (open && tab === t) open = false;
    else {
      open = true;
      tab = t;
    }
    store.set("panel.open", open ? "1" : "0");
    store.set("panel.tab", tab);
    render();
    if (open && tab === "browser" && !live) urlIn.focus();
  }

  // ------------------------------------------------------------ navigateur

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

  // La vue native passe au-dessus du HTML : on l'écarte quand un dialogue ou un menu la recouvrirait.
  // Masquer est immédiat (un rAF peut être suspendu si la fenêtre est cachée) ;
  // seuls les repositionnements sont regroupés par image.
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

  // ------------------------------------------------------------ serveurs de dev

  async function refreshServers() {
    const cwd = d.cwd();
    const [list] = await Promise.all([cwd ? d.guard(d.api.serversList(cwd)) : [], refreshMcp()]);
    servers = list ?? [];
    renderServers();
    renderEmpty();
  }

  /** Les sections vides disparaissent ; s'il n'en reste aucune, une seule phrase. */
  function renderServersEmpty() {
    const none = servers.length === 0 && !mcp?.length;
    $("srv-empty").hidden = !none;
    $("srv-empty-sub").textContent = d.cwd() ? "Ajoute un script dev à package.json, ou un fichier .claude/launch.json." : "Ouvre une conversation pour voir ses serveurs.";
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
      u.title = "Ouvrir dans le navigateur intégré";
      u.addEventListener("click", (e) => {
        e.stopPropagation();
        openUrl(s.url!);
      });
      li.append(u);
    } else if (running) {
      li.append(el("span", "srv-meta", "en cours"));
    } else if (s.state === "crashed") {
      li.append(el("span", "srv-meta is-bad", "erreur"));
    }
    const run = el("button", "icon-btn srv-act");
    run.type = "button";
    run.title = running ? "Arrêter" : "Démarrer";
    run.setAttribute("aria-label", `${run.title} ${s.name}`);
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

  /** Un clic sur la ligne ouvre ou referme son journal ; rien à ouvrir tant qu'il est vide. */
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
    $("logs-title").textContent = `Journal de ${s.name}`;
    const pre = $("logs");
    pre.textContent = (logs.get(s.key) ?? []).join("\n");
    pre.scrollTop = pre.scrollHeight;
  }
  $("logs-close").before(copyButton(() => $("logs").textContent ?? "", "Copier le journal", "sm"));
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

  // ------------------------------------------------------------ serveurs MCP

  let mcpTimer = 0;
  async function refreshMcp() {
    const sid = d.sid();
    mcp = sid ? ((await d.api.mcpStatus(sid).catch(() => null))?.mcpServers ?? null) : null;
    renderMcp();
    // Un serveur en cours de connexion change d'état tout seul.
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
    li.title = `${m.transport ?? ""} ${tools} outil${tools > 1 ? "s" : ""}`.trim();
    li.append(el("span", "srv-name", m.name));
    const state = m.status in MCP_STATES ? MCP_STATES[m.status] : m.status;
    if (state) li.append(el("span", `srv-meta${m.status === "failed" || m.status === "needs-auth" ? " is-bad" : ""}`, state));
    const sid = d.sid();
    if (sid && m.status === "failed") {
      const r = el("button", "icon-btn srv-act");
      r.type = "button";
      r.title = "Reconnecter";
      r.setAttribute("aria-label", `Reconnecter ${m.name}`);
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
      sw.title = sw.checked ? "Désactiver" : "Activer";
      sw.setAttribute("aria-label", `${sw.title} ${m.name}`);
      sw.addEventListener("change", async () => {
        await d.guard(d.api.mcpToggle(sid, m.name, sw.checked));
        void refreshMcp();
      });
      li.append(sw);
    }
    return li;
  }

  // ------------------------------------------------------------ redimensionnement

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

  // Seule commande du panneau : ces boutons de la barre (recliquer sur l'actif le ferme).
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
      // Claude commence à agir : on montre l'écran, sans quitter un autre onglet ouvert.
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
    /** Le processus d'une conversation vient de démarrer : ses serveurs MCP sont connus. */
    sessionStarted() {
      if (open && tab === "servers") void refreshMcp();
    },
    toggle,
    onEvent,
    openUrl,
    syncBrowser,
    /** Une page vient d'être publiée : on la montre, sans quitter un autre onglet ouvert sauf demande explicite. */
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
    /** Le projet ou la conversation affichés ont changé. */
    contextChanged() {
      artifactTab.refresh();
      renderArtifactToggle();
      const cwd = d.cwd();
      const moved = cwd !== shownCwd;
      shownCwd = cwd;
      // Autre projet : la liste change en fondu, sans à-coup.
      const settle = () => {
        const list = $(`tab-${tab}`).querySelector<HTMLElement>(".panel-scroll");
        if (moved && list) void enter(list, { opacity: "0" }, { duration: DUR.fast });
      };
      if (open && tab === "servers") void refreshServers().then(settle);
      if (open && tab === "diff") void diffTab.refresh().then(settle);
    },
    /** Un outil vient de tourner, ou la fenêtre revient au premier plan : les fichiers ont pu changer. */
    filesChanged() {
      if (!open || tab !== "diff") return;
      window.clearTimeout(filesTimer);
      filesTimer = window.setTimeout(() => void diffTab.refresh(), 500);
    },
  };
}
