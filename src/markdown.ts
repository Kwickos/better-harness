// Rendu Markdown, y compris en direct pendant le streaming.
// Le texte vient du modèle et peut contenir du HTML issu de résultats d'outils :
// tout passe par DOMPurify, et la CSP bloque scripts et images distantes.
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
 * Markdown en direct, à coût constant par mise à jour : les blocs terminés
 * (paragraphe, titre, tableau, bloc de code fermé…) sont rendus une seule fois
 * puis figés ; seul le dernier bloc, encore en cours d'écriture, est re-rendu.
 * Le coût ne dépend donc pas de la longueur totale du message.
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
    // Un bloc est terminé dès qu'un autre bloc non vide le suit.
    let lastBlock = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].type !== "space") {
        lastBlock = i;
        break;
      }
    }
    const done = lastBlock > 0 ? tokens.slice(0, lastBlock).map((t) => t.raw).join("") : "";
    // Garde-fou : on ne fige que si les tokens recouvrent exactement le texte source.
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

/** Un bloc de code encore ouvert est rendu comme s'il était fermé (pas de saut visuel). */
function closeOpenFence(text: string): string {
  const fences = text.match(/^ {0,3}(```|~~~)/gm);
  return fences && fences.length % 2 === 1 ? `${text}\n${fences[fences.length - 1].trim()}` : text;
}
