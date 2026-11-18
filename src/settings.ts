// Réglages : panneau à sections, enregistrement automatique à chaque changement.
import type { Api, Settings, UpdateState } from "./api";
import { icon } from "./icons";
import { DELETE_NOTE, EFFORTS, MODES, effortLabel, modeOf, modelChoices, prettyModel } from "./labels";
import { setWorldShown, worldShown } from "./world";
import { confirmMenu, showMenu, type MenuEntry } from "./menu";
import { animateOut, enter } from "./motion";
import { el } from "./transcript";

type Section = "general" | "perf" | "mcp" | "archives" | "about";
const TITLES: Record<Section, string> = { general: "Général", perf: "Performance", mcp: "Serveurs MCP", archives: "Archives", about: "À propos" };

interface Deps {
  api: Api;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  home: (p: string) => string;
  onSaved: (s: Settings) => void;
  onHistoryChanged: () => void;
  onClose: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".", ",")} Go` : `${Math.round(mb)} Mo`);

export function initSettings(d: Deps) {
  const dlg = $("dlg-settings") as HTMLDialogElement;
  let s: Settings;
  let section: Section = "general";
  let saveTimer = 0;
  let savedTimer = 0;

  function save(patch: Partial<Settings>) {
    s = { ...s, ...patch };
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      if ((await d.guard(d.api.saveSettings(s).then(() => true))) === true) {
        d.onSaved(s);
        const tag = $("s-saved");
        tag.hidden = false;
        window.clearTimeout(savedTimer);
        savedTimer = window.setTimeout(() => (tag.hidden = true), 1400);
      }
    }, 250);
  }

  // ------------------------------------------------------------ briques

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

  async function renderGeneral(body: HTMLElement) {
    const path = el("input", "s-input");
    path.placeholder = "Automatique";
    path.value = s.claudePath ?? "";
    path.spellcheck = false;
    path.addEventListener("change", () => save({ claudePath: path.value.trim() || null }));
    const info = await d.guard(d.api.appInfo());
    const found = info?.claudePath ? d.home(info.claudePath) : "Introuvable : indique son chemin.";
    body.append(
      group(
        "Claude",
        row("Binaire claude", found, path),
        row("Réponse en direct", "Afficher le texte et le Markdown pendant l'écriture.", toggle(s.partialMessages, (v) => save({ partialMessages: v }))),
        row("Monde des agents", "Voir Claude et ses sous-agents travailler au-dessus du champ de saisie.", toggle(worldShown(), setWorldShown)),
        row("Workflow et /loop", "Environ 5 000 tokens de plus par requête. S'applique au prochain lancement de claude.", toggle(s.allTools, (v) => save({ allTools: v }))),
      ),
      group(
        "Nouvelles conversations",
        row(
          "Modèle",
          null,
          picker(s.defaultModel ? prettyModel(s.defaultModel) : "Par défaut", () => [
            { label: "Par défaut", checked: !s.defaultModel, run: () => (save({ defaultModel: null }), rerender()) },
            ...modelChoices().map((m) => ({ label: m.displayName, checked: s.defaultModel === m.value, run: () => (save({ defaultModel: m.value }), rerender()) })),
          ]),
        ),
        row(
          "Effort",
          "Plus d'effort : réponses plus réfléchies, mais plus lentes.",
          picker(effortLabel(s.defaultEffort) || "Par défaut", () => [
            { label: "Par défaut", checked: !s.defaultEffort, run: () => (save({ defaultEffort: null }), rerender()) },
            ...EFFORTS.map((e) => ({ label: e.label, checked: s.defaultEffort === e.id, run: () => (save({ defaultEffort: e.id }), rerender()) })),
          ]),
        ),
        row(
          "Permissions",
          null,
          picker(modeOf(s.defaultPermissionMode).label, () =>
            MODES.map((m) => ({ label: m.label, icon: m.icon, danger: m.id === "bypassPermissions", checked: s.defaultPermissionMode === m.id, run: () => (save({ defaultPermissionMode: m.id }), rerender()) })),
          ),
        ),
      ),
    );
  }

  async function renderPerf(body: HTMLElement) {
    body.append(
      group(
        "Processus claude",
        row("En parallèle", "Au-delà, la conversation inactive la plus ancienne est suspendue.", stepper(s.maxLive, 1, 10, 1, String, (n) => save({ maxLive: n }))),
        row("Suspension après inactivité", "Le processus s'arrête, la conversation reprend au message suivant.", stepper(s.idleMinutes, 0, 120, 5, (n) => (n ? `${n} min` : "Jamais"), (n) => save({ idleMinutes: n }))),
      ),
    );
    const m = await d.api.metrics().catch(() => undefined);
    if (m) {
      const cli = m.sessions.reduce((t, [, st]) => t + st.rssMb, 0);
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
          "En ce moment",
          row(`${fmtMb(m.harness.rssMb + cli)} utilisés`, `App ${fmtMb(m.harness.rssMb)}, ${n ? `${n} processus claude ${fmtMb(cli)}` : "aucun processus claude"}`, bar),
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
    const listGroup = group("Serveurs à lancer", ...(rows.length ? rows : [row("Aucun serveur MCP configuré", "Ajoute-en avec claude mcp add.", el("span"))]));
    listGroup.hidden = s.mcpMode !== "selected";
    body.append(
      group(
        null,
        row(
          "Ne lancer qu'une sélection",
          "Chaque conversation ne démarre que les serveurs cochés. Les connecteurs claude.ai restent éteints.",
          toggle(s.mcpMode === "selected", (v) => {
            save({ mcpMode: v ? "selected" : "all" });
            listGroup.hidden = !v;
          }),
        ),
      ),
      listGroup,
      el("p", "s-note", "S'applique aux nouvelles conversations. Le panneau Serveurs gère ceux d'une conversation en cours."),
    );
  }

  async function renderArchives(body: HTMLElement) {
    const list = (await d.guard(d.api.listArchived())) ?? [];
    if (!list.length) {
      body.append(el("p", "s-note", "Aucune conversation archivée."));
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
      const restore = el("button", "btn btn-ghost", "Restaurer");
      restore.type = "button";
      restore.addEventListener("click", () => void changed(d.api.setArchived(h.cliId, false)));
      const del = el("button", "icon-btn");
      del.type = "button";
      del.title = "Supprimer";
      del.setAttribute("aria-label", `Supprimer ${h.title}`);
      del.innerHTML = icon("trash");
      del.addEventListener("click", () => confirmMenu(del, "Supprimer cette conversation ?", DELETE_NOTE, "Supprimer", () => void changed(d.api.deleteConversation(h.cliId)), { align: "end" }));
      actions.append(restore, del);
      r.append(text, actions);
      return r;
    });
    body.append(group(null, ...rows));
  }

  async function renderAbout(body: HTMLElement) {
    const info = await d.guard(d.api.appInfo());
    body.append(
      group(
        null,
        await updateRow(`Version ${info?.version ?? "?"}`),
        row("Claude Code", info?.claudeVersion?.replace(" (Claude Code)", "") ?? "Introuvable", el("span")),
        row("Typographie et icônes", "Geist (OFL 1.1), Phosphor Icons (MIT)", el("span")),
        row("Créatures du monde des agents", "Free Pets Pack par Frakassets (CC BY 4.0)", el("span")),
      ),
    );
  }

  /** Version installée, avec la recherche de mise à jour (automatique toutes les 6 h). */
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
      btn.textContent = { idle: "Rechercher", upToDate: "Rechercher", error: "Réessayer", checking: "Recherche…", downloading: "Téléchargement…", ready: "Redémarrer" }[u.state];
      const note =
        u.state === "upToDate" ? " · à jour" : u.state === "ready" ? ` · ${u.version} prête` : u.state === "downloading" ? ` · ${u.version} trouvée` : u.state === "error" ? " · vérification impossible" : "";
      hint.textContent = version + note;
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

  async function rerender() {
    const body = $("s-body");
    const scroll = body.scrollTop;
    const frag = el("div");
    await { general: renderGeneral, perf: renderPerf, mcp: renderMcp, archives: renderArchives, about: renderAbout }[section](frag);
    body.replaceChildren(...frag.childNodes);
    body.scrollTop = scroll;
    $("s-title").textContent = TITLES[section];
    for (const b of dlg.querySelectorAll<HTMLElement>(".snav")) b.setAttribute("aria-current", String(b.dataset.sec === section));
  }

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
