// Interface languages. English is the source language: every string is written in English in the code,
// wrapped in t(), and that English text is the key other languages are looked up by.
// Adding a language = a new file in ./locales mapping English → translation, listed in LOCALES and LANGUAGES.
import { fr } from "./locales/fr";

export type Lang = "en" | "fr";
/** What the user picks in Settings: a language, or "system" (macOS preferred languages, English if none matches). English by default. */
export type LangChoice = Lang | "system";

const LOCALES: Record<Lang, Record<string, string> | null> = { en: null, fr };

/** Choices shown in Settings, each language named in itself. */
export const LANGUAGES: { id: LangChoice; label: string }[] = [
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "system", label: "System" },
];

/**
 * Last choice, cached so the language is known before settings load (no flash of the wrong language).
 * Settings stay the source of truth.
 */
const CACHE = "bh-language";
const cached = () => {
  try {
    return localStorage.getItem(CACHE);
  } catch {
    return null;
  }
};

/** Language the system prefers, among the ones the app speaks. */
export function systemLang(): Lang {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split("-")[0] as Lang;
    if (base in LOCALES) return base;
  }
  return "en";
}

export function resolveLang(choice: string | null | undefined): Lang {
  if (choice === "system") return systemLang();
  return choice && choice in LOCALES ? (choice as Lang) : "en";
}

let current: Lang = resolveLang(cached());

const listeners = new Set<() => void>();

/** Called after the language changes, to redraw what is on screen. */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Applies the choice from settings, live: static HTML is retranslated and listeners redraw the rest. */
export function setLang(choice: string | null | undefined): boolean {
  try {
    localStorage.setItem(CACHE, choice || "en");
  } catch {
    // No storage: the language still applies from settings on each launch.
  }
  const next = resolveLang(choice);
  const changed = next !== current;
  current = next;
  document.documentElement.lang = current;
  if (changed) {
    translateDom();
    for (const fn of listeners) fn();
  }
  return changed;
}

export const lang = () => current;

const fill = (text: string, vars?: Record<string, string | number>) =>
  vars ? text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all)) : text;

/** Translates an English string. `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(LOCALES[current]?.[text] ?? text, vars);
}

/**
 * Plural: `one` and `other` are the English forms, e.g. tp(n, "{n} file", "{n} files").
 * French uses the singular for 0 and 1, English only for 1.
 * When English has a single form ("{n}% left"), the dictionary keys are "{n}% left#one" and "{n}% left#other".
 */
export function tp(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const singular = current === "fr" ? Math.abs(n) < 2 : n === 1;
  const text = singular ? one : other;
  const dict = LOCALES[current];
  const key = one === other ? `${text}#${singular ? "one" : "other"}` : text;
  return fill(dict?.[key] ?? dict?.[text] ?? text, { n, ...vars });
}

/** Numbers in the interface language (1,234.5 / 1 234,5). */
export const fmtNumber = (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(current, opts).format(n);

/** Sizes given in megabytes: "512 MB", "1.5 GB" (Mo/Go in French). */
export function fmtMb(mb: number): string {
  return mb >= 1024 ? t("{n} GB", { n: fmtNumber(mb / 1024, { maximumFractionDigits: 1 }) }) : t("{n} MB", { n: fmtNumber(Math.round(mb)) });
}

/**
 * Translated attributes for an element built once and never redrawn (a button made at startup):
 * the English key is kept on the element, so translateDom() switches it with the language.
 */
export function bindAttrs(node: Element, key: string, attrs: string[] = ["title", "aria-label"]) {
  node.setAttribute("data-i18n-attr", attrs.join(","));
  for (const attr of attrs) {
    node.setAttribute(`data-i18n-${attr}`, key);
    node.setAttribute(attr, t(key));
  }
}

/**
 * Translates the static HTML: an element with `data-i18n` gets its text translated,
 * `data-i18n-attr="title,placeholder"` translates those attributes.
 * The English text is kept the first time (`data-i18n-key`, `data-i18n-<attr>`), so it can switch again.
 */
export function translateDom(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    const key = (node.dataset.i18nKey ??= node.textContent?.trim() ?? "");
    if (key) node.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((node) => {
    for (const attr of node.dataset.i18nAttr!.split(",").map((a) => a.trim())) {
      const stored = `data-i18n-${attr}`;
      if (!node.hasAttribute(stored)) node.setAttribute(stored, node.getAttribute(attr) ?? "");
      const key = node.getAttribute(stored);
      if (key) node.setAttribute(attr, t(key));
    }
  });
}
