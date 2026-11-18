#!/usr/bin/env node
// Protections GitHub du dépôt, versionnées ici : c'est la seule couche que rien ne contourne.
// Aucun « bypass actor » : même le compte propriétaire passe par une PR.
//
//   npm run protections            applique ce fichier tel qu'il est sur origin/main
//   npm run protections:verifier   compare GitHub à ce fichier (la release l'exige)

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN, PREFIXES, REPO } from "./regles.mjs";

/** ID de l'app GitHub Actions : seuls ses checks valident les statuts requis. */
const GITHUB_ACTIONS = 15368;
/** Jobs de .github/workflows/regles.yml qui doivent réussir avant un merge. */
export const CHECKS = ["regles", "web", "rust"];

export const REGLAGES = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: false,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "BLANK",
  delete_branch_on_merge: true,
};

export const RULESETS = [
  {
    name: "main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["squash"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: CHECKS.map((context) => ({ context, integration_id: GITHUB_ACTIONS })),
        },
      },
    ],
  },
  {
    name: "noms de branche",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH", ...PREFIXES.map((p) => `refs/heads/${p}/*`), "refs/heads/release/v*"] },
    },
    rules: [{ type: "creation" }],
  },
  {
    name: "tags immuables",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    rules: [{ type: "update" }, { type: "deletion" }],
  },
  {
    name: "noms de tag",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v*"] } },
    rules: [{ type: "creation" }],
  },
];

const api = (args, body) =>
  JSON.parse(
    execFileSync("gh", ["api", ...args, ...(body ? ["--input", "-"] : [])], {
      encoding: "utf8",
      input: body ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    }) || "null",
  );

/** `attendu` est-il contenu dans `reel` ? (GitHub ajoute ses propres champs par défaut.) */
function contenu(attendu, reel) {
  if (Array.isArray(attendu)) {
    return Array.isArray(reel) && attendu.length === reel.length && attendu.every((a) => reel.some((r) => contenu(a, r)));
  }
  if (attendu && typeof attendu === "object") return !!reel && typeof reel === "object" && Object.entries(attendu).every(([k, v]) => contenu(v, reel[k]));
  return attendu === reel;
}

/** Rulesets de GitHub en détail. Un ruleset se retrouve par son nom, ou par sa cible s'il a été renommé. */
function rulesetsGithub() {
  const details = api([`repos/${REPO}/rulesets`, "--paginate"]).map((r) => api([`repos/${REPO}/rulesets/${r.id}`]));
  return (attendu) =>
    details.find((r) => r.name === attendu.name) ??
    details.find((r) => r.target === attendu.target && contenu(attendu.conditions, r.conditions) && !RULESETS.some((a) => a.name === r.name));
}

/** Écarts entre GitHub et ce fichier (vide si tout est en place). */
export function verifier() {
  const ecarts = [];
  const repo = api([`repos/${REPO}`]);
  for (const [cle, valeur] of Object.entries(REGLAGES)) if (repo[cle] !== valeur) ecarts.push(`réglage ${cle} = ${repo[cle]} (attendu ${valeur})`);
  if (repo.default_branch !== MAIN) ecarts.push(`branche par défaut ${repo.default_branch} (attendu ${MAIN})`);
  if (!api([`repos/${REPO}/immutable-releases`]).enabled) ecarts.push("releases immuables désactivées");
  const trouver = rulesetsGithub();
  for (const attendu of RULESETS) {
    const reel = trouver(attendu);
    if (!reel) {
      ecarts.push(`ruleset « ${attendu.name} » absent`);
      continue;
    }
    if (reel.name !== attendu.name) ecarts.push(`ruleset « ${reel.name} » à renommer en « ${attendu.name} »`);
    if (reel.enforcement !== "active") ecarts.push(`ruleset « ${attendu.name} » : ${reel.enforcement} (attendu active)`);
    if (reel.bypass_actors?.length) ecarts.push(`ruleset « ${attendu.name} » : ${reel.bypass_actors.length} exception(s) de contournement`);
    if (reel.target !== attendu.target || !contenu(attendu.conditions, reel.conditions)) ecarts.push(`ruleset « ${attendu.name} » : cible modifiée`);
    for (const regle of attendu.rules) {
      const r = reel.rules.find((x) => x.type === regle.type);
      if (!r || !contenu(regle.parameters ?? {}, r.parameters ?? {})) ecarts.push(`ruleset « ${attendu.name} » : règle ${regle.type} absente ou modifiée`);
    }
  }
  return ecarts;
}

function appliquer() {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("fetch", "--quiet", "origin", MAIN);
  // Seule la version mergée fait foi : une branche ne peut pas affaiblir les protections.
  // Exception : la toute première installation, quand main n'a pas encore ce fichier.
  const fichiers = ["scripts/protections.mjs", "scripts/regles.mjs"];
  let premiere = false;
  try {
    git("cat-file", "-e", `origin/${MAIN}:scripts/protections.mjs`);
  } catch {
    premiere = true;
  }
  if (!premiere) {
    try {
      git("diff", "--quiet", `origin/${MAIN}`, "--", ...fichiers);
    } catch {
      throw new Error(`${fichiers.join(" et ")} diffèrent de origin/${MAIN} : merge d'abord la PR qui les change.`);
    }
  } else {
    console.log("première installation : protections appliquées depuis cette branche");
  }

  api([`repos/${REPO}`, "-X", "PATCH"], REGLAGES);
  console.log("réglages du dépôt : squash uniquement, branches supprimées après merge");
  execFileSync("gh", ["api", "-X", "PUT", `repos/${REPO}/immutable-releases`], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("releases immuables");
  const trouver = rulesetsGithub();
  for (const ruleset of RULESETS) {
    const id = trouver(ruleset)?.id;
    api(id ? [`repos/${REPO}/rulesets/${id}`, "-X", "PUT"] : [`repos/${REPO}/rulesets`, "-X", "POST"], ruleset);
    console.log(`ruleset « ${ruleset.name} » ${id ? "mis à jour" : "créé"}`);
  }
  const ecarts = verifier();
  if (ecarts.length) throw new Error(`appliqué, mais GitHub diffère encore :\n- ${ecarts.join("\n- ")}`);
  console.log("protections en place");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commande = process.argv[2];
  try {
    if (commande === "appliquer") appliquer();
    else if (commande === "verifier") {
      const ecarts = verifier();
      if (ecarts.length) throw new Error(`les protections GitHub ne correspondent pas à scripts/protections.mjs :\n- ${ecarts.join("\n- ")}`);
      console.log("protections en place");
    } else throw new Error("usage : node scripts/protections.mjs appliquer|verifier");
  } catch (e) {
    console.error(`protections : ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
}
