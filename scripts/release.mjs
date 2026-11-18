#!/usr/bin/env node
// Publishes a Better Harness version on GitHub, under the Kwickos account only.
//
//   npm run release -- 0.2.0 "Release notes"          stable: becomes "latest", the apps update themselves
//   npm run release -- 0.2.0-beta.1 "Release notes"   beta: pre-release, never offered to stable apps
//   npm run release -- 0.2.0 --dry-run                checks only, nothing moves
//
// main is protected (scripts/protections.mjs): the version goes up in a release/v<version> PR,
// the CI must pass, the PR is merged with squash, then that commit of main is tagged and published.
// The build (universal, macOS 13 minimum, signed for the updater) happens before the PR:
// a version that does not build never reaches main.
// Running the same command again after a failure resumes where it stopped.
// The private key stays on this Mac: ~/.tauri/better-harness.key, password in the Keychain.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verify as verifyProtections } from "./protections.mjs";
import { EMAIL, MAIN, OWNER, REPO, VERSION, VERSION_FILES, compareVersions, hooksDir, isOfficialRemote, singleVersion } from "./rules.mjs";

const KEY = join(homedir(), ".tauri", "better-harness.key");
const KEYCHAIN = ["-a", "better-harness", "-s", "better-harness updater key"];
const BUNDLE = "src-tauri/target/universal-apple-darwin/release/bundle";
const OUT = "release";

const run = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }) ?? "").trim();
const attempt = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [version, notes] = args.filter((a) => a !== "--dry-run");
if (!VERSION.test(version ?? "")) fail('usage: npm run release -- <x.y.z | x.y.z-beta.N> ["notes"] [--dry-run]');
const tag = `v${version}`;
const beta = version.includes("-beta.");
const branch = `release/${tag}`;
const title = `release: ${tag}`;

// ------------------------------------------------------------ checks: Kwickos, clean main, protections in place

step("Checks");
const login = run("gh", ["api", "user", "--jq", ".login"]);
if (login !== OWNER) fail(`gh is logged in as "${login}", not ${OWNER} (gh auth switch -u ${OWNER}).`);
if (run("git", ["config", "user.name"]) !== OWNER || run("git", ["config", "user.email"]) !== EMAIL) fail(`git must sign the commits ${OWNER} <${EMAIL}>.`);
const remote = run("git", ["remote", "get-url", "origin"]);
if (!isOfficialRemote(remote)) fail(`the origin remote (${remote}) is not ${REPO}.`);
if (!hooksDir()) fail("the git hooks are not on: run node scripts/rules.mjs install.");
if (run("git", ["branch", "--show-current"]) !== MAIN) fail(`publish from the ${MAIN} branch.`);
if (run("git", ["status", "--porcelain"])) fail("some changes are not committed.");
run("git", ["fetch", "--quiet", "--prune", "--tags", "origin"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", `origin/${MAIN}`])) fail(`${MAIN} is not up to date with origin/${MAIN} (git pull --ff-only).`);
if (!existsSync(KEY)) fail(`signing key not found: ${KEY}`);
const drift = verifyProtections();
if (drift.length) fail(`the GitHub protections changed, no release without them (npm run protections):\n- ${drift.join("\n- ")}`);

const current = singleVersion();
const remoteTag = !!run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
if (remoteTag && attempt("gh", ["release", "view", tag, "--repo", REPO]).status === 0) fail(`${tag} is already published.`);

// Is the version PR already merged? Then resume at publishing.
const releaseCommit = run("git", ["log", `origin/${MAIN}`, "--format=%H %s"])
  .split("\n")
  .find((l) => new RegExp(`^\\w+ ${title.replace(/[.]/g, "\\.")}( \\(#\\d+\\))?$`).test(l))
  ?.split(" ")[0];
let stage;
if (releaseCommit) {
  if (remoteTag && run("git", ["rev-parse", `${tag}^{commit}`]) !== releaseCommit) fail(`tag ${tag} does not point to the "${title}" commit.`);
  stage = "publish";
} else {
  if (remoteTag) fail(`tag ${tag} already exists.`);
  if (compareVersions(version, current) <= 0) fail(`${version} is not newer than the current version ${current}.`);
  if (run("git", ["ls-remote", "--heads", "origin", branch])) fail(`branch ${branch} already exists on GitHub: a release is in progress (or close its PR).`);
  stage = "prepare";
}
console.log(`${OWNER} · ${REPO} · ${current} → ${version}${beta ? " (beta)" : ""} · protections in place`);
if (dryRun) {
  console.log(stage === "prepare" ? `\nTo do: branch ${branch}, build, PR "${title}", CI, squash merge, tag ${tag}, release.` : `\nTo do: build of ${releaseCommit.slice(0, 7)}, tag ${tag}, release.`);
  process.exit(0);
}

// ------------------------------------------------------------ signed build and binary checks

function build() {
  step("Signed universal build (a few minutes)");
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(KEY, "utf8"),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? run("security", ["find-generic-password", ...KEYCHAIN, "-w"]),
    // The .dmg is made without driving the Finder (no permission prompt).
    CI: "true",
  };
  try {
    execFileSync("npx", ["tauri", "build", "--target", "universal-apple-darwin", "--bundles", "app,dmg", "--config", '{"bundle":{"createUpdaterArtifacts":true}}'], { stdio: "inherit", env });
  } catch {
    throw new Error("the build failed.");
  }

  step("Binary checks");
  const exe = `${BUNDLE}/macos/Better Harness.app/Contents/MacOS/better-harness`;
  for (const bin of [exe, `${BUNDLE}/macos/Better Harness.app/Contents/MacOS/sim-bridge`]) {
    const archs = run("lipo", ["-archs", bin]);
    const minos = [...run("vtool", ["-show-build", bin]).matchAll(/minos (\S+)/g)].map((m) => m[1]);
    console.log(`${bin.split("/").pop()}: ${archs} · macOS ${[...new Set(minos)].join(", ")} minimum`);
    if (!archs.includes("arm64") || !archs.includes("x86_64")) throw new Error(`${bin} is not universal.`);
    const [majeur, mineur = 0] = minos.map((v) => v.split(".").map(Number)).sort((a, b) => b[0] - a[0] || (b[1] ?? 0) - (a[1] ?? 0))[0] ?? [];
    if (majeur > 13 || (majeur === 13 && mineur > 0)) throw new Error(`${bin} requires macOS ${minos.join("/")}.`);
  }

  const base = `Better-Harness_${version}_universal`;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT);
  const dmg = readdirSync(`${BUNDLE}/dmg`).find((f) => f.endsWith(".dmg") && f.includes(version));
  if (!dmg) throw new Error("the .dmg was not found.");
  copyFileSync(`${BUNDLE}/dmg/${dmg}`, `${OUT}/${base}.dmg`);
  copyFileSync(`${BUNDLE}/macos/Better Harness.app.tar.gz`, `${OUT}/${base}.app.tar.gz`);
  const signature = readFileSync(`${BUNDLE}/macos/Better Harness.app.tar.gz.sig`, "utf8").trim();
  const url = `https://github.com/${REPO}/releases/download/${tag}/${base}.app.tar.gz`;
  // The universal app serves both architectures.
  const platform = { signature, url };
  writeFileSync(
    `${OUT}/latest.json`,
    `${JSON.stringify({ version, notes: notes ?? "", pub_date: new Date().toISOString(), platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform } }, null, 2)}\n`,
  );
}

// ------------------------------------------------------------ version

function bumpVersion() {
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
  if (singleVersion() !== version) throw new Error("the version was not written everywhere.");
}

// ------------------------------------------------------------ version PR: required CI, then squash merge

function waitForCi(pr) {
  step("PR CI");
  // The checks show up a few seconds after the PR is opened.
  for (let i = 0; i < 24 && attempt("gh", ["pr", "checks", pr, "--required", "--json", "name"]).stdout.trim().length < 3; i++) sleep(5000);
  const ci = spawnSync("gh", ["pr", "checks", pr, "--required", "--watch", "--fail-fast", "--interval", "15"], { stdio: "inherit" });
  return ci.status === 0;
}

function prepare() {
  const base = run("git", ["rev-parse", "HEAD"]);
  step(`Branch ${branch}`);
  run("git", ["switch", "--quiet", "-c", branch]);
  const cleanUp = (pr) => {
    run("git", ["checkout", "--", ...VERSION_FILES]);
    run("git", ["switch", "--quiet", MAIN]);
    if (pr) attempt("gh", ["pr", "close", pr, "--comment", "Release abandoned.", "--delete-branch"]);
    if (run("git", ["branch", "--list", branch])) run("git", ["branch", "--quiet", "-D", branch]);
  };
  try {
    bumpVersion();
    build();
  } catch (e) {
    cleanUp();
    fail(`${e.message} Nothing was published.`);
  }
  run("git", ["commit", "--quiet", "-m", title, "--", ...VERSION_FILES], { stdio: "inherit" });
  const headSha = run("git", ["rev-parse", "HEAD"]);
  const tree = run("git", ["rev-parse", "HEAD^{tree}"]);

  step(`PR "${title}"`);
  run("git", ["push", "--quiet", "-u", "origin", branch], { stdio: "inherit" });
  const pr = run("gh", ["pr", "create", "--repo", REPO, "--base", MAIN, "--head", branch, "--title", title, "--body", notes || `Version ${version}.`]);
  console.log(pr);
  if (!waitForCi(pr)) {
    cleanUp(pr);
    fail("the CI failed: PR closed, nothing was published.");
  }
  run("git", ["fetch", "--quiet", "origin", MAIN]);
  if (run("git", ["rev-parse", `origin/${MAIN}`]) !== base) {
    cleanUp(pr);
    fail(`${MAIN} moved during the release: PR closed, run the command again.`);
  }
  run("gh", ["pr", "merge", pr, "--squash", "--match-head-commit", headSha, "--author-email", EMAIL], { stdio: "inherit" });

  run("git", ["switch", "--quiet", MAIN]);
  run("git", ["fetch", "--quiet", "--prune", "origin"]);
  run("git", ["merge", "--quiet", "--ff-only", `origin/${MAIN}`]);
  run("git", ["branch", "--quiet", "-D", branch]);
  // The build matches the merged commit only if the trees are identical.
  if (run("git", ["log", "-1", "--format=%s"]).replace(/ \(#\d+\)$/, "") !== title || run("git", ["rev-parse", "HEAD^{tree}"]) !== tree) {
    fail(`the merged commit does not match the build: run npm run release -- ${version} again to rebuild from ${MAIN}.`);
  }
  return run("git", ["rev-parse", "HEAD"]);
}

// ------------------------------------------------------------ tag and release

function publish(commit, built) {
  const head = run("git", ["rev-parse", "HEAD"]);
  if (!built) {
    if (commit !== head) run("git", ["switch", "--quiet", "--detach", commit]);
    try {
      build();
    } catch (e) {
      fail(`${e.message} Nothing was published.`);
    } finally {
      if (commit !== head) run("git", ["switch", "--quiet", MAIN]);
    }
  }
  step(`Publishing ${tag}`);
  if (!run("git", ["tag", "--list", tag])) run("git", ["tag", "-a", tag, commit, "-m", `Better Harness ${version}`]);
  if (run("git", ["rev-parse", `${tag}^{commit}`]) !== commit) fail(`local tag ${tag} does not point to ${commit.slice(0, 7)}.`);
  if (!remoteTag) run("git", ["push", "--quiet", "origin", `refs/tags/${tag}`], { stdio: "inherit" });
  const assets = readdirSync(OUT).map((f) => join(OUT, f));
  const notesArgs = notes ? ["--notes", notes] : ["--generate-notes"];
  const channel = beta ? ["--prerelease", "--latest=false"] : ["--latest"];
  run("gh", ["release", "create", tag, ...assets, "--repo", REPO, "--verify-tag", "--title", `Better Harness ${version}`, ...channel, ...notesArgs], { stdio: "inherit" });
  console.log(`\n${tag} published${beta ? " as a beta" : ""}: https://github.com/${REPO}/releases/tag/${tag}`);
}

if (stage === "prepare") publish(prepare(), true);
else publish(releaseCommit, false);
