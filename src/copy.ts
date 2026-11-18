// "Copy" button for code blocks, tool output, diffs and logs.
// It is added after the Markdown is sanitized: DOMPurify forbids `button` in the model's text.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
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
  // Outside the app (preview in a browser).
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Without a secure context the API is missing: fall back to a selection.
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

export function copyButton(getText: () => string, label = t("Copy"), extraClass = "code-copy"): HTMLButtonElement {
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
    const done = ok ? t("Copied") : t("Couldn't copy");
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
 * Wraps a block with its button. The bar is sticky and has no height: the button stays
 * visible in a long block, and doesn't scroll with a block that overflows horizontally.
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

/** Adds the button to the code blocks of Markdown already rendered and sanitized. */
export function decorateCode(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
    if (!pre.parentElement?.classList.contains("code-block")) withCopy(pre, () => pre.querySelector("code")?.textContent ?? pre.textContent ?? "");
  }
}

/** New element, not in the page yet: same wrapper, without replacing anything. */
export function wrapWithCopy(block: HTMLElement, getText: () => string = () => block.textContent ?? "", label?: string): HTMLElement {
  const holder = document.createElement("div");
  holder.append(block);
  return withCopy(block, getText, label);
}
