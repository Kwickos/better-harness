// Mouvement de l'interface, avec `motion` (la version sans React de Framer Motion).
// Une animation lancée sur un élément reprend depuis son état actuel : tout est interruptible.
// Durées et courbes viennent des jetons de motion.css, choisis selon l'usage (transitions-polish).
import { spring } from "motion";
import { animate } from "motion/mini";

const css = getComputedStyle(document.documentElement);
const token = (name: string, fallback: number) => parseFloat(css.getPropertyValue(name)) || fallback;
const seconds = (name: string, fallback: number) => token(name, fallback) / 1000;

export const DUR = {
  stagger: seconds("--duration-stagger", 40),
  quick: seconds("--duration-quick", 150),
  fast: seconds("--duration-fast", 250),
  medium: seconds("--duration-medium", 350),
  slow: seconds("--duration-slow", 400),
};
export const DIST = { micro: token("--distance-micro", 4), base: token("--distance-base", 8) };
export const SCALE = { medium: token("--scale-medium", 0.97), tiny: token("--scale-tiny", 0.99) };
const SMOOTH: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SPRING = { type: spring, duration: 0.3, bounce: 0 };
/** Au plus 6 × 40 ms : au-delà, le dernier élément paraît en retard. */
const STAGGER_MAX = 6;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

type Style = Partial<Record<"opacity" | "transform" | "filter", string>>;
// Le type d'options de `animate` varie selon les surcharges : on s'en tient à ce qui sert ici.
type Options = { duration?: number; delay?: number; ease?: unknown; type?: unknown; bounce?: number };
type Run = { stop: () => void; settle: (finished: boolean) => void };

const running = new WeakMap<Element, Run>();

/** Lance une animation ; `false` à la fin si une autre l'a remplacée entre-temps. */
function play(node: HTMLElement, keyframes: Record<string, unknown>, options: Options): Promise<boolean> {
  const previous = running.get(node);
  if (previous) {
    previous.stop();
    previous.settle(false);
  }
  return new Promise((settle) => {
    const controls = animate(node, keyframes as never, { ease: SMOOTH, ...options } as never);
    const run: Run = { stop: () => controls.stop(), settle };
    running.set(node, run);
    void controls.then(() => {
      if (running.get(node) !== run) return;
      running.delete(node);
      settle(true);
    });
  });
}

/** Fait entrer un élément depuis `from` ; s'il était en train de sortir, il repart d'où il en est. */
export async function enter(node: HTMLElement, from: Style, options: Options = {}): Promise<boolean> {
  if (reduced()) return true;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(from)) target[key] = key === "opacity" ? 1 : key === "transform" ? "none" : "blur(0px)";
  if (!running.has(node)) Object.assign(node.style, from);
  const done = await play(node, target, { duration: DUR.fast, ...options });
  if (done) for (const key of Object.keys(from)) node.style.removeProperty(key);
  return done;
}

/** Sortie discrète et plus rapide que l'entrée. */
export async function leave(node: HTMLElement, to: Record<string, string | number>, options: Options = {}): Promise<boolean> {
  if (reduced()) return true;
  return play(node, to, { duration: DUR.quick, ...options });
}

/** Liste qui apparaît : décalage de 40 ms par élément, sur les premiers seulement. */
export function staggerIn(nodes: HTMLElement[]) {
  nodes.slice(0, STAGGER_MAX).forEach((node, i) => {
    void enter(node, { opacity: "0", transform: `translateY(${DIST.micro}px)` }, { delay: i * DUR.stagger });
  });
}

/** Élément déjà à sa nouvelle place : il y glisse depuis l'ancienne (ressort sans rebond). */
export function flipY(node: HTMLElement, dy: number) {
  if (reduced() || Math.abs(dy) < 0.5) return;
  void play(node, { transform: [`translateY(${dy}px)`, "none"] }, SPRING).then((done) => {
    if (done) node.style.removeProperty("transform");
  });
}

/** Apparition d'une icône : valeurs exactes de make-interfaces-feel-better. */
export function iconIn(node: HTMLElement | null) {
  if (node) void enter(node, { opacity: "0", transform: "scale(0.25)", filter: "blur(4px)" }, SPRING);
}

/** Bloc qui s'insère dans le flux : la hauteur suit, pour que ce qu'il y a autour glisse au lieu de sauter. */
export async function heightIn(node: HTMLElement) {
  if (reduced()) return;
  const height = node.offsetHeight;
  const margin = parseFloat(getComputedStyle(node).marginBottom);
  node.style.overflow = "hidden";
  const done = await play(node, { height: ["0px", `${height}px`], marginBottom: ["0px", `${margin}px`], opacity: [0, 1] }, { duration: DUR.fast });
  if (done) for (const key of ["height", "margin-bottom", "opacity", "overflow"]) node.style.removeProperty(key);
}

/** Contenu remplacé : la hauteur passe de l'ancienne à la nouvelle au lieu de sauter. */
export async function heightFrom(node: HTMLElement, from: number) {
  if (reduced()) return;
  const to = node.offsetHeight;
  if (Math.abs(from - to) < 1) return;
  node.style.overflow = "hidden";
  const done = await play(node, { height: [`${from}px`, `${to}px`] }, { duration: DUR.fast });
  if (done) for (const key of ["height", "margin-bottom", "opacity", "overflow"]) node.style.removeProperty(key);
}

export async function heightOut(node: HTMLElement) {
  if (reduced()) return;
  node.style.height = `${node.offsetHeight}px`;
  node.style.overflow = "hidden";
  await play(node, { height: "0px", marginBottom: "0px", opacity: 0 }, { duration: DUR.quick });
}

// Rien ne s'anime au chargement : l'app apparaît d'un bloc, le mouvement suit ensuite les actions.
let live = false;
export const motionLive = () => live;
export const goLive = () => {
  live = true;
};

/** Texte qui change sur place. */
/** Entrée d'un texte qui vient d'en remplacer un autre. */
export function textIn(node: HTMLElement) {
  if (motionLive()) void enter(node, { opacity: "0", transform: `translateY(${DIST.micro}px)`, filter: "blur(2px)" }, { duration: DUR.quick, ease: "easeInOut" });
}

export function swapText(node: HTMLElement, text: string) {
  if (node.textContent === text) return;
  node.textContent = text;
  if (text) textIn(node);
}

/** Sortie par classe CSS, pour ce que `animate` n'atteint pas (dialogue et son fond, toast). */
export function animateOut(node: HTMLElement, cls: string, done: () => void) {
  if (reduced()) {
    done();
    return;
  }
  let finished = false;
  const onEnd = (e: Event) => {
    if (e.target === node) end();
  };
  const end = () => {
    if (finished) return;
    finished = true;
    node.removeEventListener("animationend", onEnd);
    node.classList.remove(cls);
    done();
  };
  node.classList.add(cls);
  node.addEventListener("animationend", onEnd);
  window.setTimeout(end, 700);
}
