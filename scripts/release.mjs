#!/usr/bin/env node
// Publie une version de Better Harness sur GitHub, sous le compte Kwickos uniquement.
//
//   npm run release -- 0.2.0 "Notes de version"
//
// Étapes : vérifie l'identité (gh, git, remote), monte la version, construit l'app universelle
// (Apple Silicon + Intel, macOS 13 minimum) signée pour le module de mise à jour, puis pousse le
// commit et le tag et crée la release avec le .dmg, le .app.tar.gz et latest.json.
// La clé privée reste sur ce Mac : ~/.tauri/better-harness.key, mot de passe dans le Trousseau.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OWNER = "Kwickos";
const EMAIL = "Kwickos@users.noreply.github.com";
const REPO = `${OWNER}/better-harness`;
const KEY = join(homedir(), ".tauri", "better-harness.key");
const KEYCHAIN = ["-a", "better-harness", "-s", "better-harness updater key"];
const BUNDLE = "src-tauri/target/universal-apple-darwin/release/bundle";
const OUT = "release";
const VERSION_FILES = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"];

const run = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }) ?? "").trim();
const fail = (msg) => {
  console.error(`release : ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const semver = (v) => v.split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const [version, notes] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail("usage : npm run release -- <x.y.z> [\"notes\"]");
const tag = `v${version}`;

// ------------------------------------------------------------ identité : Kwickos, rien d'autre

step("Vérification du compte");
const login = run("gh", ["api", "user", "--jq", ".login"]);
if (login !== OWNER) fail(`gh est connecté en « ${login} », pas en ${OWNER} (gh auth switch -u ${OWNER}).`);
if (run("git", ["config", "user.name"]) !== OWNER || run("git", ["config", "user.email"]) !== EMAIL) fail(`git doit signer les commits ${OWNER} <${EMAIL}>.`);
const remote = run("git", ["remote", "get-url", "origin"]);
if (!new RegExp(`github\\.com[:/]${REPO}(\\.git)?$`).test(remote)) fail(`le remote origin (${remote}) n'est pas ${REPO}.`);
if (run("git", ["branch", "--show-current"]) !== "main") fail("publie depuis la branche main.");
if (run("git", ["status", "--porcelain"])) fail("des modifications ne sont pas commitées.");
if (run("git", ["tag", "--list", tag])) fail(`le tag ${tag} existe déjà.`);
if (!existsSync(KEY)) fail(`clé de signature introuvable : ${KEY}`);
const current = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
if (newer(current, version)) fail(`${version} est plus ancienne que la version actuelle ${current}.`);
console.log(`${OWNER} · ${REPO} · ${current} → ${version}`);

// ------------------------------------------------------------ version

const bump = () => {
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
};
const restore = () => run("git", ["checkout", "--", ...VERSION_FILES]);
if (version !== current) bump();

// ------------------------------------------------------------ build signé

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
  if (version !== current) restore();
  fail("le build a échoué, la version n'a pas été changée.");
}

// ------------------------------------------------------------ contrôles : macOS 13, Intel + Apple Silicon

step("Contrôles du binaire");
const exe = `${BUNDLE}/macos/Better Harness.app/Contents/MacOS/better-harness`;
for (const bin of [exe, `${BUNDLE}/macos/Better Harness.app/Contents/MacOS/sim-bridge`]) {
  const archs = run("lipo", ["-archs", bin]);
  const minos = [...run("vtool", ["-show-build", bin]).matchAll(/minos (\S+)/g)].map((m) => m[1]);
  console.log(`${bin.split("/").pop()} : ${archs} · macOS ${[...new Set(minos)].join(", ")} minimum`);
  if (!archs.includes("arm64") || !archs.includes("x86_64")) fail(`${bin} n'est pas universel.`);
  if (minos.some((v) => newer(v, "13.0"))) fail(`${bin} exige macOS ${minos.join("/")}.`);
}

// ------------------------------------------------------------ fichiers de la release

const base = `Better-Harness_${version}_universal`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
const dmg = readdirSync(`${BUNDLE}/dmg`).find((f) => f.endsWith(".dmg") && f.includes(version));
if (!dmg) fail("le .dmg est introuvable.");
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

// ------------------------------------------------------------ publication

step(`Publication de ${tag}`);
if (version !== current) run("git", ["commit", "--quiet", "-m", `Version ${version}`, "--", ...VERSION_FILES], { stdio: "inherit" });
run("git", ["tag", tag]);
run("git", ["push", "--quiet", "origin", "main", tag], { stdio: "inherit" });
const assets = readdirSync(OUT).map((f) => join(OUT, f));
const notesArgs = notes ? ["--notes", notes] : ["--generate-notes"];
run("gh", ["release", "create", tag, ...assets, "--repo", REPO, "--title", `Better Harness ${version}`, ...notesArgs], { stdio: "inherit" });
console.log(`\n${tag} publiée : https://github.com/${REPO}/releases/tag/${tag}`);
