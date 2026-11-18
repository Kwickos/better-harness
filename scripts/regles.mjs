#!/usr/bin/env node
// Règles du dépôt : une seule source pour les hooks git, la CI, le garde-fou des sessions Claude et la release.
// Le résumé lisible est dans CONTRIBUTING.md.
//
//   node scripts/regles.mjs branche <nom>        nom de branche valide ?
//   node scripts/regles.mjs titre "<titre>"      titre de PR valide ?
//   node scripts/regles.mjs pre-commit           (hook git)
//   node scripts/regles.mjs commit-msg <fichier> (hook git)
//   node scripts/regles.mjs pre-push <remote> <url> < lignes   (hook git)
//   node scripts/regles.mjs ci                   contrôles d'une PR (GitHub Actions)
//   node scripts/regles.mjs installer            active les hooks git (npm install le fait)

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER = "Kwickos";
export const EMAIL = "Kwickos@users.noreply.github.com";
export const REPO = `${OWNER}/better-harness`;
export const MAIN = "main";

/** Types acceptés en tête des titres de PR, donc des commits de main. */
export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert", "release"];
/** Préfixe des branches créées par les sessions de l'app Claude (réglage « Branch prefix »). */
export const PREFIXE_CLAUDE = "features";
/** Préfixes de branche : les types (sauf release, réservé au script) et celui des sessions Claude. */
export const PREFIXES = [...TYPES.filter((t) => t !== "release"), PREFIXE_CLAUDE];

/** Version stable `x.y.z` ou bêta `x.y.z-beta.N`. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const SUJET = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TITRE = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?(!)?: (\\S.*)$`, "u");
const CO_AUTEUR = /^co-authored-by:/im;
/** Identités GitHub de Kwickos (l'adresse avec identifiant sert aux merges faits sur github.com). */
const EMAIL_GITHUB = new RegExp(`^(\\d+\\+)?${OWNER}@users\\.noreply\\.github\\.com$`, "i");
const COMMITTER_GITHUB = "GitHub <noreply@github.com>";
const ZERO = "0".repeat(40);

/** Remote officiel : https (éventuellement avec l'utilisateur) ou ssh, sur github.com exactement. */
export function depotOfficiel(url) {
  return new RegExp(`^(https://([^@/]+@)?github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${REPO}(\\.git)?/?$`).test(url ?? "");
}

export const FICHIERS_VERSION = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"];

// ------------------------------------------------------------ conventions

/** Renvoie la raison du refus, ou null si le nom de branche est valide. */
export function verifierBranche(nom) {
  if (nom === MAIN) return `${MAIN} ne reçoit que des PR mergées en squash, jamais de push direct.`;
  const [prefixe, ...reste] = nom.split("/");
  const sujet = reste.join("/");
  if (prefixe === "release") {
    return /^v/.test(sujet) && VERSION.test(sujet.slice(1)) ? null : `une branche de release s'appelle release/v<x.y.z> ou release/v<x.y.z-beta.N> (pas « ${nom} »).`;
  }
  if (!PREFIXES.includes(prefixe) || !reste.length) return `« ${nom} » : une branche s'appelle <type>/<sujet>, type parmi ${PREFIXES.join(", ")}.`;
  if (!SUJET.test(sujet)) return `« ${nom} » : le sujet s'écrit en minuscules, chiffres et tirets (ex. ${prefixe}/canal-beta).`;
  if (nom.length > 60) return `« ${nom} » : 60 caractères au maximum.`;
  return null;
}

/** Renvoie la raison du refus, ou null si le titre de PR (futur commit de main) est valide. */
export function verifierTitre(titre) {
  const m = TITRE.exec(titre ?? "");
  if (!m) return `titre « ${titre} » : il s'écrit <type>: <description> (ou <type>(zone): …), type parmi ${TYPES.join(", ")}.`;
  if (titre.length > 72) return `titre de ${titre.length} caractères : 72 au maximum.`;
  if (/[.\s]$/.test(titre)) return "le titre ne finit ni par un point ni par une espace.";
  if (m[1] === "release" && !(m[4].startsWith("v") && VERSION.test(m[4].slice(1)) && !m[2] && !m[3])) return "un titre de release s'écrit exactement « release: v<version> ».";
  return null;
}

/** Compare deux versions (bêta < stable du même numéro). Négatif si a < b. */
export function comparer(a, b) {
  const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
  if (!x || !y) throw new Error(`version invalide : ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  const beta = (m) => (m[4] ? Number(m[4]) : Infinity);
  return beta(x) === beta(y) ? 0 : beta(x) < beta(y) ? -1 : 1;
}

/** Version écrite dans chaque fichier ; `lire(fichier)` renvoie son contenu. */
export function versions(lire = (f) => readFileSync(f, "utf8")) {
  const lock = JSON.parse(lire("package-lock.json"));
  return {
    "package.json": JSON.parse(lire("package.json")).version,
    "package-lock.json": lock.version === lock.packages?.[""]?.version ? lock.version : `${lock.version} / ${lock.packages?.[""]?.version}`,
    "src-tauri/Cargo.toml": /^version = "([^"]+)"/m.exec(lire("src-tauri/Cargo.toml"))?.[1],
    "src-tauri/Cargo.lock": /name = "better-harness"\nversion = "([^"]+)"/.exec(lire("src-tauri/Cargo.lock"))?.[1],
    "src-tauri/tauri.conf.json": JSON.parse(lire("src-tauri/tauri.conf.json")).version,
  };
}

/** Version unique du dépôt, ou une erreur si les fichiers ne sont pas d'accord. */
export function versionUnique(lire) {
  const v = versions(lire);
  const uniques = [...new Set(Object.values(v))];
  if (uniques.length !== 1 || !VERSION.test(uniques[0] ?? "")) {
    throw new Error(`les fichiers de version ne sont pas d'accord : ${Object.entries(v).map(([f, x]) => `${f}=${x}`).join(", ")}`);
  }
  return uniques[0];
}

// ------------------------------------------------------------ git

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (...args) => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};
const lireA = (rev) => (f) => git("show", `${rev}:${f}`);

/**
 * Problèmes d'identité des commits de `revs` (arguments de git log).
 * Strict (push local) : auteur et committer exactement Kwickos.
 * Sinon (CI) : on accepte aussi l'adresse noreply avec identifiant et GitHub comme committer (merges faits sur github.com).
 */
export function verifierCommits(revs, { strict }) {
  const sortie = git("log", "--format=%h%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", ...revs);
  const problemes = [];
  for (const bloc of sortie.split("\x1e")) {
    if (!bloc.trim()) continue;
    const [h, an, ae, cn, ce, corps] = bloc.trim().split("\x1f");
    const auteur = `${an} <${ae}>`;
    const committer = `${cn} <${ce}>`;
    const kwickos = (nom, email) => nom === OWNER && (strict ? email === EMAIL : EMAIL_GITHUB.test(email));
    if (!kwickos(an, ae)) problemes.push(`${h} : auteur ${auteur}, attendu ${OWNER} <${EMAIL}>`);
    if (!kwickos(cn, ce) && (strict || committer !== COMMITTER_GITHUB)) problemes.push(`${h} : committer ${committer}, attendu ${OWNER} <${EMAIL}>`);
    if (CO_AUTEUR.test(corps ?? "")) problemes.push(`${h} : trailer Co-authored-by interdit (${OWNER} est le seul auteur)`);
  }
  return problemes;
}

const brancheCourante = () => git("branch", "--show-current");

/** Dossier des hooks actif : le .githooks de ce checkout avec ses trois hooks exécutables, sinon null. */
export function dossierHooks(cwd = ".") {
  try {
    const lire = (...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const top = lire("rev-parse", "--show-toplevel");
    const dossier = join(top, ".githooks");
    if (resolve(top, lire("config", "--get", "core.hooksPath")) !== dossier) return null;
    for (const h of ["pre-commit", "commit-msg", "pre-push"]) accessSync(join(dossier, h), constants.X_OK);
    return dossier;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ hooks git

function preCommit() {
  const branche = brancheCourante();
  if (branche === MAIN) return [`pas de commit sur ${MAIN} : crée une branche (git switch -c feat/<sujet>).`];
  const nom = git("config", "user.name");
  const email = git("config", "user.email");
  if (nom !== OWNER || email !== EMAIL) return [`git signe en « ${nom} <${email}> », attendu ${OWNER} <${EMAIL}> (git config user.name/user.email).`];
  return [];
}

function commitMsg(fichier) {
  const message = readFileSync(fichier, "utf8").replace(/^#.*$/gm, "");
  return CO_AUTEUR.test(message) ? [`trailer Co-authored-by interdit : ${OWNER} est le seul auteur.`] : [];
}

function prePush(url, lignes) {
  if (!depotOfficiel(url)) return [`${url} n'est pas ${REPO}.`];
  try {
    const login = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (login && login !== OWNER) return [`gh est connecté en « ${login} » (gh auth switch -u ${OWNER}).`];
  } catch {
    // gh absent ou hors ligne : le serveur vérifie de toute façon.
  }
  const problemes = [];
  for (const ligne of lignes) {
    const [, localSha, ref, remoteSha] = ligne.trim().split(/\s+/);
    if (!ref) continue;
    const suppression = localSha === ZERO;
    if (ref.startsWith("refs/heads/")) {
      const nom = ref.slice("refs/heads/".length);
      if (nom === MAIN) {
        problemes.push(`${MAIN} ne reçoit que des PR mergées en squash : pousse une branche et ouvre une PR.`);
        continue;
      }
      if (suppression) continue;
      const raison = verifierBranche(nom);
      if (raison) problemes.push(raison);
    } else if (ref.startsWith("refs/tags/")) {
      const tag = ref.slice("refs/tags/".length);
      if (suppression || remoteSha !== ZERO) {
        problemes.push(`le tag ${tag} est publié : il ne se déplace ni ne se supprime.`);
        continue;
      }
      if (!/^v/.test(tag) || !VERSION.test(tag.slice(1))) {
        problemes.push(`tag « ${tag} » : seuls les tags v<version> existent, créés par npm run release.`);
        continue;
      }
      const commit = git("rev-parse", `${localSha}^{commit}`);
      if (!gitOk("merge-base", "--is-ancestor", commit, `refs/remotes/origin/${MAIN}`)) problemes.push(`le tag ${tag} ne pointe pas sur un commit de origin/${MAIN}.`);
      else {
        try {
          const v = versionUnique(lireA(commit));
          if (`v${v}` !== tag) problemes.push(`le tag ${tag} pointe sur un commit en version ${v}.`);
        } catch (e) {
          problemes.push(`tag ${tag} : ${e.message}`);
        }
      }
    } else {
      problemes.push(`${ref} : seules les branches et les tags de version se poussent.`);
    }
    if (suppression) continue;
    const revs = remoteSha === ZERO ? [localSha, "--not", "--remotes=origin"] : [`${remoteSha}..${localSha}`];
    problemes.push(...verifierCommits(revs, { strict: true }));
  }
  return problemes;
}

// ------------------------------------------------------------ CI (GitHub Actions, événement pull_request)

function ci(env = process.env) {
  const { HEAD_REF: branche, PR_TITLE: titre, BASE_REF = MAIN, HEAD_SHA = "HEAD" } = env;
  const base = `origin/${BASE_REF}`;
  const problemes = [];
  if (BASE_REF !== MAIN) problemes.push(`une PR vise ${MAIN} (pas ${BASE_REF}).`);
  const raisonBranche = verifierBranche(branche ?? "");
  if (raisonBranche) problemes.push(`branche : ${raisonBranche}`);
  const raisonTitre = verifierTitre(titre);
  if (raisonTitre) problemes.push(raisonTitre);

  const release = /^release\/v(.+)$/.exec(branche ?? "")?.[1];
  if (release && titre !== `release: v${release}`) problemes.push(`une PR de release s'intitule « release: v${release} ».`);
  if (!release && /^release:/.test(titre ?? "")) problemes.push("un titre release: est réservé aux branches release/v<version> créées par npm run release.");

  problemes.push(...verifierCommits([HEAD_SHA, "--not", base], { strict: false }));

  try {
    const avant = versionUnique(lireA(base));
    const apres = versionUnique(lireA(HEAD_SHA));
    if (release) {
      if (apres !== release) problemes.push(`la branche release/v${release} doit porter la version ${release} (elle porte ${apres}).`);
      else if (comparer(apres, avant) <= 0) problemes.push(`${apres} n'est pas plus récente que ${avant}.`);
      const touches = git("diff", "--name-only", `${base}...${HEAD_SHA}`).split("\n").filter(Boolean);
      const autres = touches.filter((f) => !FICHIERS_VERSION.includes(f));
      if (autres.length) problemes.push(`une PR de release ne change que la version (ici aussi : ${autres.join(", ")}).`);
    } else if (apres !== avant) {
      problemes.push(`la version passe de ${avant} à ${apres} : seul npm run release la change.`);
    }
  } catch (e) {
    problemes.push(e.message);
  }
  return problemes;
}

// ------------------------------------------------------------ installation des hooks

function installer() {
  if (!gitOk("rev-parse", "--git-dir")) return [];
  if (dossierHooks()) return [];
  // Les worktrees des sessions Claude ont leur propre réglage (config.worktree), qui l'emporte sur celui du dépôt.
  const worktree = gitOk("config", "--get", "extensions.worktreeConfig") && git("config", "--get", "extensions.worktreeConfig") === "true";
  git("config", ...(worktree ? ["--worktree"] : []), "core.hooksPath", ".githooks");
  console.log("hooks git activés (core.hooksPath = .githooks)");
  return [];
}

// ------------------------------------------------------------ CLI

function lireStdin() {
  try {
    return readFileSync(0, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commande, ...args] = process.argv.slice(2);
  const commandes = {
    branche: () => [verifierBranche(args[0] ?? "")].filter(Boolean),
    titre: () => [verifierTitre(args[0] ?? "")].filter(Boolean),
    "pre-commit": preCommit,
    "commit-msg": () => commitMsg(args[0]),
    "pre-push": () => prePush(args[1], lireStdin()),
    ci: () => ci(),
    installer,
  };
  if (!commandes[commande]) {
    console.error(`usage : node scripts/regles.mjs ${Object.keys(commandes).join("|")}`);
    process.exit(2);
  }
  let problemes;
  try {
    problemes = commandes[commande]();
  } catch (e) {
    problemes = [e.message];
  }
  if (problemes.length) {
    const prefixe = process.env.GITHUB_ACTIONS ? "::error::" : `${commande} refusé : `;
    for (const p of problemes) console.error(`${prefixe}${p}`);
    if (!process.env.GITHUB_ACTIONS) console.error("Règles du dépôt : CONTRIBUTING.md");
    process.exit(1);
  }
  if (commande === "ci") console.log("règles respectées");
}
