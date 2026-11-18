// Questions posées par le modèle (`AskUserQuestion`), une à la fois : jamais de défilement dans la carte.
// Le CLI attend une table « texte de la question → réponse », choix multiples séparés par des virgules.
import { icon } from "./icons";
import { DIST, enter, heightFrom, iconIn } from "./motion";
import { el } from "./transcript";

interface Option {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  options: Option[];
  multiSelect?: boolean;
}

function parse(input: string): Question[] | null {
  try {
    const questions = (JSON.parse(input) as { questions?: Question[] }).questions;
    return Array.isArray(questions) && questions.length ? questions : null;
  } catch {
    return null;
  }
}

/** La carte de réponse, ou null si l'entrée n'est pas lisible (la demande générique prend alors le relais). */
export function questionCard(input: string, onAnswer: (answers: Record<string, string>) => void, onSkip: () => void): HTMLElement | null {
  const parsed = parse(input);
  if (!parsed) return null;
  const questions: Question[] = parsed;
  const card = el("div", "perm question");
  const picks = questions.map(() => new Set<string>());
  const others = questions.map(() => "");
  let step = 0;

  const answerOf = (i: number) => {
    const chosen = questions[i].options.map((o) => o.label).filter((label) => picks[i].has(label));
    if (others[i].trim()) chosen.push(others[i].trim());
    return chosen.join(", ");
  };

  function advance() {
    if (!answerOf(step)) return;
    if (step < questions.length - 1) show(step + 1, 1);
    else onAnswer(Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)])));
  }

  function show(index: number, direction: number) {
    const fromHeight = card.isConnected ? card.offsetHeight : 0;
    step = index;
    const q = questions[index];
    const body = el("div", "q-body");

    const head = el("div", "q-head");
    head.append(el("p", "q-text", q.question));
    if (questions.length > 1) head.append(el("span", "q-step", `${index + 1}/${questions.length}`));

    const primary = el("button", "btn btn-primary", index < questions.length - 1 ? "Suivant" : "Répondre");
    primary.type = "button";
    primary.addEventListener("click", advance);
    // Choix unique : un clic sur l'option suffit, le bouton ne sert que pour une réponse écrite.
    const refresh = () => {
      primary.disabled = !answerOf(index);
      primary.hidden = !q.multiSelect && !others[index].trim();
    };

    const buttons = q.options.map((option, n) => {
      const b = el("button", "q-option");
      b.type = "button";
      const mark = el("span", "q-mark");
      const label = el("span", "q-label");
      label.append(el("b", undefined, option.label));
      if (option.description) label.append(el("small", undefined, option.description));
      b.append(mark, label);
      const paint = (animated: boolean) => {
        const on = picks[index].has(option.label);
        b.setAttribute("aria-pressed", String(on));
        if (on) mark.innerHTML = icon("check", 12);
        else mark.textContent = String(n + 1);
        if (on && animated) iconIn(mark);
      };
      paint(false);
      b.addEventListener("click", () => {
        if (q.multiSelect) {
          if (picks[index].has(option.label)) picks[index].delete(option.label);
          else picks[index].add(option.label);
          paint(true);
          refresh();
          return;
        }
        picks[index].clear();
        picks[index].add(option.label);
        others[index] = "";
        advance();
      });
      return { b, paint };
    });

    const other = el("input", "q-other");
    other.type = "text";
    other.placeholder = "Autre réponse";
    other.value = others[index];
    other.spellcheck = false;
    other.setAttribute("aria-label", `Autre réponse : ${q.question}`);
    other.addEventListener("input", () => {
      others[index] = other.value;
      // Choix unique : écrire sa réponse remplace l'option cochée.
      if (!q.multiSelect && other.value.trim() && picks[index].size) {
        picks[index].clear();
        buttons.forEach((x) => x.paint(false));
      }
      refresh();
    });
    other.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        advance();
      }
    });

    const actions = el("div", "q-actions");
    const skip = el("button", "btn btn-ghost", "Ignorer");
    skip.type = "button";
    skip.addEventListener("click", onSkip);
    actions.append(skip);
    if (index > 0) {
      const back = el("button", "btn btn-ghost", "Précédent");
      back.type = "button";
      back.addEventListener("click", () => show(index - 1, -1));
      actions.append(back);
    }
    actions.append(el("span", "spacer"), primary);

    body.append(head, ...buttons.map((x) => x.b), other, actions);
    card.replaceChildren(body);
    refresh();
    if (fromHeight) {
      heightFrom(card, fromHeight);
      void enter(body, { opacity: "0", transform: `translateX(${direction * DIST.base}px)` });
      card.querySelector<HTMLElement>(".q-option")?.focus({ preventScroll: true });
    }
  }

  show(0, 1);

  // Clavier : les chiffres choisissent, les flèches se déplacent.
  card.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const stops = [...card.querySelectorAll<HTMLElement>(".q-option, .q-other")];
      const i = stops.indexOf(target);
      stops[(i + (e.key === "ArrowDown" ? 1 : -1) + stops.length) % stops.length]?.focus();
    } else if (target.tagName !== "INPUT" && /^[1-9]$/.test(e.key)) {
      // Répondre peut rendre le focus au composer : sans ceci, le chiffre s'y écrirait.
      e.preventDefault();
      card.querySelectorAll<HTMLElement>(".q-option")[Number(e.key) - 1]?.click();
    }
  });
  return card;
}
