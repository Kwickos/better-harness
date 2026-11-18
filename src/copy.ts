// Bouton « Copier » des blocs de code, sorties d'outils, diffs et journaux.
// Il est ajouté après le nettoyage du Markdown : DOMPurify interdit `button` dans le texte du modèle.
import { invoke } from "@tauri-apps/api/core";
import { icon } from "./icons";
import { iconIn } from "./motion";

const DONE_MS = 1500;

async function writeClipboard(text: string): Promise<boolean> {
  if ("__TAURI_INTERNALS__" in window) {
    return invoke("copy_text", { text }).then(
      () => true,
      () => false,
    );
  }
  // Hors de l'app (prévisualisation dans un navigateur).
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Sans contexte sécurisé, l'API est absente : on repasse par une sélection.
    const before = document.activeElement as HTMLElement | null;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    before?.focus({ preventScroll: true });
    return ok;
  }
}

export function copyButton(getText: () => string, label = "Copier", extraClass = "code-copy"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `icon-btn ${extraClass}`;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = icon("copy", 14);
  let timer = 0;
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await writeClipboard(getText());
    const done = ok ? "Copié" : "Copie impossible";
    b.title = done;
    b.setAttribute("aria-label", done);
    b.classList.toggle("is-done", ok);
    b.classList.toggle("is-failed", !ok);
    b.innerHTML = icon(ok ? "check" : "close", 14);
    iconIn(b.querySelector<HTMLElement>("svg"));
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      b.title = label;
      b.setAttribute("aria-label", label);
      b.classList.remove("is-done", "is-failed");
      b.innerHTML = icon("copy", 14);
      iconIn(b.querySelector<HTMLElement>("svg"));
    }, DONE_MS);
  });
  return b;
}

/**
 * Enveloppe un bloc avec son bouton. La barre est collante et sans hauteur : le bouton reste
 * visible dans un long bloc, et ne défile pas avec un bloc qui déborde en largeur.
 */
export function withCopy(block: HTMLElement, getText: () => string = () => block.textContent ?? "", label?: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "code-block";
  const tools = document.createElement("div");
  tools.className = "code-tools";
  tools.append(copyButton(getText, label));
  block.replaceWith(wrap);
  wrap.append(tools, block);
  return wrap;
}

/** Ajoute le bouton aux blocs de code d'un Markdown déjà rendu et nettoyé. */
export function decorateCode(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    if (!pre.parentElement?.classList.contains("code-block")) withCopy(pre, () => pre.querySelector("code")?.textContent ?? pre.textContent ?? "");
  }
}

/** Élément neuf, pas encore dans la page : même enveloppe, sans remplacement. */
export function wrapWithCopy(block: HTMLElement, getText: () => string = () => block.textContent ?? "", label?: string): HTMLElement {
  const holder = document.createElement("div");
  holder.append(block);
  return withCopy(block, getText, label);
}
