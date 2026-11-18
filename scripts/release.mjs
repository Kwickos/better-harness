#!/usr/bin/env node
// Publie une version de Better Harness sur GitHub, sous le compte Kwickos uniquement.
//
//   npm run release -- 0.2.0 "Notes de version"          stable : devient « latest », les apps se mettent à jour
//   npm run release -- 0.2.0-beta.1 "Notes de version"   bêta : pré-release, jamais proposée aux apps stables
//   npm run release -- 0.2.0 --dry-run                   contrôles seuls, rien ne bouge
//
// main est protégée (scripts/protections.mjs) : la version monte dans une PR release/v<version>,
// la CI doit passer, la PR est mergée en squash, puis ce commit de main est tagué et publié.
// Le build (universel, macOS 13 minimum, signé pour le module de mise à jour) se fait avant la PR :
// une version qui ne se construit pas n'arrive jamais sur main.
// Relancer la même commande après un échec reprend où ça s'est arrêté.
// La clé privée reste sur ce Mac : ~/.tauri/better-harness.key, mot de passe dans le Trousseau.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifier as verifierProtections } from "./protections.mjs";
import { EMAIL, FICHIERS_VERSION, MAIN, OWNER, REPO, VERSION, comparer, depotOfficiel, dossierHooks, versionUnique } from "./regles.mjs";

const KEY = join(homedir(), ".tauri", "better-harness.key");
const KEYCHAIN = ["-a", "better-harness", "-s", "better-harness updater key"];
const BUNDLE = "src-tauri/target/universal-apple-darwin/release/bundle";
const OUT = "release";

const run = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }) ?? "").trim();
const essayer = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const fail = (msg) => {
  console.error(`release : ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [version, notes] = args.filter((a) => a !== "--dry-run");
if (!VERSION.test(version ?? "")) fail('usage : npm run release -- <x.y.z | x.y.z-beta.N> ["notes"] [--dry-run]');
const tag = `v${version}`;
const beta = version.includes("-beta.");
const branche = `release/${tag}`;
const titre = `release: ${tag}`;

// ------------------------------------------------------------ contrôles : Kwickos, main propre, protections en place

step("Vérifications");
const login = run("gh", ["api", "user", "--jq", ".login"]);
if (login !== OWNER) fail(`gh est connecté en « ${login} », pas en ${OWNER} (gh auth switch -u ${OWNER}).`);
if (run("git", ["config", "user.name"]) !== OWNER || run("git", ["config", "user.email"]) !== EMAIL) fail(`git doit signer les commits ${OWNER} <${EMAIL}>.`);
const remote = run("git", ["remote", "get-url", "origin"]);
if (!depotOfficiel(remote)) fail(`le remote origin (${remote}) n'est pas ${REPO}.`);
if (!dossierHooks()) fail("les hooks git ne sont pas actifs : lance node scripts/regles.mjs installer.");
if (run("git", ["branch", "--show-current"]) !== MAIN) fail(`publie depuis la branche ${MAIN}.`);
if (run("git", ["status", "--porcelain"])) fail("des modifications ne sont pas commitées.");
run("git", ["fetch", "--quiet", "--prune", "--tags", "origin"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", `origin/${MAIN}`])) fail(`${MAIN} n'est pas à jour avec origin/${MAIN} (git pull --ff-only).`);
if (!existsSync(KEY)) fail(`clé de signature introuvable : ${KEY}`);
const ecarts = verifierProtections();
if (ecarts.length) fail(`les protections GitHub ont changé, pas de release sans elles (npm run protections) :\n- ${ecarts.join("\n- ")}`);

const current = versionUnique();
const tagDistant = !!run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
if (tagDistant && essayer("gh", ["release", "view", tag, "--repo", REPO]).status === 0) fail(`${tag} est déjà publiée.`);

// La PR de version est-elle déjà mergée ? Alors on reprend à la publication.
const commitRelease = run("git", ["log", `origin/${MAIN}`, "--format=%H %s"])
  .split("\n")
  .find((l) => new RegExp(`^\\w+ ${titre.replace(/[.]/g, "\\.")}( \\(#\\d+\\))?$`).test(l))
  ?.split(" ")[0];
let etape;
if (commitRelease) {
  if (tagDistant && run("git", ["rev-parse", `${tag}^{commit}`]) !== commitRelease) fail(`le tag ${tag} ne pointe pas sur le commit « ${titre} ».`);
  etape = "publier";
} else {
  if (tagDistant) fail(`le tag ${tag} existe déjà.`);
  if (comparer(version, current) <= 0) fail(`${version} n'est pas plus récente que la version actuelle ${current}.`);
  if (run("git", ["ls-remote", "--heads", "origin", branche])) fail(`la branche ${branche} existe déjà sur GitHub : une release est en cours (ou ferme sa PR).`);
  etape = "preparer";
}
console.log(`${OWNER} · ${REPO} · ${current} → ${version}${beta ? " (bêta)" : ""} · protections en place`);
if (dryRun) {
  console.log(etape === "preparer" ? `\nÀ faire : branche ${branche}, build, PR « ${titre} », CI, merge squash, tag ${tag}, release.` : `\nÀ faire : build de ${commitRelease.slice(0, 7)}, tag ${tag}, release.`);
  process.exit(0);
}

// ------------------------------------------------------------ build signé et contrôles du binaire

function construire() {
  step("Build universel signé (quelques minutes)");
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(KEY, "utf8"),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? run("security", ["find-generic-password", ...KEYCHAIN, "-w"]),
    // Le .dmg se fait sans piloter le Finder (pas de demande d'autorisation).
    CI: "true",
  };
  try {
    execFileSync("npx", ["tauri", "build", "--target", "universal-apple-darwin", "--bundles", "app,dmg", "--config", '{"bundle":{"createUpdaterArtifacts":true}}'], { stdio: "inherit", env });
  } catch {
    throw new Error("le build a échoué.");
  }

  step("Contrôles du binaire");
  const exe = `${BUNDLE}/macos/Better Harness.app/Contents/MacOS/better-harness`;
  for (const bin of [exe, `${BUNDLE}/macos/Better Harness.app/Contents/MacOS/sim-bridge`]) {
    const archs = run("lipo", ["-archs", bin]);
    const minos = [...run("vtool", ["-show-build", bin]).matchAll(/minos (\S+)/g)].map((m) => m[1]);
    console.log(`${bin.split("/").pop()} : ${archs} · macOS ${[...new Set(minos)].join(", ")} minimum`);
    if (!archs.includes("arm64") || !archs.includes("x86_64")) throw new Error(`${bin} n'est pas universel.`);
    const [majeur, mineur = 0] = minos.map((v) => v.split(".").map(Number)).sort((a, b) => b[0] - a[0] || (b[1] ?? 0) - (a[1] ?? 0))[0] ?? [];
    if (majeur > 13 || (majeur === 13 && mineur > 0)) throw new Error(`${bin} exige macOS ${minos.join("/")}.`);
  }

  const base = `Better-Harness_${version}_universal`;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT);
  const dmg = readdirSync(`${BUNDLE}/dmg`).find((f) => f.endsWith(".dmg") && f.includes(version));
  if (!dmg) throw new Error("le .dmg est introuvable.");
  copyFileSync(`${BUNDLE}/dmg/${dmg}`, `${OUT}/${base}.dmg`);
  copyFileSync(`${BUNDLE}/macos/Better Harness.app.tar.gz`, `${OUT}/${base}.app.tar.gz`);
  const signature = readFileSync(`${BUNDLE}/macos/Better Harness.app.tar.gz.sig`, "utf8").trim();
  const url = `https://github.com/${REPO}/releases/download/${tag}/${base}.app.tar.gz`;
  // L'app universelle sert aux deux architectures.
  const platform = { signature, url };
  writeFileSync(
    `${OUT}/latest.json`,
    `${JSON.stringify({ version, notes: notes ?? "", pub_date: new Date().toISOString(), platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform } }, null, 2)}\n`,
  );
}

// ------------------------------------------------------------ version

function monterVersion() {
  const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
  edit("package.json", (s) => s.replace(/("version":\s*")[^"]+/, `$1${version}`));
  edit("package-lock.json", (s) => {
    const lock = JSON.parse(s);
    lock.version = version;
    lock.packages[""].version = version;
    return `${JSON.stringify(lock, null, 2)}\n`;
  });
  edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
  edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "better-harness"\nversion = ")[^"]+/, `$1${version}`));
  edit("src-tauri/tauri.conf.json", (s) => s.replace(/("version":\s*")[^"]+/, `$1${version}`));
  if (versionUnique() !== version) throw new Error("la version n'a pas été écrite partout.");
}

// ------------------------------------------------------------ PR de version : CI obligatoire puis merge squash

function attendreCi(pr) {
  step("CI de la PR");
  // Les checks apparaissent quelques secondes après l'ouverture de la PR.
  for (let i = 0; i < 24 && essayer("gh", ["pr", "checks", pr, "--required", "--json", "name"]).stdout.trim().length < 3; i++) pause(5000);
  const ci = spawnSync("gh", ["pr", "checks", pr, "--required", "--watch", "--fail-fast", "--interval", "15"], { stdio: "inherit" });
  return ci.status === 0;
}

function preparer() {
  const base = run("git", ["rev-parse", "HEAD"]);
  step(`Branche ${branche}`);
  run("git", ["switch", "--quiet", "-c", branche]);
  const nettoyer = (pr) => {
    run("git", ["checkout", "--", ...FICHIERS_VERSION]);
    run("git", ["switch", "--quiet", MAIN]);
    if (pr) essayer("gh", ["pr", "close", pr, "--comment", "Release abandonnée.", "--delete-branch"]);
    if (run("git", ["branch", "--list", branche])) run("git", ["branch", "--quiet", "-D", branche]);
  };
  try {
    monterVersion();
    construire();
  } catch (e) {
    nettoyer();
    fail(`${e.message} Rien n'a été publié.`);
  }
  run("git", ["commit", "--quiet", "-m", titre, "--", ...FICHIERS_VERSION], { stdio: "inherit" });
  const tete = run("git", ["rev-parse", "HEAD"]);
  const arbre = run("git", ["rev-parse", "HEAD^{tree}"]);

  step(`PR « ${titre} »`);
  run("git", ["push", "--quiet", "-u", "origin", branche], { stdio: "inherit" });
  const pr = run("gh", ["pr", "create", "--repo", REPO, "--base", MAIN, "--head", branche, "--title", titre, "--body", notes || `Version ${version}.`]);
  console.log(pr);
  if (!attendreCi(pr)) {
    nettoyer(pr);
    fail("la CI a échoué : PR fermée, rien n'a été publié.");
  }
  run("git", ["fetch", "--quiet", "origin", MAIN]);
  if (run("git", ["rev-parse", `origin/${MAIN}`]) !== base) {
    nettoyer(pr);
    fail(`${MAIN} a bougé pendant la release : PR fermée, relance la commande.`);
  }
  run("gh", ["pr", "merge", pr, "--squash", "--match-head-commit", tete, "--author-email", EMAIL], { stdio: "inherit" });

  run("git", ["switch", "--quiet", MAIN]);
  run("git", ["fetch", "--quiet", "--prune", "origin"]);
  run("git", ["merge", "--quiet", "--ff-only", `origin/${MAIN}`]);
  run("git", ["branch", "--quiet", "-D", branche]);
  // Le build correspond au commit mergé seulement si les arbres sont identiques.
  if (run("git", ["log", "-1", "--format=%s"]).replace(/ \(#\d+\)$/, "") !== titre || run("git", ["rev-parse", "HEAD^{tree}"]) !== arbre) {
    fail(`le commit mergé ne correspond pas au build : relance npm run release -- ${version} pour reconstruire depuis ${MAIN}.`);
  }
  return run("git", ["rev-parse", "HEAD"]);
}

// ------------------------------------------------------------ tag et release

function publier(commit, construit) {
  const head = run("git", ["rev-parse", "HEAD"]);
  if (!construit) {
    if (commit !== head) run("git", ["switch", "--quiet", "--detach", commit]);
    try {
      construire();
    } catch (e) {
      fail(`${e.message} Rien n'a été publié.`);
    } finally {
      if (commit !== head) run("git", ["switch", "--quiet", MAIN]);
    }
  }
  step(`Publication de ${tag}`);
  if (!run("git", ["tag", "--list", tag])) run("git", ["tag", "-a", tag, commit, "-m", `Better Harness ${version}`]);
  if (run("git", ["rev-parse", `${tag}^{commit}`]) !== commit) fail(`le tag local ${tag} ne pointe pas sur ${commit.slice(0, 7)}.`);
  if (!tagDistant) run("git", ["push", "--quiet", "origin", `refs/tags/${tag}`], { stdio: "inherit" });
  const assets = readdirSync(OUT).map((f) => join(OUT, f));
  const notesArgs = notes ? ["--notes", notes] : ["--generate-notes"];
  const canal = beta ? ["--prerelease", "--latest=false"] : ["--latest"];
  run("gh", ["release", "create", tag, ...assets, "--repo", REPO, "--verify-tag", "--title", `Better Harness ${version}`, ...canal, ...notesArgs], { stdio: "inherit" });
  console.log(`\n${tag} publiée${beta ? " en bêta" : ""} : https://github.com/${REPO}/releases/tag/${tag}`);
}

if (etape === "preparer") publier(preparer(), true);
else publier(commitRelease, false);
