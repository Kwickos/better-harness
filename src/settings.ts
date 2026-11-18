// Settings: a panel with sections, saved automatically on every change.
import type { Api, CliUpdateState, Settings, UpdateState } from "./api";
import { icon } from "./icons";
import { deleteNote, efforts, modes, effortLabel, modeOf, modelChoices, prettyModel } from "./labels";
import { setWorldShown, worldShown } from "./world";
import { confirmMenu, showMenu, type MenuEntry } from "./menu";
import { animateOut, enter } from "./motion";
import { el } from "./transcript";
import { LANGUAGES, fmtMb, onLangChange, setLang, t, tp } from "./i18n";

type Section = "general" | "perf" | "mcp" | "archives" | "about";
const titles = (): Record<Section, string> => ({ general: t("General"), perf: t("Performance"), mcp: t("MCP servers"), archives: t("Archives"), about: t("About") });

interface Deps {
  api: Api;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  home: (p: string) => string;
  onSaved: (s: Settings) => void;
  onHistoryChanged: () => void;
  onClose: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initSettings(d: Deps) {
  const dlg = $("dlg-settings") as HTMLDialogElement;
  let s: Settings;
  let section: Section = "general";
  let saveTimer = 0;
  let savedTimer = 0;
  /** Runs once the pending save has succeeded (the language switches only then). */
  let afterSave: (() => void) | null = null;

  function save(patch: Partial<Settings>, then?: () => void) {
    s = { ...s, ...patch };
    if (then) afterSave = then;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      if ((await d.guard(d.api.saveSettings(s).then(() => true))) === true) {
        d.onSaved(s);
        const done = afterSave;
        afterSave = null;
        done?.();
        const tag = $("s-saved");
        tag.hidden = false;
        window.clearTimeout(savedTimer);
        savedTimer = window.setTimeout(() => (tag.hidden = true), 1400);
      }
    }, 250);
  }

  // ------------------------------------------------------------ building blocks

  const group = (title: string | null, ...rows: HTMLElement[]) => {
    const g = el("section", "s-group");
    if (title) g.append(el("h3", "s-group-title", title));
    const card = el("div", "s-card");
    card.append(...rows);
    g.append(card);
    return g;
  };
  const row = (label: string, hint: string | null, control: HTMLElement) => {
    const r = el("div", "s-row");
    const text = el("div");
    text.append(el("b", undefined, label));
    if (hint) text.append(el("small", undefined, hint));
    r.append(text, control);
    return r;
  };
  const toggle = (checked: boolean, on: (v: boolean) => void) => {
    const sw = el("input", "switch");
    sw.type = "checkbox";
    sw.checked = checked;
    sw.addEventListener("change", () => on(sw.checked));
    return sw;
  };
  const stepper = (value: number, min: number, max: number, step: number, fmt: (n: number) => string, on: (n: number) => void) => {
    const box = el("div", "stepper");
    const minus = el("button", undefined, "−");
    const out = el("output", undefined, fmt(value));
    const plus = el("button", undefined, "+");
    minus.type = plus.type = "button";
    const set = (n: number) => {
      value = Math.max(min, Math.min(max, n));
      out.textContent = fmt(value);
      on(value);
    };
    minus.addEventListener("click", () => set(value - step));
    plus.addEventListener("click", () => set(value + step));
    box.append(minus, out, plus);
    return box;
  };
  const picker = (label: string, entries: () => MenuEntry[]) => {
    const b = el("button", "s-pick");
    b.type = "button";
    const chev = el("span", "chev");
    chev.innerHTML = icon("chevronDown");
    b.append(el("span", undefined, label), chev);
    b.addEventListener("click", () => showMenu(b, entries(), { align: "end" }));
    return b;
  };

  // ------------------------------------------------------------ sections

  // Languages are named in themselves; "System" is a word of the interface.
  const langLabel = (l?: (typeof LANGUAGES)[number]) => (l?.id === "system" ? t("System") : (l?.label ?? ""));

  async function renderGeneral(body: HTMLElement) {
    const language = s.language || "en";
    const path = el("input", "s-input");
    path.placeholder = t("Automatic");
    path.value = s.claudePath ?? "";
    path.spellcheck = false;
    path.addEventListener("change", () => save({ claudePath: path.value.trim() || null }));
    const info = await d.guard(d.api.appInfo());
    const found = info?.claudePath ? d.home(info.claudePath) : t("Not found: enter its path.");
    body.append(
      group(
        null,
        row(
          t("Language"),
          null,
          picker(langLabel(LANGUAGES.find((l) => l.id === language)) || language, () =>
            LANGUAGES.map((l) => ({
              label: langLabel(l),
              checked: language === l.id,
              run: () => (save({ language: l.id }, () => setLang(l.id)), rerender()),
            })),
          ),
        ),
      ),
      group(
        "Claude",
        row(t("claude binary"), found, path),
        row(
          t("Update automatically"),
          t("Runs claude update at launch, then every 6 hours."),
          toggle(s.cliAutoUpdate, (v) => {
            save({ cliAutoUpdate: v });
            if (v) void d.api.cliUpdateCheck().catch(() => undefined);
          }),
        ),
        row(t("Live response"), t("Show text and Markdown as they're written."), toggle(s.partialMessages, (v) => save({ partialMessages: v }))),
        row(t("Next step"), t("When Claude needs your decision, it sums up the turn and offers buttons to answer. Applies the next time claude starts."), toggle(s.nextStep, (v) => save({ nextStep: v }))),
        row(t("Agent world"), t("Watch Claude and its subagents work above the input field."), toggle(worldShown(), setWorldShown)),
        row(t("Workflow and /loop"), t("About 5,000 more tokens per request. Applies the next time claude starts."), toggle(s.allTools, (v) => save({ allTools: v }))),
      ),
      group(
        t("New conversations"),
        row(
          t("Model"),
          null,
          picker(s.defaultModel ? prettyModel(s.defaultModel) : t("Default"), () => [
            { label: t("Default"), checked: !s.defaultModel, run: () => (save({ defaultModel: null }), rerender()) },
            ...modelChoices().map((m) => ({ label: m.displayName, checked: s.defaultModel === m.value, run: () => (save({ defaultModel: m.value }), rerender()) })),
          ]),
        ),
        row(
          t("Effort"),
          t("More effort: more thoughtful answers, but slower."),
          picker(effortLabel(s.defaultEffort) || t("Default"), () => [
            { label: t("Default"), checked: !s.defaultEffort, run: () => (save({ defaultEffort: null }), rerender()) },
            ...efforts().map((e) => ({ label: e.label, checked: s.defaultEffort === e.id, run: () => (save({ defaultEffort: e.id }), rerender()) })),
          ]),
        ),
        row(
          t("Permissions"),
          null,
          picker(modeOf(s.defaultPermissionMode).label, () =>
            modes().map((m) => ({ label: m.label, icon: m.icon, danger: m.id === "bypassPermissions", checked: s.defaultPermissionMode === m.id, run: () => (save({ defaultPermissionMode: m.id }), rerender()) })),
          ),
        ),
      ),
    );
  }

  async function renderPerf(body: HTMLElement) {
    body.append(
      group(
        t("claude processes"),
        row(t("In parallel"), t("Beyond this, the oldest idle conversation is suspended."), stepper(s.maxLive, 1, 10, 1, String, (n) => save({ maxLive: n }))),
        row(t("Suspend when idle"), t("The process stops; the conversation resumes at the next message."), stepper(s.idleMinutes, 0, 120, 5, (n) => (n ? t("{n} min", { n }) : t("Never")), (n) => save({ idleMinutes: n }))),
      ),
    );
    const m = await d.api.metrics().catch(() => undefined);
    if (m) {
      const cli = m.sessions.reduce((sum, [, st]) => sum + st.rssMb, 0);
      const total = m.harness.rssMb + cli || 1;
      const bar = el("div", "usage-bar");
      const a = el("span");
      a.style.width = `${(m.harness.rssMb / total) * 100}%`;
      const b = el("span");
      b.style.width = `${(cli / total) * 100}%`;
      bar.append(a, b);
      const n = m.sessions.length;
      body.append(
        group(
          t("Right now"),
          row(
            t("{size} used", { size: fmtMb(m.harness.rssMb + cli) }),
            t("App {app}, {procs}", { app: fmtMb(m.harness.rssMb), procs: n ? tp(n, "{n} claude process {size}", "{n} claude processes {size}", { size: fmtMb(cli) }) : t("no claude process") }),
            bar,
          ),
        ),
      );
    }
  }

  async function renderMcp(body: HTMLElement) {
    const info = await d.guard(d.api.appInfo());
    const list = (await d.guard(d.api.listMcp(info?.home ?? "/"))) ?? [];
    const rows = list.map((m) => {
      const r = el("div", "s-mcp");
      const text = el("div");
      text.append(el("b", undefined, m.name), el("small", undefined, m.detail));
      r.append(
        text,
        toggle(s.mcpSelected.includes(m.name), (v) => save({ mcpSelected: v ? [...new Set([...s.mcpSelected, m.name])] : s.mcpSelected.filter((x) => x !== m.name) })),
      );
      return r;
    });
    const listGroup = group(t("Servers to start"), ...(rows.length ? rows : [row(t("No MCP servers configured"), t("Add one with claude mcp add."), el("span"))]));
    listGroup.hidden = s.mcpMode !== "selected";
    body.append(
      group(
        null,
        row(
          t("Start only a selection"),
          t("Each conversation starts only the checked servers. claude.ai connectors stay off."),
          toggle(s.mcpMode === "selected", (v) => {
            save({ mcpMode: v ? "selected" : "all" });
            listGroup.hidden = !v;
          }),
        ),
      ),
      listGroup,
      el("p", "s-note", t("Applies to new conversations. The Servers panel handles those of a running conversation.")),
    );
  }

  async function renderArchives(body: HTMLElement) {
    const list = (await d.guard(d.api.listArchived())) ?? [];
    if (!list.length) {
      body.append(el("p", "s-note", t("No archived conversations.")));
      return;
    }
    const changed = async (action: Promise<void>) => {
      await d.guard(action);
      d.onHistoryChanged();
      await rerender();
    };
    const rows = list.map((h) => {
      const r = el("div", "s-row s-arch");
      const text = el("div");
      text.title = h.title;
      text.append(el("b", undefined, h.title), el("small", undefined, d.home(h.cwd)));
      const actions = el("div", "s-actions");
      const restore = el("button", "btn btn-ghost", t("Restore"));
      restore.type = "button";
      restore.addEventListener("click", () => void changed(d.api.setArchived(h.cliId, false)));
      const del = el("button", "icon-btn");
      del.type = "button";
      del.title = t("Delete");
      del.setAttribute("aria-label", t("Delete {name}", { name: h.title }));
      del.innerHTML = icon("trash");
      del.addEventListener("click", () => confirmMenu(del, t("Delete this conversation?"), deleteNote(), t("Delete"), () => void changed(d.api.deleteConversation(h.cliId)), { align: "end" }));
      actions.append(restore, del);
      r.append(text, actions);
      return r;
    });
    body.append(group(null, ...rows));
  }

  const channels = (): { id: Settings["updateChannel"]; label: string }[] => [
    { id: "stable", label: t("Stable") },
    { id: "beta", label: t("Beta") },
  ];

  async function renderAbout(body: HTMLElement) {
    const info = await d.guard(d.api.appInfo());
    const channel = s.updateChannel || "stable";
    // Updates never go back: an installed beta waits for a higher stable version.
    const channelHint = channel === "stable" && info?.version.includes("-") ? t("This beta stays until the next stable version.") : t("Beta receives new versions first.");
    body.append(
      group(
        null,
        await updateRow(t("Version {version}", { version: info?.version ?? "?" })),
        row(
          t("Update channel"),
          channelHint,
          picker(channels().find((c) => c.id === channel)?.label ?? channel, () =>
            channels().map((c) => ({ label: c.label, checked: channel === c.id, run: () => (save({ updateChannel: c.id }), rerender()) })),
          ),
        ),
        await cliRow(info?.claudeVersion?.replace(" (Claude Code)", "") ?? null),
        row(t("Fonts and icons"), "Geist (OFL 1.1), Phosphor Icons (MIT)", el("span")),
        row(t("Agent world creatures"), t("Free Pets Pack by Frakassets (CC BY 4.0)"), el("span")),
      ),
    );
  }

  /** Installed version, with the update check (automatic every 6 h). */
  async function updateRow(version: string) {
    const btn = el("button", "btn btn-ghost");
    btn.type = "button";
    const r = row("Better Harness", version, btn);
    const hint = r.querySelector("small")!;
    let current: UpdateState = (await d.api.updateStatus().catch(() => undefined)) ?? { state: "idle" };
    const paint = (u: UpdateState) => {
      current = u;
      btn.disabled = u.state === "checking" || u.state === "downloading";
      btn.className = u.state === "ready" ? "btn btn-primary" : "btn btn-ghost";
      btn.textContent = { idle: t("Check"), upToDate: t("Check"), error: t("Retry"), checking: t("Checking…"), downloading: t("Downloading…"), ready: t("Restart") }[u.state];
      const note =
        u.state === "upToDate"
          ? t("up to date")
          : u.state === "ready"
            ? t("{version} ready", { version: u.version })
            : u.state === "downloading"
              ? t("{version} found", { version: u.version })
              : u.state === "error"
                ? t("couldn't check")
                : "";
      hint.textContent = note ? `${version} · ${note}` : version;
      hint.title = u.state === "error" ? u.message : "";
    };
    paintUpdate = paint;
    paint(current);
    btn.addEventListener("click", () => {
      if (current.state === "ready") void d.guard(d.api.updateInstall());
      else void d.guard(d.api.updateCheck()).then((u) => u && paint(u));
    });
    return r;
  }
  let paintUpdate: ((u: UpdateState) => void) | null = null;
  void d.api.onUpdate((u) => paintUpdate?.(u));

  /** Installed CLI version, with `claude update` (automatic every 6 h unless turned off). */
  async function cliRow(installed: string | null) {
    const btn = el("button", "btn btn-ghost");
    btn.type = "button";
    btn.hidden = !installed;
    const r = row("Claude Code", installed ?? t("Not found"), btn);
    const hint = r.querySelector("small")!;
    let version = installed;
    const paint = (u: CliUpdateState) => {
      if (!version) return;
      if (u.state === "upToDate" || u.state === "updated") version = u.version;
      btn.disabled = u.state === "checking";
      btn.textContent = { idle: t("Check"), upToDate: t("Check"), updated: t("Check"), error: t("Retry"), checking: t("Checking…") }[u.state];
      const note =
        u.state === "upToDate"
          ? t("up to date")
          : u.state === "updated"
            ? t("updated from {version}", { version: u.from })
            : u.state === "error"
              ? t("couldn't update")
              : "";
      hint.textContent = note ? `${version} · ${note}` : version;
      hint.title = u.state === "error" ? u.message : u.state === "updated" ? t("Running conversations switch over at their next start.") : "";
    };
    paintCli = paint;
    paint((await d.api.cliUpdateStatus().catch(() => undefined)) ?? { state: "idle" });
    btn.addEventListener("click", () => void d.guard(d.api.cliUpdateCheck()).then((u) => u && paint(u)));
    return r;
  }
  let paintCli: ((u: CliUpdateState) => void) | null = null;
  void d.api.onCliUpdate((u) => paintCli?.(u));

  async function rerender() {
    const body = $("s-body");
    const scroll = body.scrollTop;
    const frag = el("div");
    await { general: renderGeneral, perf: renderPerf, mcp: renderMcp, archives: renderArchives, about: renderAbout }[section](frag);
    body.replaceChildren(...frag.childNodes);
    body.scrollTop = scroll;
    $("s-title").textContent = titles()[section];
    for (const b of dlg.querySelectorAll<HTMLElement>(".snav")) b.setAttribute("aria-current", String(b.dataset.sec === section));
  }

  onLangChange(() => {
    if (dlg.open) void rerender();
  });

  for (const b of dlg.querySelectorAll<HTMLElement>(".snav")) {
    b.addEventListener("click", () => {
      section = b.dataset.sec as Section;
      $("s-body").scrollTop = 0;
      void rerender().then(() => enter($("s-body"), { opacity: "0", transform: "translateY(4px)" }));
    });
  }
  const closeDialog = () => {
    if (dlg.open && !dlg.classList.contains("is-closing")) animateOut(dlg, "is-closing", () => dlg.close());
  };
  $("s-close").addEventListener("click", closeDialog);
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog();
  });
  dlg.addEventListener("close", d.onClose);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeDialog();
  });

  return {
    async open(sec: Section = section) {
      s = (await d.guard(d.api.getSettings())) ?? s;
      section = sec;
      await rerender();
      dlg.showModal();
      $("s-title").focus();
    },
  };
}
