// Agent world: each Claude in the conversation (the main one and its subagents) is a
// creature that walks to the station of what it is doing and says it in a bubble. Scenery: src/assets/world-*.png
// (732 × 88 pixels); creatures: src/assets/critters/*.png, from the Free Pets Pack by Frakassets
// (CC BY 4.0, https://frakassets.itch.io/free-pets-pack). The animation only runs while the world is
// shown and the window visible.
import type { Block, UiEvent } from "./api";
import { t, tp } from "./i18n";
import { NEXT_STEP_TOOL } from "./labels";
import nightUrl from "./assets/world-night.png";
import dayUrl from "./assets/world-day.png";
import foxSheetUrl from "./assets/critters/fox.png";
import foxAtlas from "./assets/critters/fox.json";
import catSheetUrl from "./assets/critters/cat.png";
import catAtlas from "./assets/critters/cat.json";
import bunnySheetUrl from "./assets/critters/bunny.png";
import bunnyAtlas from "./assets/critters/bunny.json";
import puppySheetUrl from "./assets/critters/puppy.png";
import puppyAtlas from "./assets/critters/puppy.json";
import hedgehogSheetUrl from "./assets/critters/hedgehog.png";
import hedgehogAtlas from "./assets/critters/hedgehog.json";

const W = 732;
const H = 88;
/** Ground line: the creatures' feet rest on it. */
const GROUND = 86;
const FPS = 12;
/** When every creature is asleep by the fire. */
const CALM_FPS = 4;
/** Pixels per second. */
const SPEED = 170;
/** How long a one-off line lasts ("All done!", an error…). */
const QUIP_MS = 2600;

// ---------------------------------------------------------------- places

type Station = "gate" | "library" | "telescope" | "bench" | "fire" | "terminal" | "antenna" | "board" | "mailbox";

/** X of each station, measured on each scenery (the day one is slightly shifted). */
const NIGHT: Record<Station, number> = { gate: 48, library: 146, telescope: 236, bench: 324, fire: 424, terminal: 506, antenna: 544, board: 606, mailbox: 694 };
const DAY: Record<Station, number> = { gate: 72, library: 162, telescope: 258, bench: 332, fire: 436, terminal: 522, antenna: 556, board: 628, mailbox: 708 };

// ---------------------------------------------------------------- what a tool does: where, and what the creature says

interface Action {
  station: Station;
  say: string;
}

const short = (s: string, n = 34) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function parseInput(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A shell command, said the way a human would describe it. */
export function bashAction(command: string): Action {
  // Judge the real command, not the `cd folder &&` before it.
  const cmd = command.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "").trim();
  const is = (re: RegExp) => re.test(cmd);
  if (is(/\b(vitest|jest|pytest|mocha|playwright)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bcargo\s+test\b|\bgo\s+test\b/)) return { station: "terminal", say: t("Running the tests") };
  if (is(/\b(tsc|webpack|esbuild)\b|\bvite\s+build\b|\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\bcargo\s+(build|check)\b|\bmake\b|\bxcodebuild\b/)) return { station: "terminal", say: t("Building the project") };
  if (is(/\b(eslint|prettier|clippy|ruff|biome)\b|\b(npm|pnpm)\s+run\s+(lint|format)\b/)) return { station: "terminal", say: t("Checking the code style") };
  if (is(/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b|^pip3?\s+install\b|^cargo\s+add\b|^brew\s+install\b/)) return { station: "terminal", say: t("Installing dependencies") };
  if (is(/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\btauri\s+dev\b/)) return { station: "terminal", say: t("Starting the server") };
  if (is(/^git\s+commit\b/)) return { station: "board", say: t("Making a commit") };
  if (is(/^git\s+push\b/)) return { station: "antenna", say: t("Pushing to the repo") };
  if (is(/^git\s+(log|show|blame)\b/)) return { station: "library", say: t("Reading the git history") };
  if (is(/^git\s+(status|diff)\b/)) return { station: "bench", say: t("Looking at what changed") };
  if (is(/^git\b/)) return { station: "terminal", say: t("Running {cmd}", { cmd: short(cmd, 24) }) };
  if (is(/^gh\b/)) return { station: "antenna", say: t("Talking to GitHub") };
  if (is(/^(cat|head|tail|less|bat|wc)\b|^sed\s+-n\b/)) return { station: "library", say: t("Reading a file") };
  if (is(/^(grep|rg|ag|osgrep|fd)\b/)) return { station: "telescope", say: t("Searching the code") };
  if (is(/^(ls|tree|find|du)\b/)) return { station: "telescope", say: t("Looking through the folders") };
  if (is(/^(curl|wget|http)\b/)) return { station: "antenna", say: t("Querying a web address") };
  if (is(/^(rm|mv|cp|mkdir|touch|chmod|ln)\b/)) return { station: "bench", say: t("Tidying up files") };
  if (is(/^(node|python3?|deno|bun|ruby)\b/)) return { station: "terminal", say: t("Running a script") };
  return { station: "terminal", say: t("Running {cmd}", { cmd: short(cmd.split(/\s+/).slice(0, 3).join(" "), 26) }) };
}

/** Where a creature goes for a tool, and what it announces. */
export function toolAction(name: string, summary: string, inputText: string): Action {
  const input = parseInput(inputText);
  const file = base(str(input.file_path) || str(input.notebook_path) || summary);
  if (name.startsWith("mcp__")) return { station: "antenna", say: t("Using {name}", { name: name.split("__")[1] || t("a server") }) };
  switch (name) {
    case "Read":
      return { station: "library", say: t("Reading {name}", { name: short(file, 26) }) };
    case "Grep":
      return { station: "telescope", say: t("Searching for “{text}”", { text: short(str(input.pattern) || summary, 20) }) };
    case "Glob":
      return { station: "telescope", say: t("Looking for files {pattern}", { pattern: short(str(input.pattern) || summary, 20) }) };
    case "LSP":
      return { station: "telescope", say: t("Analyzing the code") };
    case "ToolSearch":
      return { station: "telescope", say: t("Looking for the right tool") };
    case "Edit":
    case "MultiEdit":
      return { station: "bench", say: t("Editing {name}", { name: short(file, 24) }) };
    case "Write":
      return { station: "bench", say: t("Writing {name}", { name: short(file, 26) }) };
    case "NotebookEdit":
      return { station: "bench", say: t("Editing the notebook") };
    case "Bash":
      return bashAction(str(input.command) || summary || inputText);
    case "BashOutput":
    case "TaskOutput":
    case "Monitor":
      return { station: "terminal", say: t("Watching a command") };
    case "KillShell":
    case "TaskStop":
      return { station: "terminal", say: t("Stopping a command") };
    case "WebSearch":
      return { station: "antenna", say: t("Searching the web for “{text}”", { text: short(str(input.query) || summary, 20) }) };
    case "WebFetch": {
      let host = summary;
      try {
        host = new URL(str(input.url) || summary).host;
      } catch {
        // Unreadable URL: keep the summary.
      }
      return { station: "antenna", say: t("Reading {name}", { name: short(host, 26) }) };
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const now = todos.find((x) => x.status === "in_progress");
      const text = now ? str(now.activeForm) || str(now.content) : "";
      return { station: "board", say: text ? short(text, 34) : t("Updating my list") };
    }
    case "TaskCreate":
    case "TaskUpdate":
      return { station: "board", say: t("Updating my list") };
    case "EnterPlanMode":
      return { station: "board", say: t("Making a plan") };
    case "ExitPlanMode":
      return { station: "mailbox", say: t("My plan is ready") };
    case "Skill":
      return { station: "library", say: t("Checking the {name} skill", { name: short(str(input.skill) || summary, 18) }) };
    case "AskUserQuestion":
      return { station: "mailbox", say: t("I have a question for you") };
    case "Artifact":
      return { station: "board", say: t("Publishing a page") };
    case "SubagentHandback":
      // CLI internal tool: the subagent hands its report to the main agent.
      return { station: "board", say: t("Writing my report") };
    default:
      return { station: "terminal", say: t("Using {name}", { name: short(name, 20) }) };
  }
}

type ToolBlock = Extract<Block, { t: "tool" }>;

/** Several tools run at once: one station, one sentence that sums them up. */
function batchAction(blocks: ToolBlock[]): Action {
  const actions = blocks.map((b) => toolAction(b.name, b.summary, b.input));
  if (actions.length === 1) return actions[0];
  const names = new Set(blocks.map((b) => b.name));
  const n = blocks.length;
  const only = names.size === 1 ? blocks[0].name : "";
  const counts = new Map<Station, number>();
  for (const a of actions) counts.set(a.station, (counts.get(a.station) ?? 0) + 1);
  const station = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  if (only === "Read") return { station, say: tp(n, "Reading {n} file", "Reading {n} files") };
  if (only === "Grep" || only === "Glob") return { station, say: tp(n, "Running {n} search", "Running {n} searches") };
  if (only === "Edit" || only === "Write" || only === "MultiEdit") return { station, say: tp(n, "Editing {n} file", "Editing {n} files") };
  if (only === "Bash") return { station, say: tp(n, "Running {n} command", "Running {n} commands") };
  if (only === "WebFetch" || only === "WebSearch") return { station, say: tp(n, "Reading {n} web page", "Reading {n} web pages") };
  return { station, say: tp(n - 1, "{say}, and {n} more thing", "{say}, and {n} more things", { say: actions[0].say }) };
}

/** What Claude asks when it waits for your approval. */
function permissionAsk(tool: string, inputText: string): string {
  const input = parseInput(inputText);
  switch (tool) {
    case "Bash":
      return t("Can I run “{cmd}”?", { cmd: short(str(input.command) || inputText, 22) });
    case "Edit":
    case "MultiEdit":
    case "Write":
      return t("Can I edit {name}?", { name: short(base(str(input.file_path)), 22) });
    case "WebFetch":
      return t("Can I open this page?");
    case "AskUserQuestion":
      return t("I have a question for you");
    case "ExitPlanMode":
      return t("My plan is ready, approve it?");
    default:
      return t("Can I use {name}?", { name: tool.startsWith("mcp__") ? tool.split("__")[1] : tool });
  }
}

// ---------------------------------------------------------------- creatures

type Species = "fox" | "cat" | "bunny" | "puppy" | "hedgehog";

/** Sheet in Aseprite format: one 48 px frame per cell, one tag per animation and per side
 *  (Idle_East, Walk_West, Sleep_East, Idle_South…), and the point where the paws touch the ground. */
interface SheetAtlas {
  frames: { frame: { x: number; y: number; w: number; h: number }; duration: number }[];
  meta: { frameTags: { name: string; from: number; to: number }[]; pivot: { x: number; y: number } };
}

/** Free Pets Pack by Frakassets (license: src/assets/critters/LICENSE-Frakassets.txt), cut down to the animations we use. */
const SHEETS: Record<Species, { url: string; atlas: SheetAtlas }> = {
  fox: { url: foxSheetUrl, atlas: foxAtlas as SheetAtlas },
  cat: { url: catSheetUrl, atlas: catAtlas as SheetAtlas },
  bunny: { url: bunnySheetUrl, atlas: bunnyAtlas as SheetAtlas },
  puppy: { url: puppySheetUrl, atlas: puppyAtlas as SheetAtlas },
  hedgehog: { url: hedgehogSheetUrl, atlas: hedgehogAtlas as SheetAtlas },
};

/** Frame of a tag at time t: the loop follows the durations set in Aseprite. */
function frameAt(atlas: SheetAtlas, tag: string, t: number): number {
  const tg = atlas.meta.frameTags.find((x) => x.name === tag);
  if (!tg) return 0;
  let total = 0;
  for (let i = tg.from; i <= tg.to; i++) total += atlas.frames[i].duration;
  let m = t % total;
  for (let i = tg.from; i <= tg.to; i++) {
    if (m < atlas.frames[i].duration) return i;
    m -= atlas.frames[i].duration;
  }
  return tg.to;
}

export function speciesOf(model: string | null | undefined): Species {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus") || m === "best") return "fox";
  if (m.includes("sonnet")) return "cat";
  if (m.includes("haiku")) return "bunny";
  if (m.includes("fable")) return "puppy";
  return "hedgehog";
}

// ---------------------------------------------------------------- world state

interface Critter {
  id: string;
  species: Species;
  x: number;
  station: Station;
  left: boolean;
  /** What the creature is doing right now. */
  status: string;
  /** One-off line, shown instead of the status until `quipUntil`. */
  quip: string;
  quipUntil: number;
  resting: boolean;
  /** Walks to the gate, then disappears. */
  leaving: boolean;
  /** Subagent that has finished: joins the main agent to report, then leaves. */
  reporting: boolean;
  reportedAt: number;
  /** Back to the fire after the closing line. */
  restAt: number;
  sinceMs: number;
  resume?: { station: Station; status: string };
  /** Subagent: its mission, for its report. */
  mission: string;
  /** Animation offset, so two creatures don't breathe in sync. */
  phase: number;
}

interface Scene {
  critters: Map<string, Critter>;
}

interface Deps {
  /** Conversation shown, or null on the start screen. */
  active: () => string | null;
  /** Model of a conversation (or of the draft when sid is null). */
  modelOf: (sid: string | null) => string | null;
}

const MAIN = "main";
const KEY = "bh.world";

/** World shown (yes by default); a choice local to this machine. */
export function worldShown(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let wakeWorld = () => {};
export function setWorldShown(on: boolean) {
  document.documentElement.dataset.world = on ? "on" : "off";
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Without storage, the choice lasts until the app closes.
  }
  wakeWorld();
}

export function initWorld(d: Deps) {
  document.documentElement.dataset.world = worldShown() ? "on" : "off";
  const root = document.getElementById("world")!;
  const canvas = root.querySelector("canvas")!;
  const bubbles = root.querySelector<HTMLElement>(".world-bubbles")!;
  const g = canvas.getContext("2d")!;
  canvas.width = W;
  canvas.height = H;
  g.imageSmoothingEnabled = false;

  const load = (src: string) => {
    const img = new Image();
    img.src = src;
    img.onload = () => wake();
    return img;
  };
  const night = load(nightUrl);
  const day = load(dayUrl);
  const sheets = Object.fromEntries(Object.entries(SHEETS).map(([k, v]) => [k, { img: load(v.url), atlas: v.atlas }])) as Record<Species, { img: HTMLImageElement; atlas: SheetAtlas }>;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  let stations = dark.matches ? NIGHT : DAY;

  const scenes = new Map<string, Scene>();
  /** Start screen: one creature waiting by the fire. */
  const idle: Scene = { critters: new Map() };

  const scene = (sid: string): Scene => {
    let s = scenes.get(sid);
    if (!s) scenes.set(sid, (s = { critters: new Map() }));
    return s;
  };

  function spawn(s: Scene, id: string, species: Species, at: Station): Critter {
    let c = s.critters.get(id);
    if (!c) {
      c = { id, species, x: stations[at], station: at, left: false, status: "", quip: "", quipUntil: 0, resting: at === "fire", leaving: false, reporting: false, reportedAt: 0, restAt: 0, sinceMs: Date.now(), mission: "", phase: Math.floor(Math.random() * 4000) };
      s.critters.set(id, c);
    }
    return c;
  }

  function main(sid: string): Critter {
    const c = spawn(scene(sid), MAIN, speciesOf(d.modelOf(sid)), "fire");
    c.species = speciesOf(d.modelOf(sid));
    return c;
  }

  function go(c: Critter, station: Station, status: string) {
    c.station = station;
    c.status = status;
    c.resting = false;
    c.restAt = 0;
    c.sinceMs = Date.now();
    wake();
  }

  function say(c: Critter, text: string, ms = QUIP_MS) {
    c.quip = text;
    c.quipUntil = Date.now() + ms;
    wake();
  }

  function rest(c: Critter) {
    c.station = "fire";
    c.status = "";
    c.resting = true;
    c.restAt = 0;
    c.sinceMs = Date.now();
    wake();
  }

  /** End of turn: a line on the spot, then back to the fire. */
  function finish(sid: string, text: string) {
    const s = scenes.get(sid);
    if (!s) return;
    for (const c of s.critters.values()) {
      if (c.id === MAIN) {
        if (c.resting) continue;
        c.status = "";
        say(c, text);
        c.restAt = Date.now() + QUIP_MS;
      } else if (!c.reporting) {
        c.leaving = true;
        go(c, "gate", "");
      }
    }
  }

  /** Live event from a conversation (not a history replay). */
  function onEvent(ev: UiEvent) {
    switch (ev.kind) {
      case "assistant": {
        const s = scene(ev.sid);
        const tools = ev.blocks.filter((b): b is ToolBlock => b.t === "tool");
        const isAgent = (b: ToolBlock) => b.name === "Agent" || b.name === "Task";
        if (!ev.parent) {
          // Subagents launched: they come in through the gate, the main agent goes to greet them.
          for (const b of tools.filter(isAgent)) {
            const input = parseInput(b.input);
            const mission = short(str(input.description) || str(input.subagent_type) || t("a mission"), 28);
            const sub = spawn(s, b.id, speciesOf(str(input.model) || d.modelOf(ev.sid)), "gate");
            sub.mission = mission;
            go(sub, "gate", t("Mission: {mission}", { mission }));
            say(sub, t("Here I am!"), 1600);
            go(main(ev.sid), "gate", t("Sending help: {mission}", { mission }));
          }
        }
        const work = (ev.parent ? tools : tools.filter((b) => !isAgent(b))).filter((b) => b.name !== NEXT_STEP_TOOL);
        const c = ev.parent ? s.critters.get(ev.parent) : main(ev.sid);
        if (!c || c.reporting) return;
        if (work.length) {
          const a = batchAction(work);
          go(c, a.station, a.say);
        } else if (!ev.parent && !tools.length && ev.blocks.some((b) => b.t === "text" && b.text.trim())) {
          // Written reply: the mailbox is what talks to you.
          go(c, "mailbox", t("Writing you the answer"));
        }
        return;
      }
      case "delta": {
        // Live text (shown conversation only): it is writing to you.
        const c = scenes.get(ev.sid)?.critters.get(MAIN);
        if (c && !ev.thinking && !c.resting && c.station !== "mailbox") go(c, "mailbox", t("Writing you the answer"));
        return;
      }
      case "toolResult": {
        const s = scenes.get(ev.sid);
        if (!s) return;
        const sub = s.critters.get(ev.toolUseId);
        if (sub && !ev.parent) {
          // The subagent comes back to report to the main agent before leaving.
          sub.reporting = true;
          sub.status = ev.isError ? t("I couldn't do it…") : t("Done: {mission}", { mission: sub.mission });
          sub.resting = false;
          wake();
          return;
        }
        if (ev.isError) {
          const owner = s.critters.get(ev.parent ?? MAIN);
          if (owner) say(owner, t("Oops, that didn't work"), 2000);
        }
        return;
      }
      case "permission": {
        const c = main(ev.sid);
        if (c.station !== "mailbox" || !c.resume) c.resume = { station: c.station, status: c.status };
        go(c, "mailbox", permissionAsk(ev.toolName, ev.input));
        return;
      }
      case "permissionDone": {
        const c = scenes.get(ev.sid)?.critters.get(MAIN);
        if (c?.resume && c.station === "mailbox") {
          go(c, c.resume.station, c.resume.status);
          say(c, t("Thanks!"), 1200);
        }
        if (c) c.resume = undefined;
        return;
      }
      case "result":
        finish(ev.sid, ev.isError ? t("I stopped on an error") : t("All done!"));
        return;
      case "sessionUpdate": {
        const sid = ev.session.sid;
        if (ev.session.state === "busy") {
          const c = main(sid);
          if (c.resting || c.restAt) go(c, "board", t("Thinking…"));
          return;
        }
        if (ev.session.state === "ready" || ev.session.state === "starting") return;
        // Process suspended or stopped: everyone goes home.
        const s = scenes.get(sid);
        for (const c of s?.critters.values() ?? []) {
          if (c.id === MAIN) rest(c);
          else s?.critters.delete(c.id);
        }
        return;
      }
      case "sessionRemoved":
        scenes.delete(ev.sid);
        return;
      case "init":
        main(ev.sid);
        return;
    }
  }

  // ------------------------------------------------------------ rendering

  let timer = 0;
  let last = performance.now();
  const shown = () => document.documentElement.dataset.world === "on" && !document.hidden && root.offsetParent !== null;

  function current(): Scene {
    const sid = d.active();
    if (sid) {
      main(sid);
      return scene(sid);
    }
    const c = spawn(idle, MAIN, speciesOf(d.modelOf(null)), "fire");
    c.species = speciesOf(d.modelOf(null));
    return idle;
  }

  /** Target x: at its station, side by side with the others, or facing the main agent for a report. */
  function targetX(s: Scene, c: Critter): number {
    if (c.reporting && !c.leaving) {
      const boss = s.critters.get(MAIN);
      if (boss) return boss.x + (boss.x > 80 ? -34 : 34);
    }
    const here = [...s.critters.values()].filter((o) => o.station === c.station && !o.reporting && !o.leaving);
    const i = Math.max(0, here.indexOf(c));
    // At the fire, they sit on the log on either side of the flames.
    const spread = c.station === "fire" ? [-34, 34, -58, 58] : [0, -36, 36, -72, 72];
    const x = stations[c.station] + (spread[i] ?? i * 36);
    return Math.min(W - 20, Math.max(20, x));
  }

  function step(dt: number, s: Scene, now: number) {
    for (const c of [...s.critters.values()]) {
      if (c.restAt && now >= c.restAt) rest(c);
      const dx = targetX(s, c) - c.x;
      if (Math.abs(dx) > 1) {
        c.left = dx < 0;
        c.x += Math.sign(dx) * Math.min(Math.abs(dx), SPEED * dt);
        continue;
      }
      if (c.reporting && !c.leaving) {
        // In front of the main agent: it reports, then leaves.
        const boss = s.critters.get(MAIN);
        if (boss) c.left = boss.x < c.x;
        if (!c.reportedAt) c.reportedAt = now;
        else if (now - c.reportedAt > QUIP_MS) {
          c.leaving = true;
          go(c, "gate", "");
          say(c, t("See you!"), 1500);
        }
      } else if (c.leaving && c.station === "gate") {
        s.critters.delete(c.id);
      } else if (c.resting) {
        // At the fire, face the flames.
        c.left = c.x > stations.fire;
      }
    }
  }

  /** One scenery "pixel": 2 × 2 at this resolution. */
  const dot = (x: number, y: number, w = 2, h = 2) => g.fillRect(x, y, w, h);

  function draw(s: Scene, now: number) {
    const bg = dark.matches ? night : day;
    if (bg.complete && bg.naturalWidth) g.drawImage(bg, 0, 0, W, H);
    else {
      g.fillStyle = dark.matches ? "#0b1146" : "#8fc4f0";
      g.fillRect(0, 0, W, H);
    }
    // The fire flickers.
    g.fillStyle = "#ffd36b";
    const f = Math.floor(now / 160) % 3;
    if (f !== 2) dot(stations.fire + (f ? 2 : -4), 64 - f * 4);
    const list = [...s.critters.values()].sort((a, b) => Number(b.resting) - Number(a.resting));
    const html: string[] = [];
    const placed: { level: number; from: number; to: number }[] = [];
    const frameW = root.clientWidth || W;
    for (const c of list) {
      const walking = Math.abs(targetX(s, c) - c.x) > 1;
      const talking = !!c.quip && now < c.quipUntil;
      // Pack animations: walking, sleeping by the fire, happy when talking, facing you while waiting for you.
      const sheet = sheets[c.species];
      const side = c.left ? "West" : "East";
      const tag = walking
        ? `Walk_${side}`
        : c.resting
          ? `Sleep_${side}`
          : talking
            ? `Happy_${side}`
            : c.station === "mailbox"
              ? "Idle_South"
              : `Idle_${side}`;
      const f = sheet.atlas.frames[frameAt(sheet.atlas, tag, now + c.phase)].frame;
      const pivot = sheet.atlas.meta.pivot;
      const x = Math.round(c.x) - pivot.x;
      const y = GROUND - 1 - pivot.y;
      if (sheet.img.complete && sheet.img.naturalWidth) g.drawImage(sheet.img, f.x, f.y, f.w, f.h, x, y, f.w, f.h);
      if (c.resting && !talking && now - c.sinceMs > 3000) {
        // Asleep: a rising "z".
        const z = Math.floor(now / 500) % 3;
        g.fillStyle = dark.matches ? "#f3ead3" : "#2a2135";
        const zx = x + pivot.x + 10 + z * 2;
        const zy = y + 20 - z * 4;
        dot(zx, zy, 6, 2);
        dot(zx + 2, zy + 2);
        dot(zx, zy + 4, 6, 2);
      }
      const text = talking ? c.quip : c.resting ? "" : c.status;
      if (text) {
        // Bubble kept inside the strip; two neighbors stack up.
        const left = (c.x / W) * 100;
        // Near an edge, the bubble anchors to that side so it stays inside the frame.
        const side = left < 25 ? " is-start" : left > 75 ? " is-end" : "";
        // Estimated bubble extent in on-screen pixels; it moves up a level while it overlaps another one.
        const px = (c.x / W) * frameW;
        const width = Math.min(240, text.length * 6.2 + 18);
        const from = side === " is-start" ? px - 18 : side === " is-end" ? px + 18 - width : px - width / 2;
        let stack = 0;
        while (placed.some((p) => p.level === stack && from < p.to + 4 && from + width > p.from - 4)) stack++;
        placed.push({ level: stack, from, to: from + width });
        const top = (((y + 14) / H) * 100).toFixed(2);
        html.push(`<span class="world-bubble${talking ? " is-quip" : ""}${side}" style="left:${left.toFixed(2)}%;top:${top}%;margin-top:${-stack * 24}px">${escape(text)}</span>`);
      }
    }
    const markup = html.join("");
    if (bubbles.dataset.markup !== markup) {
      bubbles.dataset.markup = markup;
      bubbles.innerHTML = markup;
    }
  }

  function frame() {
    timer = 0;
    if (!shown()) return;
    stations = dark.matches ? NIGHT : DAY;
    const t = performance.now();
    const dt = Math.min(0.3, (t - last) / 1000);
    last = t;
    const s = current();
    const now = Date.now();
    step(dt, s, now);
    draw(s, now);
    // Everyone asleep and nothing moving: 4 frames per second is enough (measured: ~6% CPU at 12 fps).
    const calm = [...s.critters.values()].every((c) => c.resting && !(c.quip && now < c.quipUntil) && Math.abs(targetX(s, c) - c.x) <= 1);
    timer = window.setTimeout(frame, calm ? 1000 / CALM_FPS : 1000 / FPS);
  }

  /** Restarts the animation if it was asleep. */
  function wake() {
    if (timer || !shown()) return;
    last = performance.now();
    timer = window.setTimeout(frame, 0);
  }
  wakeWorld = wake;

  document.addEventListener("visibilitychange", wake);
  dark.addEventListener("change", wake);
  new ResizeObserver(wake).observe(root);

  return { onEvent, wake };
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
