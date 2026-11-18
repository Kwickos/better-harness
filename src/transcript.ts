// Modèle d'une session côté UI + rendu DOM du transcript.
// Perf : seule la session affichée a un DOM ; le Markdown d'un bloc terminé n'est
// calculé qu'une fois (y compris en streaming, cf. LiveMarkdown) ; le détail des
// outils n'est construit qu'à l'ouverture ; `content-visibility` saute la mise en
// page des messages hors écran.
import { countsLabel, renderLines, toolDiff } from "./diff";
import type { Artifact, Attachment, Block, InitEv, PermissionEv, RateLimitEv, ResultEv, SessionInfo, ToolResultEv } from "./api";
import { copyButton, decorateCode, wrapWithCopy } from "./copy";
import { icon, type IconName } from "./icons";
import { DUR, enter, leave } from "./motion";
import { appendWithMentions } from "./mentions";
import { LiveMarkdown, renderMarkdown } from "./markdown";
import { artifactAction, FILES_TOOL, SIM_TOOL, simulatorAction, updateArtifacts } from "./labels";

const MAX_ITEMS = 600;

export interface ToolView {
  t: "tool";
  id: string;
  name: string;
  summary: string;
  input: string;
  result?: { text: string; isError: boolean; truncated: boolean };
  sub: number;
  /** Fichiers montrés par `send_files`, décrits une fois puis gardés pour les réaffichages. */
  files?: Attachment[];
}
export type BlockView = { t: "text"; text: string; html?: string } | { t: "thinking"; text: string } | ToolView;

export type Item =
  | { k: "user"; text: string }
  | { k: "assistant"; id: string; blocks: BlockView[] }
  | { k: "result"; ev: ResultEv }
  | { k: "notice"; level: string; text: string };

export class SessionView {
  items: Item[] = [];
  tools = new Map<string, ToolView>();
  /** Les artefacts de la conversation, le plus récent d'abord. */
  artifacts: Artifact[] = [];
  /** Un artefact vient d'être publié ou demandé : à montrer si la conversation est affichée. */
  artifactToShow: string | null = null;
  perms = new Map<string, PermissionEv>();
  stream = { text: "", thinking: false };
  status: string | null = null;
  init?: InitEv;
  rateLimit?: RateLimitEv;
  historyLoaded = false;
  hasMore = false;
  historyLimit = 300;
  busySince = 0;

  constructor(public info: SessionInfo) {}

  private push(item: Item) {
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) {
      const dropped = this.items.splice(0, this.items.length - MAX_ITEMS);
      for (const it of dropped) {
        if (it.k === "assistant") for (const b of it.blocks) if (b.t === "tool") this.tools.delete(b.id);
      }
      this.hasMore = true;
    }
  }

  addUser(text: string): Item {
    const it: Item = { k: "user", text };
    this.push(it);
    return it;
  }

  /** Les blocs d'un même message arrivent en plusieurs événements : on fusionne par id. */
  addAssistant(id: string, blocks: Block[]): { item: Item; added: BlockView[] } {
    const last = this.items[this.items.length - 1];
    let item: Item & { k: "assistant" };
    if (last && last.k === "assistant" && id && last.id === id) {
      item = last;
    } else {
      item = { k: "assistant", id, blocks: [] };
      this.push(item);
    }
    const added: BlockView[] = [];
    for (const b of blocks) {
      if (b.t === "tool") {
        if (this.tools.has(b.id)) continue;
        const tv: ToolView = { ...b, sub: 0 };
        this.tools.set(b.id, tv);
        item.blocks.push(tv);
        added.push(tv);
      } else {
        if (item.blocks.some((x) => x.t === b.t && "text" in x && x.text === b.text)) continue;
        const bv: BlockView = { ...b };
        item.blocks.push(bv);
        added.push(bv);
      }
    }
    return { item, added };
  }

  addToolResult(ev: ToolResultEv): ToolView | undefined {
    if (ev.parent) {
      const parent = this.tools.get(ev.parent);
      if (parent) parent.sub++;
      return parent;
    }
    const tv = this.tools.get(ev.toolUseId);
    if (tv) {
      tv.result = { text: ev.text, isError: ev.isError, truncated: ev.truncated };
      if (tv.name === "Artifact") this.artifactToShow = updateArtifacts(this.artifacts, tv.input, ev) ?? this.artifactToShow;
    }
    return tv;
  }

  addResult(ev: ResultEv): Item {
    const it: Item = { k: "result", ev };
    this.push(it);
    return it;
  }

  addNotice(level: string, text: string): Item {
    const it: Item = { k: "notice", level, text };
    this.push(it);
    return it;
  }

  reset() {
    this.artifacts = [];
    this.artifactToShow = null;
    this.items = [];
    this.tools.clear();
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- lignes d'activité

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const fileName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

type Kind = "read" | "edit" | "bash" | "search" | "web" | "agent" | "ask" | "plan" | "other";
function kindOf(name: string): Kind {
  if (name === "Read" || name === "NotebookRead") return "read";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return "edit";
  if (name === "Bash") return "bash";
  if (name === "Grep" || name === "Glob" || name === "LS") return "search";
  if (name === "WebFetch" || name === "WebSearch") return "web";
  if (name === "Task" || name === "Agent") return "agent";
  if (name === "AskUserQuestion") return "ask";
  if (name === "ExitPlanMode") return "plan";
  return "other";
}

/** Étape en cours, au présent : « Lecture de main.ts », « Exécution de npm run build ». */
function runningLabel(t: ToolView): [string, string] {
  switch (kindOf(t.name)) {
    case "read":
      return ["Lecture de", fileName(t.summary)];
    case "edit":
      return ["Modification de", fileName(t.summary)];
    case "bash":
      return ["Exécution de", t.summary];
    case "search":
      return ["Recherche de", t.summary];
    case "web":
      return [t.name === "WebSearch" ? "Recherche web" : "Lecture de", t.summary];
    case "agent":
      return ["Sous-agent :", t.summary];
    case "ask":
      return ["Attend ta réponse", ""];
    case "plan":
      return ["Attend ta validation du plan", ""];
    default:
      if (t.name === SIM_TOOL) return ["Simulateur :", simulatorAction(t.input)];
      if (t.name === "Artifact") return ["Artefact :", artifactAction(t.input)];
      return [t.name.replace(/^mcp__[^_]+__/, ""), t.summary];
  }
}

function doneLabel(tools: ToolView[], thinking: number): string {
  const c: Record<Kind, number> = { read: 0, edit: 0, bash: 0, search: 0, web: 0, agent: 0, ask: 0, plan: 0, other: 0 };
  for (const t of tools) c[kindOf(t.name)]++;
  const parts = [
    c.read && plural(c.read, "fichier lu", "fichiers lus"),
    c.edit && plural(c.edit, "fichier modifié", "fichiers modifiés"),
    c.bash && plural(c.bash, "commande", "commandes"),
    c.search && plural(c.search, "recherche", "recherches"),
    c.web && plural(c.web, "page web", "pages web"),
    c.agent && plural(c.agent, "sous-agent", "sous-agents"),
    c.ask && plural(c.ask, "question", "questions"),
    c.plan && plural(c.plan, "plan proposé", "plans proposés"),
    c.other && plural(c.other, "outil", "outils"),
  ].filter(Boolean) as string[];
  if (!parts.length) return thinking ? "Réflexion" : "";
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Group {
  el: HTMLDetailsElement;
  label: HTMLElement;
  list: HTMLElement;
  tools: ToolView[];
  thinking: number;
}

// ---------------------------------------------------------------- rendu

/** Ce qui arrive en direct : jamais à l'ouverture d'une conversation, où tout s'affiche d'un bloc. */
const appear = (node: HTMLElement) => void enter(node, { opacity: "0", transform: "translateY(4px)" });

export class TranscriptRenderer {
  private view?: SessionView;
  private itemEls = new Map<Item, HTMLElement>();
  private toolEls = new Map<string, HTMLDetailsElement>();
  private toolGroup = new Map<string, Group>();
  private group?: Group;
  private stick = true;
  private scrollQueued = false;
  private live?: LiveMarkdown;

  constructor(
    private scroller: HTMLElement,
    private itemsEl: HTMLElement,
    private streamEl: HTMLElement,
    private onLoadMore: () => void,
    private messageActions: { edit: (text: string) => void; retry: (text: string) => void },
    /** Bloc des fichiers que Claude montre ; `settled` quand il a pris sa taille. */
    private attachments: (tv: ToolView, settled: () => void) => HTMLElement,
  ) {
    scroller.addEventListener(
      "scroll",
      () => {
        this.stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      },
      { passive: true },
    );
  }

  get mounted() {
    return this.view;
  }

  mount(view: SessionView | undefined, crossfade = false) {
    if (crossfade) this.fadeOutCurrent();
    this.view = view;
    this.itemEls.clear();
    this.toolEls.clear();
    this.toolGroup.clear();
    this.group = undefined;
    const frag = document.createDocumentFragment();
    if (view?.hasMore) {
      const more = el("button", "load-more", "Messages précédents");
      more.type = "button";
      more.addEventListener("click", () => this.onLoadMore());
      frag.append(more);
    }
    if (view) for (const it of view.items) frag.append(this.renderItem(it));
    this.itemsEl.replaceChildren(frag);
    this.setStream(view && !view.stream.thinking ? view.stream.text : "", true);
    this.stick = true;
    this.placeAtEnd();
    this.scrollToBottom();
    if (crossfade && view) void enter(this.itemsEl, { opacity: "0" });
  }

  /**
   * Les messages visibles passent dans un calque qui s'efface pendant que le nouveau contenu apparaît :
   * il n'y a jamais d'image où la zone est vide. Seuls ceux à l'écran sont déplacés, le reste est jeté.
   */
  private fadeOutCurrent() {
    const s = this.scroller;
    const parent = s.parentElement;
    if (s.hidden || !parent) return;
    const box = s.getBoundingClientRect();
    const seen = [...this.itemsEl.children].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.height > 0 && r.bottom > box.top && r.top < box.bottom;
    }) as HTMLElement[];
    if (!seen.length) return;
    const ghost = el("div", "transcript-ghost");
    ghost.style.top = `${box.top - parent.getBoundingClientRect().top}px`;
    ghost.style.height = `${box.height}px`;
    const column = el("div", "column");
    column.style.marginTop = `${seen[0].getBoundingClientRect().top - box.top}px`;
    column.append(...seen);
    ghost.append(column);
    parent.append(ghost);
    // Même durée que l'entrée, sans décalage : mesuré à 60 i/s, un départ plus rapide fait replonger la
    // zone jusqu'au fond pendant 50 ms, et c'est ce creux qui se voit comme un flash.
    void leave(ghost, { opacity: 0 }, { duration: DUR.fast }).then(() => ghost.remove());
  }

  /**
   * Au montage, le fil se place tout de suite sur son dernier message, sans attendre l'image suivante.
   * `content-visibility` est levé le temps de cette mise en page : sinon les messages n'ont qu'une hauteur
   * estimée, et le fil saute quand ils apparaissent.
   */
  private placeAtEnd() {
    const s = this.scroller;
    s.classList.add("is-mounting");
    s.scrollTop = s.scrollHeight;
    // Sans ce délai, macOS fait clignoter la barre de défilement à chaque changement de conversation.
    window.setTimeout(() => s.classList.remove("is-mounting"), DUR.medium * 1000);
  }

  /** La zone du fil vient peut-être d'être affichée : c'est seulement là qu'elle a une hauteur. */
  afterShow() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Ajoute un nouvel item ou complète l'item assistant existant. */
  upsert(item: Item, added?: BlockView[]) {
    const existing = this.itemEls.get(item);
    if (existing && added && item.k === "assistant") {
      for (const b of added) {
        const n = this.renderBlock(b);
        if (!n) continue;
        // Les actions restent sous le message, quel que soit le bloc qui arrive.
        existing.insertBefore(n, existing.querySelector(":scope > .msg-actions"));
        // Un texte a déjà été vu en direct : seule une nouvelle étape entre en mouvement.
        if (b.t !== "text") appear(n);
      }
      this.syncAssistantActions(item, existing);
    } else if (!existing) {
      const node = this.renderItem(item);
      this.itemsEl.append(node);
      if (item.k !== "assistant") appear(node);
    }
    this.scrollToBottom();
  }

  updateTool(tv: ToolView) {
    const d = this.toolEls.get(tv.id);
    if (d) {
      d.dataset.state = tv.result ? (tv.result.isError ? "error" : "done") : "running";
      const meta = d.querySelector(".tool-meta");
      if (meta) meta.textContent = tv.sub ? plural(tv.sub, "étape", "étapes") : tv.result?.isError ? "échec" : "";
      if (d.open) this.fillTool(d, tv);
    }
    const g = this.toolGroup.get(tv.id);
    if (g) this.refreshGroup(g);
  }

  /** Réponse en cours d'écriture : Markdown rendu en direct (seul le dernier bloc est recalculé). */
  setStream(text: string, replace: boolean) {
    if (replace || !this.live) {
      this.streamEl.replaceChildren();
      this.live = undefined;
      if (text || !replace) {
        const box = el("div", "md");
        this.streamEl.append(box);
        void enter(box, { opacity: "0" }, { duration: DUR.quick });
        this.live = new LiveMarkdown(box);
      }
    }
    if (text) this.live?.append(text);
    this.streamEl.hidden = !this.live;
    this.scrollToBottom();
  }

  get streaming() {
    return !!this.live;
  }

  private scrollToBottom() {
    if (!this.stick || this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  private renderItem(it: Item): HTMLElement {
    let node: HTMLElement;
    switch (it.k) {
      case "user":
        this.group = undefined;
        node = el("div", "msg msg-user");
        const bubble = el("div", "bubble");
        appendWithMentions(bubble, it.text);
        node.append(this.userActions(it.text), bubble);
        break;
      case "assistant":
        node = el("div", "msg msg-assistant");
        for (const b of it.blocks) {
          const n = this.renderBlock(b);
          if (n) node.append(n);
        }
        this.syncAssistantActions(it, node);
        break;
      case "result": {
        // Durée, tokens et coût n'encombrent pas la conversation ; seul un vrai échec s'affiche.
        const r = it.ev;
        const shown = r.isError && r.subtype !== "success";
        node = el("div", shown ? "msg msg-error" : "msg-hidden", shown ? `La requête a échoué (${r.subtype}).` : undefined);
        if (shown && r.text) node.title = r.text;
        if (shown) this.group = undefined;
        break;
      }
      case "notice":
        if (it.level === "info") {
          node = el("div", "msg-hidden");
        } else {
          this.group = undefined;
          node = el("div", `msg msg-error${it.level === "warn" ? " is-warn" : ""}`, it.text);
        }
        break;
    }
    this.itemEls.set(it, node);
    return node;
  }

  private action(name: IconName, label: string, run: () => void): HTMLElement {
    const b = el("button", "icon-btn msg-action");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = icon(name, 14);
    b.addEventListener("click", run);
    return b;
  }

  private userActions(text: string): HTMLElement {
    const box = el("div", "msg-actions");
    box.append(copyButton(() => text, "Copier", "msg-action"), this.action("pencil", "Modifier", () => this.messageActions.edit(text)));
    return box;
  }

  private previousUser(it: Item): string | null {
    const items = this.view?.items ?? [];
    for (let i = items.indexOf(it) - 1; i >= 0; i--) {
      const candidate = items[i];
      if (candidate.k === "user") return candidate.text;
    }
    return null;
  }

  /** Sous un message qui contient du texte : copier sa réponse, ou renvoyer la question qui l'a produite. */
  private syncAssistantActions(it: Extract<Item, { k: "assistant" }>, node: HTMLElement) {
    if (node.querySelector(":scope > .msg-actions") || !it.blocks.some((b) => b.t === "text")) return;
    const box = el("div", "msg-actions");
    const text = () =>
      it.blocks
        .flatMap((b) => (b.t === "text" ? [b.text] : []))
        .join("\n\n");
    box.append(copyButton(text, "Copier", "msg-action"));
    const question = this.previousUser(it);
    if (question !== null) box.append(this.action("reload", "Réessayer", () => this.messageActions.retry(question)));
    node.append(box);
    node.classList.add("has-actions");
  }

  /** Un bloc texte s'affiche tel quel ; outils et réflexion rejoignent la ligne d'activité courante. */
  private renderBlock(b: BlockView): HTMLElement | null {
    if (b.t === "text") {
      this.group = undefined;
      const d = el("div", "md");
      b.html ??= renderMarkdown(b.text);
      d.innerHTML = b.html;
      decorateCode(d);
      return d;
    }
    // Des fichiers montrés : ils prennent place dans le fil, hors de la ligne d'activité.
    if (b.t === "tool" && b.name === FILES_TOOL) {
      this.group = undefined;
      return this.attachments(b, () => this.scrollToBottom());
    }
    let created: HTMLElement | null = null;
    if (!this.group) {
      this.group = this.newGroup();
      created = this.group.el;
    }
    const g = this.group;
    if (b.t === "thinking") {
      g.thinking++;
      g.list.append(this.thinkingRow(b.text));
    } else {
      g.tools.push(b);
      this.toolGroup.set(b.id, g);
      g.list.append(this.toolRow(b));
    }
    this.refreshGroup(g);
    return created;
  }

  private newGroup(): Group {
    const d = el("details", "activity");
    const s = el("summary");
    const label = el("span", "act-label");
    const chev = el("span", "act-chev");
    chev.innerHTML = icon("chevronRight");
    s.append(label, chev);
    const list = el("div", "act-list");
    d.append(s, list);
    d.addEventListener("toggle", () => {
      if (d.open) appear(list);
    });
    return { el: d, label, list, tools: [], thinking: 0 };
  }

  private refreshGroup(g: Group) {
    const running = [...g.tools].reverse().find((t) => !t.result);
    const errors = g.tools.filter((t) => t.result?.isError).length;
    g.el.dataset.state = running ? "running" : errors ? "error" : "done";
    if (running) {
      const [verb, target] = runningLabel(running);
      g.label.replaceChildren(el("span", undefined, verb), " ", el("code", undefined, target));
    } else {
      g.label.textContent = doneLabel(g.tools, g.thinking);
      if (errors) g.label.append(el("span", "act-err", `, ${plural(errors, "échec", "échecs")}`));
    }
  }

  private thinkingRow(text: string): HTMLElement {
    const d = el("details", "tool is-thinking");
    d.append(el("summary", undefined, "Réflexion"));
    d.addEventListener("toggle", () => {
      if (d.open && d.childElementCount === 1) d.append(el("div", "tool-body thinking-body", text));
    });
    return d;
  }

  private toolRow(b: ToolView): HTMLDetailsElement {
    const d = el("details", "tool");
    d.dataset.state = "running";
    const s = el("summary");
    const diff = toolDiff(b.name, b.input);
    const [toolName, toolSummary] = b.name === SIM_TOOL ? ["Simulateur", simulatorAction(b.input)] : b.name === "Artifact" ? ["Artefact", artifactAction(b.input)] : [b.name.replace(/^mcp__/, "").replace(/__/g, " "), b.summary];
    s.append(el("span", "tool-name", toolName), el("code", "tool-sum", toolSummary));
    if (diff) s.append(countsLabel(diff.added, diff.removed));
    s.append(el("span", "tool-meta"));
    d.append(s);
    d.addEventListener("toggle", () => {
      if (d.open) this.fillTool(d, b);
    });
    this.toolEls.set(b.id, d);
    return d;
  }

  private fillTool(d: HTMLDetailsElement, tv: ToolView) {
    const body = el("div", "tool-body");
    const diff = toolDiff(tv.name, tv.input);
    // Question ou plan : ils ont été lus dans leur carte, seul le résultat reste utile ici.
    const shown = kindOf(tv.name) === "ask" || kindOf(tv.name) === "plan";
    if (!shown) body.append(diff ? renderLines(diff.lines) : wrapWithCopy(el("pre", "tool-io", tv.input)));
    // Un diff dit déjà tout : la sortie de l'outil ne s'affiche que s'il a échoué.
    if (tv.result && (!diff || tv.result.isError)) {
      body.append(wrapWithCopy(el("pre", `tool-io is-out${tv.result.isError ? " is-error" : ""}`, tv.result.text || "(aucune sortie)")));
    }
    const first = !d.querySelector(".tool-body");
    d.querySelector(".tool-body")?.remove();
    d.append(body);
    if (first) appear(body);
  }
}
