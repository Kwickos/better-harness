#!/usr/bin/env node
// Garde-fou des sessions Claude (hook PreToolUse sur Bash, branché dans .claude/settings.json).
// Les hooks git et GitHub font respecter les règles ; ce hook empêche une session de les contourner :
// --no-verify, hooks débranchés, push sur main ou de tags, merge autre que squash, release à la main,
// écriture directe dans les protections via l'API. Code de sortie 2 = commande refusée, raison sur stderr.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EMAIL, MAIN, OWNER, dossierHooks, verifierTitre } from "../../scripts/regles.mjs";

const RELEASE = "les tags et les releases ne se créent que par npm run release (voir CONTRIBUTING.md)";

/** Découpe une ligne de shell en commandes (séparateurs ; && || | & et sous-shells), chacune en mots. */
export function commandes(ligne) {
  const sorties = [];
  let mots = [];
  let mot = null;
  let quote = null;
  const finMot = () => {
    if (mot !== null) mots.push(mot);
    mot = null;
  };
  const finCommande = () => {
    finMot();
    if (mots.length) sorties.push(mots);
    mots = [];
  };
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < ligne.length) mot += ligne[++i];
      else mot += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      mot ??= "";
    } else if (c === "\\" && i + 1 < ligne.length) {
      mot = (mot ?? "") + ligne[++i];
    } else if (/\s/.test(c)) {
      if (c === "\n") finCommande();
      else finMot();
    } else if (";&|()`{}".includes(c) || (c === "$" && ligne[i + 1] === "(")) {
      finCommande();
      if (c === "$") i++;
    } else mot = (mot ?? "") + c;
  }
  finCommande();
  return sorties;
}

const ENVELOPPES = new Set(["rtk", "proxy", "command", "env", "sudo", "time", "nohup", "exec", "builtin"]);
const OPTIONS_GIT_A_VALEUR = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

const brancheDe = (cwd) => {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

function analyserGit(args, cwd, env, ctx) {
  const configs = [...env.filter((e) => /^GIT_CONFIG/i.test(e))];
  let i = 0;
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const [option, valeur] = args[i].split(/=(.*)/s);
    if (OPTIONS_GIT_A_VALEUR.has(option)) {
      const v = valeur ?? args[++i] ?? "";
      if (option === "-C") cwd = resolve(cwd, v);
      if (option === "-c" || option === "--config-env") configs.push(v);
    }
  }
  if (configs.some((c) => /hookspath/i.test(c))) return "les hooks git du dépôt ne se débranchent pas.";
  const [sous, ...reste] = args.slice(i);
  if (!sous) return null;
  const options = reste.filter((a) => a.startsWith("-"));
  const positionnels = reste.filter((a) => !a.startsWith("-"));
  if (reste.includes("--no-verify")) return "--no-verify est interdit : corrige ce que le hook signale.";

  if (sous === "config") {
    // git config [get|set|unset|…] <clé> [valeur], ou les anciennes options --unset, --add…
    const pos = [...positionnels];
    const action = ["get", "set", "unset", "list", "edit", "rename-section", "remove-section"].includes(pos[0]) ? pos.shift() : null;
    const cle = pos[0]?.toLowerCase();
    const modifie = action === "set" || action === "unset" || (!action && pos.length >= 2) || options.some((o) => /^(--(unset|unset-all|replace-all|add|remove-section|rename-section|edit)|-e)$/.test(o));
    if (modifie && reste.some((a) => /hookspath/i.test(a))) {
      const installe = cle === "core.hookspath" && pos[1] === ".githooks" && action !== "unset" && !options.some((o) => /unset|add|replace/.test(o));
      if (!installe) return "core.hooksPath reste sur .githooks.";
    }
    const valeur = pos[1];
    if (modifie && ((cle === "user.name" && valeur !== OWNER) || (cle === "user.email" && valeur !== EMAIL))) return `les commits de ce dépôt sont signés ${OWNER} <${EMAIL}>.`;
    return null;
  }

  if (sous === "commit" || sous === "push" || sous === "merge" || sous === "rebase") {
    if (!ctx.hooks(cwd)) return "les hooks git ne sont pas actifs : lance node scripts/regles.mjs installer.";
  }

  if (sous === "commit") {
    // -n dans un groupe d'options courtes (avant une option qui prend une valeur) = --no-verify.
    for (let k = 0; k < reste.length; k++) {
      const a = reste[k];
      if (a === "--") break;
      if (/^-[mFCcSt]$/.test(a) || /^--(message|file|reuse-message|reedit-message|author|date|template|fixup|squash|trailer)$/.test(a)) k++;
      else if (/^-[a-zA-Z]+$/.test(a) && /^[^mFCcSt]*n/.test(a.slice(1))) return "git commit -n (--no-verify) est interdit.";
    }
    if (ctx.branche(cwd) === MAIN) return `pas de commit sur ${MAIN} : crée une branche (git switch -c feat/<sujet>).`;
    return null;
  }

  if (sous === "push") {
    if (options.some((o) => ["--mirror", "--all", "--branches", "--tags", "--follow-tags", "--prune"].includes(o))) return `git push ${options.join(" ")} : pousse une branche à la fois. ${RELEASE}.`;
    const supprime = options.some((o) => o === "--delete" || o === "-d");
    const branche = ctx.branche(cwd);
    const refs = positionnels.slice(1);
    if (!refs.length && branche === MAIN) return `${MAIN} ne reçoit que des PR mergées en squash.`;
    for (const ref of refs) {
      const cible = (ref.includes(":") ? ref.split(":")[1] || ref.split(":")[0] : ref).replace(/^\+/, "");
      const nom = cible === "HEAD" ? branche : cible.replace(/^refs\/heads\//, "");
      if (nom === MAIN) return `${MAIN} ne reçoit que des PR mergées en squash.`;
      if (cible.startsWith("refs/tags/") || /^v\d/.test(cible)) return `${RELEASE}.`;
      if (supprime && /^v\d/.test(nom)) return `${RELEASE}.`;
    }
    return null;
  }

  if (sous === "tag") {
    const lecture = ["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify"];
    const ecrit = options.some((o) => ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-f", "--force", "-m", "-F", "-u", "--local-user"].includes(o));
    if (ecrit || (positionnels.length && !options.some((o) => lecture.includes(o.split("=")[0]) || /^-n\d*$/.test(o) || o.startsWith("--sort") || o.startsWith("--format")))) return `${RELEASE}.`;
    return null;
  }

  if (sous === "update-ref" && positionnels.some((p) => p === `refs/heads/${MAIN}` || p.startsWith("refs/tags/"))) return `refs/heads/${MAIN} et les tags ne se modifient pas à la main.`;
  return null;
}

function analyserGh(args) {
  const [groupe, action, ...reste] = args;
  const a = [action, ...reste].filter(Boolean);
  const valeur = (...noms) => {
    for (let k = 0; k < a.length; k++) {
      const [o, v] = a[k].split(/=(.*)/s);
      if (noms.includes(o)) return v ?? a[k + 1];
    }
    return undefined;
  };
  if (groupe === "pr" && action === "merge") {
    if (reste.includes("--admin")) return "gh pr merge --admin est interdit : aucune exception aux règles de main.";
    if (reste.some((o) => ["--merge", "-m", "--rebase", "-r"].includes(o))) return "main se merge en squash uniquement (gh pr merge --squash).";
    if (!reste.some((o) => o === "--squash" || o === "-s")) return "précise --squash : main se merge en squash uniquement.";
    return null;
  }
  if (groupe === "pr" && (action === "create" || action === "edit")) {
    const titre = valeur("--title", "-t");
    const raison = titre !== undefined && verifierTitre(titre);
    if (raison) return raison;
    const base = valeur("--base", "-B");
    if (base && base !== MAIN) return `une PR vise ${MAIN}.`;
    return null;
  }
  if (groupe === "release" && !["list", "view", "download", "verify", "verify-asset"].includes(action)) return `gh release ${action} : ${RELEASE}.`;
  if (groupe === "repo" && ["edit", "delete", "rename", "archive", "unarchive", "sync"].includes(action)) return `gh repo ${action} : les réglages du dépôt vivent dans scripts/protections.mjs (npm run protections).`;
  if (groupe === "workflow" && action === "disable") return "les workflows de contrôle restent actifs.";
  if (groupe === "api") {
    const A_VALEUR = /^(-X|-H|-f|-F|-q|-t|-p|--method|--header|--field|--raw-field|--jq|--template|--preview|--input|--hostname|--cache)$/;
    let chemin = "";
    for (let k = 0; k < a.length; k++) {
      if (A_VALEUR.test(a[k])) k++;
      else if (!a[k].startsWith("-")) {
        chemin = a[k];
        break;
      }
    }
    const methode = (valeur("-X", "--method") ?? (a.some((x) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x)) ? "POST" : "GET")).toUpperCase();
    if (chemin === "graphql") {
      const requete = a.join(" ");
      if (/mutation/i.test(requete) && /(mergePullRequest|enablePullRequestAutoMerge|createRef|updateRefs?|deleteRef|createRelease|updateRelease|deleteRelease|updateRepository|Ruleset|BranchProtection|createCommitOnBranch)/i.test(requete)) {
        return "cette mutation GraphQL contourne le flux PR/release.";
      }
      return null;
    }
    const sensible = /(rulesets|protection|immutable-releases|git\/refs|git\/tags|releases|merges|pulls\/\d+\/merge|actions\/permissions|actions\/workflows\/[^/]+\/disable|contents\/|^\/?repos\/[^/]+\/[^/]+\/?$)/;
    if (methode !== "GET" && sensible.test(chemin)) return `gh api ${methode} ${chemin} : modifie le dépôt hors du flux PR/release (protections : npm run protections).`;
  }
  return null;
}

const DESTRUCTEURS = new Set(["rm", "mv", "chmod", "chflags", "ln", "unlink", "truncate"]);

/**
 * Raison du refus de la commande Bash, ou null si elle passe.
 * `ctx` remplace l'état réel du dépôt dans les tests (hooks actifs, branche courante).
 */
export function analyser(ligne, cwd = process.cwd(), ctx = {}) {
  ctx = { hooks: (dir) => !!dossierHooks(dir), branche: brancheDe, ...ctx };
  for (const mots of commandes(ligne)) {
    const env = [];
    let k = 0;
    while (k < mots.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(mots[k]) || ENVELOPPES.has(mots[k]) || mots[k] === "export")) {
      if (/=/.test(mots[k])) env.push(mots[k]);
      k++;
    }
    if (env.some((e) => /hookspath/i.test(e))) return "les hooks git du dépôt ne se débranchent pas.";
    const [cmd, ...args] = mots.slice(k);
    if (!cmd) continue;
    const nom = cmd.split("/").pop();
    if (nom === "cd" && args[0]) cwd = resolve(cwd, args[0].replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (DESTRUCTEURS.has(nom) && args.some((x) => /(^|\/)\.githooks(\/|$)|\.git\/hooks|\.claude\/hooks/.test(x))) return "les hooks du dépôt ne se suppriment pas : modifie-les dans une PR.";
    const raison = nom === "git" ? analyserGit(args, cwd, env, ctx) : nom === "gh" ? analyserGh(args) : null;
    if (raison) return raison;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let entree;
  try {
    entree = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const commande = entree?.tool_input?.command;
  if (typeof commande !== "string") process.exit(0);
  const raison = analyser(commande, entree.cwd || process.cwd());
  if (raison) {
    console.error(`Règle du dépôt : ${raison}`);
    process.exit(2);
  }
}
