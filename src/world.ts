// Monde des agents : chaque Claude de la conversation (le principal et ses sous-agents) est une
// créature qui va au poste de ce qu'elle fait et le dit dans une bulle. Décor : src/assets/world-*.png
// (732 × 88 pixels) ; créatures : src/assets/critters/*.png, tirées du Free Pets Pack de Frakassets
// (CC BY 4.0, https://frakassets.itch.io/free-pets-pack). L'animation ne tourne que si le monde est
// affiché et la fenêtre visible.
import type { Block, UiEvent } from "./api";
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
/** Ligne du sol : les pieds des créatures s'y posent. */
const GROUND = 86;
const FPS = 12;
/** Quand toutes les créatures dorment au feu. */
const CALM_FPS = 4;
/** Pixels par seconde. */
const SPEED = 170;
/** Durée d'une réplique ponctuelle (« C'est fini ! », une erreur…). */
const QUIP_MS = 2600;

// ---------------------------------------------------------------- lieux

type Station = "gate" | "library" | "telescope" | "bench" | "fire" | "terminal" | "antenna" | "board" | "mailbox";

/** Abscisse de chaque poste, mesurée sur chaque décor (celui de jour est un peu décalé). */
const NIGHT: Record<Station, number> = { gate: 48, library: 146, telescope: 236, bench: 324, fire: 424, terminal: 506, antenna: 544, board: 606, mailbox: 694 };
const DAY: Record<Station, number> = { gate: 72, library: 162, telescope: 258, bench: 332, fire: 436, terminal: 522, antenna: 556, board: 628, mailbox: 708 };

// ---------------------------------------------------------------- ce que fait un outil : où, et ce que la créature dit

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

/** Une commande shell, dite comme un humain la décrirait. */
export function bashAction(command: string): Action {
  // On juge la vraie commande, pas le `cd dossier &&` qui la précède.
  const cmd = command.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, "").trim();
  const t = (re: RegExp) => re.test(cmd);
  if (t(/\b(vitest|jest|pytest|mocha|playwright)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bcargo\s+test\b|\bgo\s+test\b/)) return { station: "terminal", say: "Je lance les tests" };
  if (t(/\b(tsc|webpack|esbuild)\b|\bvite\s+build\b|\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\bcargo\s+(build|check)\b|\bmake\b|\bxcodebuild\b/)) return { station: "terminal", say: "Je compile le projet" };
  if (t(/\b(eslint|prettier|clippy|ruff|biome)\b|\b(npm|pnpm)\s+run\s+(lint|format)\b/)) return { station: "terminal", say: "Je vérifie le style du code" };
  if (t(/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b|^pip3?\s+install\b|^cargo\s+add\b|^brew\s+install\b/)) return { station: "terminal", say: "J'installe des dépendances" };
  if (t(/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\btauri\s+dev\b/)) return { station: "terminal", say: "Je démarre le serveur" };
  if (t(/^git\s+commit\b/)) return { station: "board", say: "Je fais un commit" };
  if (t(/^git\s+push\b/)) return { station: "antenna", say: "J'envoie sur le dépôt" };
  if (t(/^git\s+(log|show|blame)\b/)) return { station: "library", say: "Je relis l'historique git" };
  if (t(/^git\s+(status|diff)\b/)) return { station: "bench", say: "Je regarde ce qui a changé" };
  if (t(/^git\b/)) return { station: "terminal", say: `Je lance ${short(cmd, 24)}` };
  if (t(/^gh\b/)) return { station: "antenna", say: "Je parle à GitHub" };
  if (t(/^(cat|head|tail|less|bat|wc)\b|^sed\s+-n\b/)) return { station: "library", say: "Je lis un fichier" };
  if (t(/^(grep|rg|ag|osgrep|fd)\b/)) return { station: "telescope", say: "Je fouille le code" };
  if (t(/^(ls|tree|find|du)\b/)) return { station: "telescope", say: "Je fais le tour des dossiers" };
  if (t(/^(curl|wget|http)\b/)) return { station: "antenna", say: "J'interroge une adresse web" };
  if (t(/^(rm|mv|cp|mkdir|touch|chmod|ln)\b/)) return { station: "bench", say: "Je range des fichiers" };
  if (t(/^(node|python3?|deno|bun|ruby)\b/)) return { station: "terminal", say: "Je lance un script" };
  return { station: "terminal", say: `Je lance ${short(cmd.split(/\s+/).slice(0, 3).join(" "), 26)}` };
}

/** Où va une créature pour un outil, et ce qu'elle annonce. */
export function toolAction(name: string, summary: string, inputText: string): Action {
  const input = parseInput(inputText);
  const file = base(str(input.file_path) || str(input.notebook_path) || summary);
  if (name.startsWith("mcp__")) return { station: "antenna", say: `J'utilise ${name.split("__")[1] || "un serveur"}` };
  switch (name) {
    case "Read":
      return { station: "library", say: `Je lis ${short(file, 26)}` };
    case "Grep":
      return { station: "telescope", say: `Je cherche « ${short(str(input.pattern) || summary, 20)} »` };
    case "Glob":
      return { station: "telescope", say: `Je cherche les fichiers ${short(str(input.pattern) || summary, 20)}` };
    case "LSP":
      return { station: "telescope", say: "J'analyse le code" };
    case "ToolSearch":
      return { station: "telescope", say: "Je cherche le bon outil" };
    case "Edit":
    case "MultiEdit":
      return { station: "bench", say: `Je modifie ${short(file, 24)}` };
    case "Write":
      return { station: "bench", say: `J'écris ${short(file, 26)}` };
    case "NotebookEdit":
      return { station: "bench", say: "Je modifie le notebook" };
    case "Bash":
      return bashAction(str(input.command) || summary || inputText);
    case "BashOutput":
    case "TaskOutput":
    case "Monitor":
      return { station: "terminal", say: "Je surveille une commande" };
    case "KillShell":
    case "TaskStop":
      return { station: "terminal", say: "J'arrête une commande" };
    case "WebSearch":
      return { station: "antenna", say: `Je cherche « ${short(str(input.query) || summary, 20)} » sur le web` };
    case "WebFetch": {
      let host = summary;
      try {
        host = new URL(str(input.url) || summary).host;
      } catch {
        // Adresse illisible : on garde le résumé.
      }
      return { station: "antenna", say: `Je lis ${short(host, 26)}` };
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const now = todos.find((t) => t.status === "in_progress");
      const text = now ? str(now.activeForm) || str(now.content) : "";
      return { station: "board", say: text ? short(text, 34) : "Je mets à jour ma liste" };
    }
    case "TaskCreate":
    case "TaskUpdate":
      return { station: "board", say: "Je mets à jour ma liste" };
    case "EnterPlanMode":
      return { station: "board", say: "Je prépare un plan" };
    case "ExitPlanMode":
      return { station: "mailbox", say: "Mon plan est prêt" };
    case "Skill":
      return { station: "library", say: `Je consulte le skill ${short(str(input.skill) || summary, 18)}` };
    case "AskUserQuestion":
      return { station: "mailbox", say: "J'ai une question pour toi" };
    case "Artifact":
      return { station: "board", say: "Je publie une page" };
    case "SubagentHandback":
      // Outil interne du CLI : le sous-agent rend son rapport au principal.
      return { station: "board", say: "Je rédige mon rapport" };
    default:
      return { station: "terminal", say: `J'utilise ${short(name, 20)}` };
  }
}

type ToolBlock = Extract<Block, { t: "tool" }>;

/** Plusieurs outils lancés d'un coup : un seul poste, une phrase qui les résume. */
function batchAction(blocks: ToolBlock[]): Action {
  const actions = blocks.map((b) => toolAction(b.name, b.summary, b.input));
  if (actions.length === 1) return actions[0];
  const names = new Set(blocks.map((b) => b.name));
  const n = blocks.length;
  const only = names.size === 1 ? blocks[0].name : "";
  const counts = new Map<Station, number>();
  for (const a of actions) counts.set(a.station, (counts.get(a.station) ?? 0) + 1);
  const station = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  if (only === "Read") return { station, say: `Je lis ${n} fichiers` };
  if (only === "Grep" || only === "Glob") return { station, say: `Je lance ${n} recherches` };
  if (only === "Edit" || only === "Write" || only === "MultiEdit") return { station, say: `Je modifie ${n} fichiers` };
  if (only === "Bash") return { station, say: `Je lance ${n} commandes` };
  if (only === "WebFetch" || only === "WebSearch") return { station, say: `Je consulte ${n} pages web` };
  return { station, say: `${actions[0].say}, et ${n - 1} autre${n > 2 ? "s" : ""} chose${n > 2 ? "s" : ""}` };
}

/** Ce que Claude demande quand il attend ton accord. */
function permissionAsk(tool: string, inputText: string): string {
  const input = parseInput(inputText);
  switch (tool) {
    case "Bash":
      return `Je peux lancer « ${short(str(input.command) || inputText, 22)} » ?`;
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `Je peux modifier ${short(base(str(input.file_path)), 22)} ?`;
    case "WebFetch":
      return "Je peux ouvrir cette page ?";
    case "AskUserQuestion":
      return "J'ai une question pour toi";
    case "ExitPlanMode":
      return "Mon plan est prêt, tu valides ?";
    default:
      return `Je peux utiliser ${tool.startsWith("mcp__") ? tool.split("__")[1] : tool} ?`;
  }
}

// ---------------------------------------------------------------- créatures

type Species = "fox" | "cat" | "bunny" | "puppy" | "hedgehog";

/** Planche au format Aseprite : une frame de 48 px par case, une étiquette par animation et par côté
 *  (Idle_East, Walk_West, Sleep_East, Idle_South…), et le point où les pattes touchent le sol. */
interface SheetAtlas {
  frames: { frame: { x: number; y: number; w: number; h: number }; duration: number }[];
  meta: { frameTags: { name: string; from: number; to: number }[]; pivot: { x: number; y: number } };
}

/** Free Pets Pack de Frakassets (licence : src/assets/critters/LICENSE-Frakassets.txt), réduit aux animations utiles. */
const SHEETS: Record<Species, { url: string; atlas: SheetAtlas }> = {
  fox: { url: foxSheetUrl, atlas: foxAtlas as SheetAtlas },
  cat: { url: catSheetUrl, atlas: catAtlas as SheetAtlas },
  bunny: { url: bunnySheetUrl, atlas: bunnyAtlas as SheetAtlas },
  puppy: { url: puppySheetUrl, atlas: puppyAtlas as SheetAtlas },
  hedgehog: { url: hedgehogSheetUrl, atlas: hedgehogAtlas as SheetAtlas },
};

/** Frame d'une étiquette au temps t : la boucle suit les durées réglées dans Aseprite. */
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

// ---------------------------------------------------------------- état du monde

interface Critter {
  id: string;
  species: Species;
  x: number;
  station: Station;
  left: boolean;
  /** Ce que la créature est en train de faire. */
  status: string;
  /** Réplique ponctuelle, affichée à la place du statut jusqu'à `quipUntil`. */
  quip: string;
  quipUntil: number;
  resting: boolean;
  /** Va à la porte puis disparaît. */
  leaving: boolean;
  /** Sous-agent qui a fini : rejoint le principal pour son rapport, puis s'en va. */
  reporting: boolean;
  reportedAt: number;
  /** Retour au feu après la réplique de fin. */
  restAt: number;
  sinceMs: number;
  resume?: { station: Station; status: string };
  /** Sous-agent : sa mission, pour son rapport. */
  mission: string;
  /** Décalage d'animation, pour que deux créatures ne respirent pas en même temps. */
  phase: number;
}

interface Scene {
  critters: Map<string, Critter>;
}

interface Deps {
  /** Conversation affichée, ou null sur l'écran de départ. */
  active: () => string | null;
  /** Modèle d'une conversation (ou du brouillon quand sid est null). */
  modelOf: (sid: string | null) => string | null;
}

const MAIN = "main";
const KEY = "bh.world";

/** Monde affiché (par défaut oui) ; choix propre à cette machine. */
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
    // Sans stockage, le choix tient jusqu'à la fermeture.
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
  /** Écran de départ : une créature qui attend près du feu. */
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

  /** Fin de tour : une réplique sur place, puis retour au feu. */
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

  /** Événement en direct d'une conversation (pas la relecture d'un historique). */
  function onEvent(ev: UiEvent) {
    switch (ev.kind) {
      case "assistant": {
        const s = scene(ev.sid);
        const tools = ev.blocks.filter((b): b is ToolBlock => b.t === "tool");
        const isAgent = (b: ToolBlock) => b.name === "Agent" || b.name === "Task";
        if (!ev.parent) {
          // Sous-agents lancés : ils arrivent par la porte, le principal va les accueillir.
          for (const b of tools.filter(isAgent)) {
            const input = parseInput(b.input);
            const mission = short(str(input.description) || str(input.subagent_type) || "une mission", 28);
            const sub = spawn(s, b.id, speciesOf(str(input.model) || d.modelOf(ev.sid)), "gate");
            sub.mission = mission;
            go(sub, "gate", `Mission : ${mission}`);
            say(sub, "Me voilà !", 1600);
            go(main(ev.sid), "gate", `J'envoie de l'aide : ${mission}`);
          }
        }
        const work = ev.parent ? tools : tools.filter((b) => !isAgent(b));
        const c = ev.parent ? s.critters.get(ev.parent) : main(ev.sid);
        if (!c || c.reporting) return;
        if (work.length) {
          const a = batchAction(work);
          go(c, a.station, a.say);
        } else if (!ev.parent && !tools.length && ev.blocks.some((b) => b.t === "text" && b.text.trim())) {
          // Réponse écrite : la boîte aux lettres, c'est ce qui te parle.
          go(c, "mailbox", "Je t'écris la réponse");
        }
        return;
      }
      case "delta": {
        // Texte en direct (conversation affichée seulement) : il t'écrit.
        const c = scenes.get(ev.sid)?.critters.get(MAIN);
        if (c && !ev.thinking && !c.resting && c.station !== "mailbox") go(c, "mailbox", "Je t'écris la réponse");
        return;
      }
      case "toolResult": {
        const s = scenes.get(ev.sid);
        if (!s) return;
        const sub = s.critters.get(ev.toolUseId);
        if (sub && !ev.parent) {
          // Le sous-agent rentre faire son rapport au principal avant de partir.
          sub.reporting = true;
          sub.status = ev.isError ? "Je n'ai pas réussi…" : `C'est fait : ${sub.mission}`;
          sub.resting = false;
          wake();
          return;
        }
        if (ev.isError) {
          const owner = s.critters.get(ev.parent ?? MAIN);
          if (owner) say(owner, "Aïe, ça n'a pas marché", 2000);
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
          say(c, "Merci !", 1200);
        }
        if (c) c.resume = undefined;
        return;
      }
      case "result":
        finish(ev.sid, ev.isError ? "Je me suis arrêté sur une erreur" : "C'est fini !");
        return;
      case "sessionUpdate": {
        const sid = ev.session.sid;
        if (ev.session.state === "busy") {
          const c = main(sid);
          if (c.resting || c.restAt) go(c, "board", "Je réfléchis…");
          return;
        }
        if (ev.session.state === "ready" || ev.session.state === "starting") return;
        // Processus suspendu ou arrêté : tout le monde rentre.
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

  // ------------------------------------------------------------ rendu

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

  /** Abscisse visée : à son poste, côte à côte avec les autres, ou face au principal pour un rapport. */
  function targetX(s: Scene, c: Critter): number {
    if (c.reporting && !c.leaving) {
      const boss = s.critters.get(MAIN);
      if (boss) return boss.x + (boss.x > 80 ? -34 : 34);
    }
    const here = [...s.critters.values()].filter((o) => o.station === c.station && !o.reporting && !o.leaving);
    const i = Math.max(0, here.indexOf(c));
    // Au feu, on s'assoit sur la bûche de part et d'autre des flammes.
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
        // Arrivé devant le principal : il fait son rapport, puis s'en va.
        const boss = s.critters.get(MAIN);
        if (boss) c.left = boss.x < c.x;
        if (!c.reportedAt) c.reportedAt = now;
        else if (now - c.reportedAt > QUIP_MS) {
          c.leaving = true;
          go(c, "gate", "");
          say(c, "À plus !", 1500);
        }
      } else if (c.leaving && c.station === "gate") {
        s.critters.delete(c.id);
      } else if (c.resting) {
        // Au feu, on regarde les flammes.
        c.left = c.x > stations.fire;
      }
    }
  }

  /** Un « pixel » du décor : 2 × 2 à cette résolution. */
  const dot = (x: number, y: number, w = 2, h = 2) => g.fillRect(x, y, w, h);

  function draw(s: Scene, now: number) {
    const bg = dark.matches ? night : day;
    if (bg.complete && bg.naturalWidth) g.drawImage(bg, 0, 0, W, H);
    else {
      g.fillStyle = dark.matches ? "#0b1146" : "#8fc4f0";
      g.fillRect(0, 0, W, H);
    }
    // Le feu vacille.
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
      // Animations du pack : marche, sommeil au feu, joie quand elle parle, de face quand elle t'attend.
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
        // Endormi : un « z » qui monte.
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
        // Bulle gardée dans la bande ; deux voisines s'empilent.
        const left = (c.x / W) * 100;
        // Près d'un bord, la bulle s'ancre de ce côté pour ne pas sortir du cadre.
        const side = left < 25 ? " is-start" : left > 75 ? " is-end" : "";
        // Étendue estimée de la bulle en pixels affichés ; elle monte d'un cran tant qu'elle en chevauche une autre.
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
    // Tout le monde dort et rien ne bouge : 4 images par seconde suffisent (mesuré : ~6 % de CPU à 12 i/s).
    const calm = [...s.critters.values()].every((c) => c.resting && !(c.quip && now < c.quipUntil) && Math.abs(targetX(s, c) - c.x) <= 1);
    timer = window.setTimeout(frame, calm ? 1000 / CALM_FPS : 1000 / FPS);
  }

  /** Relance l'animation si elle dormait. */
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
