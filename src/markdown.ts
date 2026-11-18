// Markdown rendering, including live while streaming.
// The text comes from the model and can contain HTML from tool results:
// everything goes through DOMPurify, and the CSP blocks scripts and remote images.
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { decorateCode } from "./copy";

const md = new Marked({ gfm: true, breaks: false, async: false });

const PURIFY = {
  FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
  FORBID_ATTR: ["style"],
};

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.parse(text) as string, PURIFY);
}

/**
 * Live Markdown, at a constant cost per update: finished blocks
 * (paragraph, heading, table, closed code block…) are rendered once
 * and then frozen; only the last block, still being written, is re-rendered.
 * So the cost doesn't depend on the total length of the message.
 */
export class LiveMarkdown {
  private text = "";
  private committed = 0;
  private readonly tail: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    root.replaceChildren();
    this.tail = document.createElement("div");
    this.tail.className = "md-tail";
    root.append(this.tail);
  }

  get length() {
    return this.text.length;
  }

  append(chunk: string) {
    this.text += chunk;
    this.update();
  }

  private update() {
    const rest = this.text.slice(this.committed);
    const tokens = md.lexer(rest);
    // A block is finished as soon as another non-empty block follows it.
    let lastBlock = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].type !== "space") {
        lastBlock = i;
        break;
      }
    }
    const done = lastBlock > 0 ? tokens.slice(0, lastBlock).map((t) => t.raw).join("") : "";
    // Safeguard: only freeze if the tokens cover the source text exactly.
    if (done && rest.startsWith(done)) {
      if (done.trim()) {
        const block = document.createElement("div");
        block.className = "md-block";
        block.innerHTML = renderMarkdown(done);
        decorateCode(block);
        this.root.insertBefore(block, this.tail);
      }
      this.committed += done.length;
    }
    const tailText = this.text.slice(this.committed);
    this.tail.innerHTML = tailText.trim() ? renderMarkdown(closeOpenFence(tailText)) : "";
  }
}

/** A code block still open is rendered as if it were closed (no visual jump). */
function closeOpenFence(text: string): string {
  const fences = text.match(/^ {0,3}(```|~~~)/gm);
  return fences && fences.length % 2 === 1 ? `${text}\n${fences[fences.length - 1].trim()}` : text;
}
