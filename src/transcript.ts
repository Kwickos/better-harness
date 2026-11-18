// UI-side model of a session + DOM rendering of the transcript.
// Perf: only the displayed session has a DOM; the Markdown of a finished block is
// computed once (streaming included, see LiveMarkdown); tool details are only
// built when opened; `content-visibility` skips layout of off-screen messages.
import { countsLabel, renderLines, toolDiff } from "./diff";
import type { Artifact, Attachment, Block, InitEv, PermissionEv, RateLimitEv, ResultEv, SessionInfo, ToolResultEv } from "./api";
import { copyButton, decorateCode, wrapWithCopy } from "./copy";
import { t, tp } from "./i18n";
import { icon, type IconName } from "./icons";
import { DUR, enter, leave } from "./motion";
import { appendWithMentions } from "./mentions";
import { LiveMarkdown, renderMarkdown } from "./markdown";
import { artifactAction, FILES_TOOL, NEXT_STEP_TOOL, SIM_TOOL, simulatorAction, updateArtifacts, type NextStep } from "./labels";

const MAX_ITEMS = 600;

/** File a tool read or wrote (Read, Edit, Write, NotebookEdit…), to open it in the panel. */
function toolFilePath(tv: ToolView): string | null {
  try {
    const input = JSON.parse(tv.input) as { file_path?: unknown; notebook_path?: unknown };
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" && path ? path : null;
  } catch {
    return null;
  }
}

export interface ToolView {
  t: "tool";
  id: string;
  name: string;
  summary: string;
  input: string;
  result?: { text: string; isError: boolean; truncated: boolean };
  sub: number;
  /** Files shown by `send_files`, described once then kept for re-renders. */
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
  /** The conversation's artifacts, most recent first. */
  artifacts: Artifact[] = [];
  /** An artifact was just published or requested: show it if the conversation is on screen. */
  artifactToShow: string | null = null;
  perms = new Map<string, PermissionEv>();
  stream = { text: "", thinking: false };
  status: string | null = null;
  init?: InitEv;
  rateLimit?: RateLimitEv;
  /** Box of the last turn (`next_step`), until a message is sent. */
  nextStep: NextStep | null = null;
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

  /** Blocks of one message arrive in several events: merge them by id. */
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

// ---------------------------------------------------------------- activity lines

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

/** Current step, in the present tense: "Reading main.ts", "Running npm run build". */
function runningLabel(tool: ToolView): [string, string] {
  switch (kindOf(tool.name)) {
    case "read":
      return [t("Reading"), fileName(tool.summary)];
    case "edit":
      return [t("Editing"), fileName(tool.summary)];
    case "bash":
      return [t("Running"), tool.summary];
    case "search":
      return [t("Searching for"), tool.summary];
    case "web":
      return [tool.name === "WebSearch" ? t("Web search") : t("Reading"), tool.summary];
    case "agent":
      return [t("Subagent:"), tool.summary];
    case "ask":
      return [t("Waiting for your answer"), ""];
    case "plan":
      return [t("Waiting for plan approval"), ""];
    default:
      if (tool.name === SIM_TOOL) return [t("Simulator:"), simulatorAction(tool.input)];
      if (tool.name === "Artifact") return [t("Artifact:"), artifactAction(tool.input)];
      return [tool.name.replace(/^mcp__[^_]+__/, ""), tool.summary];
  }
}

function doneLabel(tools: ToolView[], thinking: number): string {
  const c: Record<Kind, number> = { read: 0, edit: 0, bash: 0, search: 0, web: 0, agent: 0, ask: 0, plan: 0, other: 0 };
  for (const tool of tools) c[kindOf(tool.name)]++;
  const parts = [
    c.read && tp(c.read, "{n} file read", "{n} files read"),
    c.edit && tp(c.edit, "{n} file edited", "{n} files edited"),
    c.bash && tp(c.bash, "{n} command", "{n} commands"),
    c.search && tp(c.search, "{n} search", "{n} searches"),
    c.web && tp(c.web, "{n} web page", "{n} web pages"),
    c.agent && tp(c.agent, "{n} subagent", "{n} subagents"),
    c.ask && tp(c.ask, "{n} question", "{n} questions"),
    c.plan && tp(c.plan, "{n} plan proposed", "{n} plans proposed"),
    c.other && tp(c.other, "{n} tool", "{n} tools"),
  ].filter(Boolean) as string[];
  if (!parts.length) return thinking ? t("Thinking") : "";
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

// ---------------------------------------------------------------- rendering

/** What arrives live: never when a conversation opens, where everything shows at once. */
const appear = (node: HTMLElement) => void enter(node, { opacity: "0", transform: "translateY(4px)" });

export class TranscriptRenderer {
  private view?: SessionView;
  private itemEls = new Map<Item, HTMLElement>();
  private toolEls = new Map<string, HTMLDetailsElement>();
  private toolGroup = new Map<string, Group>();
  private group?: Group;
  private stick = true;
  private lastTop = 0;
  private scrollQueued = false;
  private live?: LiveMarkdown;

  constructor(
    private scroller: HTMLElement,
    private itemsEl: HTMLElement,
    private streamEl: HTMLElement,
    private onLoadMore: () => void,
    private messageActions: { edit: (text: string) => void; retry: (text: string) => void },
    /** Block of files Claude shows; `settled` once it has taken its size. */
    private attachments: (tv: ToolView, settled: () => void) => HTMLElement,
  ) {
    scroller.addEventListener(
      "scroll",
      () => {
        // Only the reader scrolling up leaves the end. A scroll to the bottom reports itself a frame
        // later, when streamed text may have grown the thread: that one must not let go of the end.
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80) this.stick = true;
        else if (scroller.scrollTop < this.lastTop) this.stick = false;
        this.lastTop = scroller.scrollTop;
      },
      { passive: true },
    );
    // Something above the input field grows (next-step box, request): a thread read at its end stays there.
    new ResizeObserver(() => this.scrollToBottom()).observe(scroller);
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
      const more = el("button", "load-more", t("Earlier messages"));
      more.type = "button";
      more.addEventListener("click", () => this.onLoadMore());
      frag.append(more);
    }
    if (view) for (const it of view.items) frag.append(this.renderItem(it));
    this.itemsEl.replaceChildren(frag);
    this.setStream(view && !view.stream.thinking ? view.stream.text : "", true);
    this.stick = true;
    this.placeAtEnd();
    this.lastTop = this.scroller.scrollTop;
    this.scrollToBottom();
    if (crossfade && view) void enter(this.itemsEl, { opacity: "0" });
  }

  /** Redraws the conversation on screen (language change) and keeps the reading position. */
  refresh() {
    if (!this.view) return;
    const { scrollTop } = this.scroller;
    const stick = this.stick;
    this.mount(this.view);
    // mount() queues a scroll to the bottom: put the reader back where they were, after it.
    if (!stick)
      requestAnimationFrame(() => {
        this.stick = false;
        this.scroller.scrollTop = scrollTop;
      });
  }

  /**
   * Visible messages move to a layer that fades out while the new content appears:
   * there is never a frame where the area is empty. Only on-screen ones are moved, the rest is dropped.
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
    // Same duration as the entry, no offset: measured at 60 fps, a faster exit lets the area dip
    // to the background for 50 ms, and that dip is what shows as a flash.
    void leave(ghost, { opacity: 0 }, { duration: DUR.fast }).then(() => ghost.remove());
  }

  /**
   * On mount, the thread lands on its last message right away, without waiting for the next frame.
   * `content-visibility` is lifted for that layout: otherwise messages only have an estimated
   * height, and the thread jumps when they appear.
   */
  private placeAtEnd() {
    const s = this.scroller;
    s.classList.add("is-mounting");
    s.scrollTop = s.scrollHeight;
    // Without this delay, macOS flashes the scrollbar on every conversation switch.
    window.setTimeout(() => s.classList.remove("is-mounting"), DUR.medium * 1000);
  }

  /** The thread area may have just been shown: only then does it have a height. */
  afterShow() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Adds a new item or completes the existing assistant item. */
  upsert(item: Item, added?: BlockView[]) {
    const existing = this.itemEls.get(item);
    if (existing && added && item.k === "assistant") {
      for (const b of added) {
        const n = this.renderBlock(b);
        if (!n) continue;
        // Actions stay under the message, whatever block arrives.
        existing.insertBefore(n, existing.querySelector(":scope > .msg-actions"));
        // Text was already seen live: only a new step animates in.
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
      if (meta) meta.textContent = tv.sub ? tp(tv.sub, "{n} step", "{n} steps") : tv.result?.isError ? t("failed") : "";
      if (d.open) this.fillTool(d, tv);
    }
    const g = this.toolGroup.get(tv.id);
    if (g) this.refreshGroup(g);
  }

  /** Reply being written: Markdown rendered live (only the last block is recomputed). */
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
        // Duration, tokens and cost don't clutter the conversation; only a real failure shows.
        const r = it.ev;
        const shown = r.isError && r.subtype !== "success";
        node = el("div", shown ? "msg msg-error" : "msg-hidden", shown ? t("The request failed ({subtype}).", { subtype: r.subtype }) : undefined);
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
    box.append(copyButton(() => text, "Copy", "msg-action"), this.action("pencil", t("Edit"), () => this.messageActions.edit(text)));
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

  /** Under a message with text: copy its reply, or resend the question that produced it. */
  private syncAssistantActions(it: Extract<Item, { k: "assistant" }>, node: HTMLElement) {
    if (node.querySelector(":scope > .msg-actions") || !it.blocks.some((b) => b.t === "text")) return;
    const box = el("div", "msg-actions");
    const text = () =>
      it.blocks
        .flatMap((b) => (b.t === "text" ? [b.text] : []))
        .join("\n\n");
    box.append(copyButton(text, "Copy", "msg-action"));
    const question = this.previousUser(it);
    if (question !== null) box.append(this.action("reload", t("Retry"), () => this.messageActions.retry(question)));
    node.append(box);
    node.classList.add("has-actions");
  }

  /** A text block shows as is; tools and thinking join the current activity line. */
  private renderBlock(b: BlockView): HTMLElement | null {
    if (b.t === "text") {
      this.group = undefined;
      const d = el("div", "md");
      b.html ??= renderMarkdown(b.text);
      d.innerHTML = b.html;
      decorateCode(d);
      return d;
    }
    // The next-step box is drawn above the input field, not in the thread.
    if (b.t === "tool" && b.name === NEXT_STEP_TOOL) return null;
    // Shown files: they take their place in the thread, outside the activity line.
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
    const running = [...g.tools].reverse().find((tool) => !tool.result);
    const errors = g.tools.filter((tool) => tool.result?.isError).length;
    g.el.dataset.state = running ? "running" : errors ? "error" : "done";
    if (running) {
      const [verb, target] = runningLabel(running);
      g.label.replaceChildren(el("span", undefined, verb), " ", el("code", undefined, target));
    } else {
      g.label.textContent = doneLabel(g.tools, g.thinking);
      if (errors) g.label.append(el("span", "act-err", `, ${tp(errors, "{n} error", "{n} errors")}`));
    }
  }

  private thinkingRow(text: string): HTMLElement {
    const d = el("details", "tool is-thinking");
    d.append(el("summary", undefined, t("Thinking")));
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
    const [toolName, toolSummary] = b.name === SIM_TOOL ? [t("Simulator"), simulatorAction(b.input)] : b.name === "Artifact" ? [t("Artifact"), artifactAction(b.input)] : [b.name.replace(/^mcp__/, "").replace(/__/g, " "), b.summary];
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
    // Question or plan: they were read in their card, only the result is still useful here.
    const shown = kindOf(tv.name) === "ask" || kindOf(tv.name) === "plan";
    const path = toolFilePath(tv);
    if (path) {
      const open = el("button", "tool-open");
      open.type = "button";
      open.dataset.openFile = path;
      open.title = t("Open in the panel");
      open.innerHTML = icon("file", 13);
      open.append(el("span", undefined, path));
      body.append(open);
    }
    if (!shown) body.append(diff ? renderLines(diff.lines) : wrapWithCopy(el("pre", "tool-io", tv.input)));
    // A diff already says it all: the tool output only shows if it failed.
    if (tv.result && (!diff || tv.result.isError)) {
      body.append(wrapWithCopy(el("pre", `tool-io is-out${tv.result.isError ? " is-error" : ""}`, tv.result.text || t("(no output)"))));
    }
    const first = !d.querySelector(".tool-body");
    d.querySelector(".tool-body")?.remove();
    d.append(body);
    if (first) appear(body);
  }
}
