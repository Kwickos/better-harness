// Menus flottants : icône, libellé, description, coche à droite, raccourci ;
// navigation au clavier (↑ ↓ Entrée Échap), fermeture au clic extérieur.
import { icon, type IconName } from "./icons";
import { DUR, SCALE, enter, leave } from "./motion";
import { el } from "./transcript";

export type MenuItem = { label: string; detail?: string; title?: string; hint?: string; icon?: IconName; checked?: boolean; danger?: boolean; kbd?: string; run: () => void };
export type MenuEntry =
  | MenuItem
  | { sep: true }
  | { heading: string }
  | { note: string }
  | { custom: HTMLElement };

let current: HTMLElement | null = null;
let anchorEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

export const menuElement = () => current;
export const onMenuChange = (cb: () => void) => listeners.add(cb);
const notify = () => listeners.forEach((cb) => cb());

export function closeMenu() {
  if (!current) return;
  const leaving = current;
  leaving.style.pointerEvents = "none";
  void leave(leaving, { opacity: 0, transform: `scale(${SCALE.tiny})` }).then(() => leaving.remove());
  current = null;
  anchorEl?.setAttribute("aria-expanded", "false");
  anchorEl = null;
  notify();
}

type MenuOpts = { place?: "above" | "below"; align?: "start" | "end"; minWidth?: number };

/** Une ligne de menu : peut aussi servir dans un contenu sur mesure (liste filtrable). */
export function menuItem(e: MenuItem, hasIcons = true): HTMLElement {
  const b = el("button", `menu-item${hasIcons ? "" : " no-icon"}${e.danger ? " is-danger" : ""}`);
  b.type = "button";
  b.setAttribute("role", "menuitem");
  if (e.title) b.title = e.title;
  if (hasIcons) {
    const ic = el("span", "mi-icon");
    if (e.icon) ic.innerHTML = icon(e.icon);
    b.append(ic);
  }
  const text = el("span", "mi-text");
  const label = el("b", undefined, e.label);
  if (e.detail) label.append(el("span", "mi-detail", e.detail));
  text.append(label);
  if (e.hint) text.append(el("small", undefined, e.hint));
  b.append(text);
  const end = el("span", "mi-check");
  if (e.checked) end.innerHTML = icon("check");
  else if (e.kbd) end.append(el("kbd", undefined, e.kbd));
  b.append(end);
  b.addEventListener("click", () => {
    closeMenu();
    e.run();
  });
  return b;
}

export function showMenu(anchor: HTMLElement, entries: MenuEntry[], opts: MenuOpts = {}) {
  if (anchorEl === anchor) return closeMenu();
  closeMenu();
  const place = opts.place ?? "below";
  // Avant toute mesure : une ancre visible seulement pendant que son menu est ouvert doit l'être.
  anchor.setAttribute("aria-expanded", "true");
  const m = el("div", "menu");
  m.style.transformOrigin = `${opts.align === "end" ? "right" : "left"} ${place === "above" ? "bottom" : "top"}`;
  m.setAttribute("role", "menu");
  if (opts.minWidth) m.style.minWidth = `${opts.minWidth}px`;
  const hasIcons = entries.some((e) => "label" in e && e.icon);
  for (const e of entries) {
    if ("sep" in e) m.append(el("div", "menu-sep"));
    else if ("heading" in e) m.append(el("div", "menu-label", e.heading));
    else if ("note" in e) m.append(el("div", "menu-note", e.note));
    else if ("custom" in e) m.append(e.custom);
    else m.append(menuItem(e, hasIcons));
  }
  // Un <dialog> modal est dans la « top layer » : le menu doit y être attaché pour passer devant.
  (anchor.closest("dialog") ?? document.body).append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const left = opts.align === "end" ? r.right - w : r.left;
  m.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  m.style.top = place === "above" ? `${Math.max(8, r.top - m.offsetHeight - 6)}px` : `${Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 8)}px`;
  current = m;
  anchorEl = anchor;
  (m.querySelector("[aria-checked=true], .menu-item") as HTMLElement | null)?.focus({ preventScroll: true });
  void enter(m, { opacity: "0", transform: `scale(${SCALE.medium})` }, { duration: DUR.fast });
  notify();
}

document.addEventListener("pointerdown", (e) => {
  if (current && !current.contains(e.target as Node) && !anchorEl?.contains(e.target as Node)) closeMenu();
});
window.addEventListener("resize", closeMenu);
document.addEventListener("visibilitychange", closeMenu);
document.addEventListener("keydown", (e) => {
  if (!current) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeMenu();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...current.querySelectorAll<HTMLElement>(".menu-item, .menu-seg button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
}, true);

/** Confirmation d'une action qui ne se rattrape pas : « Annuler » a le focus, par sécurité. */
export function confirmMenu(anchor: HTMLElement, title: string, note: string, action: string, run: () => void, opts: MenuOpts = {}) {
  showMenu(anchor, [{ heading: title }, { note }, { label: "Annuler", run: () => {} }, { label: action, danger: true, run }], { minWidth: 260, ...opts });
}

/** Rangée segmentée (ex. niveaux d'effort) à glisser dans un menu. */
export function segmented<T extends string>(options: { id: T; label: string }[], value: T, onPick: (v: T) => void): HTMLElement {
  const row = el("div", "menu-seg");
  // Un seul fond, qui glisse d'une option à l'autre.
  const pill = el("span", "seg-pill no-anim");
  row.append(pill);
  const place = (b: HTMLElement | undefined) => {
    pill.hidden = !b;
    if (!b) return;
    pill.style.width = `${b.offsetWidth}px`;
    pill.style.transform = `translateX(${b.offsetLeft}px)`;
  };
  for (const o of options) {
    const b = el("button", undefined, o.label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(o.id === value));
    b.addEventListener("click", () => {
      row.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      place(b);
      onPick(o.id);
    });
    row.append(b);
  }
  // La rangée n'est mesurable qu'une fois dans le menu : sans transition à cette première pose.
  queueMicrotask(() => {
    place(row.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? undefined);
    requestAnimationFrame(() => pill.classList.remove("no-anim"));
  });
  return row;
}
