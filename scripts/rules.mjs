#!/usr/bin/env node
// Repository rules: one source for the git hooks, the CI, the Claude session guard and the release.
// The readable summary is in CONTRIBUTING.md.
//
//   node scripts/rules.mjs branch <name>          valid branch name?
//   node scripts/rules.mjs title "<title>"        valid PR title?
//   node scripts/rules.mjs pre-commit             (git hook)
//   node scripts/rules.mjs commit-msg <file>      (git hook)
//   node scripts/rules.mjs pre-push <remote> <url> < lines   (git hook)
//   node scripts/rules.mjs ci                     checks of a PR (GitHub Actions)
//   node scripts/rules.mjs install                turns the git hooks on (npm install does it)

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER = "Kwickos";
/**
 * Kwickos's GitHub noreply address with its account id: the only one GitHub accepts as the author of a
 * squash merge. Local commits use it too, so merges don't add a Co-authored-by for a second address.
 */
export const EMAIL = "126871467+Kwickos@users.noreply.github.com";
export const REPO = `${OWNER}/better-harness`;
export const MAIN = "main";

/** Types accepted at the start of PR titles, hence of the commits on main. */
export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert", "release"];
/** Prefix of the branches created by Claude app sessions ("Branch prefix" setting). */
export const CLAUDE_PREFIX = "features";
/** Branch prefixes: the types (except release, reserved for the script) and the one of Claude sessions. */
export const PREFIXES = [...TYPES.filter((t) => t !== "release"), CLAUDE_PREFIX];

/** Stable version `x.y.z` or beta `x.y.z-beta.N`. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;
const SUBJECT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TITLE = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?(!)?: (\\S.*)$`, "u");
const CO_AUTHOR = /^co-authored-by:/im;
/** Kwickos's GitHub identities (the address with an ID is used by merges made on github.com). */
const GITHUB_EMAIL = new RegExp(`^(\\d+\\+)?${OWNER}@users\\.noreply\\.github\\.com$`, "i");
const GITHUB_COMMITTER = "GitHub <noreply@github.com>";
const ZERO = "0".repeat(40);

/** Official remote: https (optionally with the user) or ssh, on github.com exactly. */
export function isOfficialRemote(url) {
  return new RegExp(`^(https://([^@/]+@)?github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${REPO}(\\.git)?/?$`).test(url ?? "");
}

export const VERSION_FILES = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"];

// ------------------------------------------------------------ conventions

/** Returns the reason for refusal, or null if the branch name is valid. */
/**
 * Release channels, next to main (development): each points to the last published release of its kind.
 * Only npm run release moves them, forward, onto a tagged commit of main.
 */
export const CHANNELS = ["beta", "stable"];

/** Can `channel` point to a commit carrying `tags`? stable: a stable version tag; beta: any version tag. */
export function channelAccepts(channel, tags) {
  const versions = tags.filter((t) => /^v/.test(t) && VERSION.test(t.slice(1)));
  return channel === "stable" ? versions.some((t) => !t.includes("-beta.")) : versions.length > 0;
}

export function checkBranch(name) {
  if (name === MAIN) return `${MAIN} only receives PRs merged with squash, never a direct push.`;
  if (CHANNELS.includes(name)) return `${name} is a release channel: only npm run release moves it.`;
  const [prefix, ...rest] = name.split("/");
  const subject = rest.join("/");
  if (prefix === "release") {
    return /^v/.test(subject) && VERSION.test(subject.slice(1)) ? null : `a release branch is named release/v<x.y.z> or release/v<x.y.z-beta.N> (not "${name}").`;
  }
  if (!PREFIXES.includes(prefix) || !rest.length) return `"${name}": a branch is named <type>/<subject>, type one of ${PREFIXES.join(", ")}.`;
  if (!SUBJECT.test(subject)) return `"${name}": the subject is written in lowercase letters, digits and hyphens (e.g. ${prefix}/beta-channel).`;
  if (name.length > 60) return `"${name}": 60 characters at most.`;
  return null;
}

/** Returns the reason for refusal, or null if the PR title (future commit on main) is valid. */
export function checkTitle(title) {
  const m = TITLE.exec(title ?? "");
  if (!m) return `title "${title}": it is written <type>: <description> (or <type>(scope): …), type one of ${TYPES.join(", ")}.`;
  if (title.length > 72) return `title of ${title.length} characters: 72 at most.`;
  if (/[.\s]$/.test(title)) return "the title ends with neither a period nor a space.";
  if (m[1] === "release" && !(m[4].startsWith("v") && VERSION.test(m[4].slice(1)) && !m[2] && !m[3])) return 'a release title is exactly "release: v<version>".';
  return null;
}

/** Compares two versions (beta < stable of the same number). Negative if a < b. */
export function compareVersions(a, b) {
  const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
  if (!x || !y) throw new Error(`invalid version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  const beta = (m) => (m[4] ? Number(m[4]) : Infinity);
  return beta(x) === beta(y) ? 0 : beta(x) < beta(y) ? -1 : 1;
}

/** Version written in each file; `read(file)` returns its content. */
export function versions(read = (f) => readFileSync(f, "utf8")) {
  const lock = JSON.parse(read("package-lock.json"));
  return {
    "package.json": JSON.parse(read("package.json")).version,
    "package-lock.json": lock.version === lock.packages?.[""]?.version ? lock.version : `${lock.version} / ${lock.packages?.[""]?.version}`,
    "src-tauri/Cargo.toml": /^version = "([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1],
    "src-tauri/Cargo.lock": /name = "better-harness"\nversion = "([^"]+)"/.exec(read("src-tauri/Cargo.lock"))?.[1],
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  };
}

/** The repository's single version, or an error if the files disagree. */
export function singleVersion(read) {
  const v = versions(read);
  const distinct = [...new Set(Object.values(v))];
  if (distinct.length !== 1 || !VERSION.test(distinct[0] ?? "")) {
    throw new Error(`the version files disagree: ${Object.entries(v).map(([f, x]) => `${f}=${x}`).join(", ")}`);
  }
  return distinct[0];
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
const readAt = (rev) => (f) => git("show", `${rev}:${f}`);

/**
 * Identity problems in the commits of `revs` (git log arguments).
 * Strict (local push): author and committer exactly Kwickos.
 * Otherwise (CI): the noreply address with an ID and GitHub as committer are accepted too (merges made on github.com).
 */
export function checkCommits(revs, { strict }) {
  const output = git("log", "--format=%h%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", ...revs);
  const problems = [];
  for (const block of output.split("\x1e")) {
    if (!block.trim()) continue;
    const [h, an, ae, cn, ce, body] = block.trim().split("\x1f");
    const author = `${an} <${ae}>`;
    const committer = `${cn} <${ce}>`;
    const kwickos = (name, email) => name === OWNER && (strict ? email === EMAIL : GITHUB_EMAIL.test(email));
    if (!kwickos(an, ae)) problems.push(`${h}: author ${author}, expected ${OWNER} <${EMAIL}>`);
    if (!kwickos(cn, ce) && (strict || committer !== GITHUB_COMMITTER)) problems.push(`${h}: committer ${committer}, expected ${OWNER} <${EMAIL}>`);
    if (CO_AUTHOR.test(body ?? "")) problems.push(`${h}: Co-authored-by trailer not allowed (${OWNER} is the only author)`);
  }
  return problems;
}

const currentBranch = () => git("branch", "--show-current");

/** Active hooks folder: this checkout's .githooks with its three hooks executable, otherwise null. */
export function hooksDir(cwd = ".") {
  try {
    const read = (...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const top = read("rev-parse", "--show-toplevel");
    const dir = join(top, ".githooks");
    if (resolve(top, read("config", "--get", "core.hooksPath")) !== dir) return null;
    for (const h of ["pre-commit", "commit-msg", "pre-push"]) accessSync(join(dir, h), constants.X_OK);
    return dir;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ git hooks

function preCommit() {
  const branch = currentBranch();
  if (branch === MAIN) return [`no commit on ${MAIN}: create a branch (git switch -c feat/<subject>).`];
  const name = git("config", "user.name");
  const email = git("config", "user.email");
  if (name !== OWNER || email !== EMAIL) return [`git signs as "${name} <${email}>", expected ${OWNER} <${EMAIL}> (git config user.name/user.email).`];
  return [];
}

function commitMsg(file) {
  const message = readFileSync(file, "utf8").replace(/^#.*$/gm, "");
  return CO_AUTHOR.test(message) ? [`Co-authored-by trailer not allowed: ${OWNER} is the only author.`] : [];
}

/** A channel moves forward only, onto a commit of main tagged with a release of its kind. */
function checkChannelMove(name, localSha, remoteSha) {
  if (localSha === ZERO) return [`${name} is a release channel: it is never deleted.`];
  const commit = git("rev-parse", `${localSha}^{commit}`);
  const tags = git("tag", "--points-at", commit).split("\n").filter(Boolean);
  if (!gitOk("merge-base", "--is-ancestor", commit, `refs/remotes/origin/${MAIN}`)) return [`${name} only points to commits of origin/${MAIN}.`];
  if (!channelAccepts(name, tags)) return [`${name} only points to a commit tagged with a ${name === "stable" ? "stable " : ""}release (v<version>): npm run release moves it.`];
  if (remoteSha !== ZERO && !gitOk("merge-base", "--is-ancestor", remoteSha, commit)) return [`${name} only moves forward (fetch first if it moved on GitHub).`];
  return [];
}

function prePush(url, lines) {
  if (!isOfficialRemote(url)) return [`${url} is not ${REPO}.`];
  try {
    const login = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (login && login !== OWNER) return [`gh is logged in as "${login}" (gh auth switch -u ${OWNER}).`];
  } catch {
    // gh missing or offline: the server checks anyway.
  }
  const problems = [];
  for (const line of lines) {
    const [, localSha, ref, remoteSha] = line.trim().split(/\s+/);
    if (!ref) continue;
    const deletion = localSha === ZERO;
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (name === MAIN) {
        problems.push(`${MAIN} only receives PRs merged with squash: push a branch and open a PR.`);
        continue;
      }
      if (CHANNELS.includes(name)) {
        problems.push(...checkChannelMove(name, localSha, remoteSha));
        continue;
      }
      if (deletion) continue;
      const reason = checkBranch(name);
      if (reason) problems.push(reason);
    } else if (ref.startsWith("refs/tags/")) {
      const tag = ref.slice("refs/tags/".length);
      if (deletion || remoteSha !== ZERO) {
        problems.push(`tag ${tag} is published: it is never moved or deleted.`);
        continue;
      }
      if (!/^v/.test(tag) || !VERSION.test(tag.slice(1))) {
        problems.push(`tag "${tag}": only v<version> tags exist, created by npm run release.`);
        continue;
      }
      const commit = git("rev-parse", `${localSha}^{commit}`);
      if (!gitOk("merge-base", "--is-ancestor", commit, `refs/remotes/origin/${MAIN}`)) problems.push(`tag ${tag} does not point to a commit of origin/${MAIN}.`);
      else {
        try {
          const v = singleVersion(readAt(commit));
          if (`v${v}` !== tag) problems.push(`tag ${tag} points to a commit at version ${v}.`);
        } catch (e) {
          problems.push(`tag ${tag}: ${e.message}`);
        }
      }
    } else {
      problems.push(`${ref}: only branches and version tags can be pushed.`);
    }
    if (deletion) continue;
    // Only commits GitHub doesn't have yet: a branch updated with main must not re-check main's squash commits.
    const revs = [localSha, "--not", "--remotes=origin", ...(remoteSha === ZERO ? [] : [remoteSha])];
    problems.push(...checkCommits(revs, { strict: true }));
  }
  return problems;
}

// ------------------------------------------------------------ CI (GitHub Actions, pull_request event)

function ci(env = process.env) {
  const { HEAD_REF: branch, PR_TITLE: title, BASE_REF = MAIN, HEAD_SHA = "HEAD" } = env;
  const base = `origin/${BASE_REF}`;
  const problems = [];
  if (BASE_REF !== MAIN) problems.push(`a PR targets ${MAIN} (not ${BASE_REF}).`);
  const branchReason = checkBranch(branch ?? "");
  if (branchReason) problems.push(`branch: ${branchReason}`);
  const titleReason = checkTitle(title);
  if (titleReason) problems.push(titleReason);

  const release = /^release\/v(.+)$/.exec(branch ?? "")?.[1];
  if (release && title !== `release: v${release}`) problems.push(`a release PR is titled "release: v${release}".`);
  if (!release && /^release:/.test(title ?? "")) problems.push("a release: title is reserved for the release/v<version> branches created by npm run release.");

  problems.push(...checkCommits([HEAD_SHA, "--not", base], { strict: false }));

  try {
    const before = singleVersion(readAt(base));
    const after = singleVersion(readAt(HEAD_SHA));
    if (release) {
      if (after !== release) problems.push(`branch release/v${release} must carry version ${release} (it carries ${after}).`);
      else if (compareVersions(after, before) <= 0) problems.push(`${after} is not newer than ${before}.`);
      const touched = git("diff", "--name-only", `${base}...${HEAD_SHA}`).split("\n").filter(Boolean);
      const others = touched.filter((f) => !VERSION_FILES.includes(f));
      if (others.length) problems.push(`a release PR only changes the version (here also: ${others.join(", ")}).`);
    } else if (after !== before) {
      problems.push(`the version goes from ${before} to ${after}: only npm run release changes it.`);
    }
  } catch (e) {
    problems.push(e.message);
  }
  return problems;
}

// ------------------------------------------------------------ hooks installation

function install() {
  if (!gitOk("rev-parse", "--git-dir")) return [];
  if (hooksDir()) return [];
  // Claude session worktrees have their own setting (config.worktree), which wins over the repository's.
  const worktree = gitOk("config", "--get", "extensions.worktreeConfig") && git("config", "--get", "extensions.worktreeConfig") === "true";
  git("config", ...(worktree ? ["--worktree"] : []), "core.hooksPath", ".githooks");
  console.log("git hooks on (core.hooksPath = .githooks)");
  return [];
}

// ------------------------------------------------------------ CLI

function readStdin() {
  try {
    return readFileSync(0, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const commands = {
    branch: () => [checkBranch(args[0] ?? "")].filter(Boolean),
    title: () => [checkTitle(args[0] ?? "")].filter(Boolean),
    "pre-commit": preCommit,
    "commit-msg": () => commitMsg(args[0]),
    "pre-push": () => prePush(args[1], readStdin()),
    ci: () => ci(),
    install,
  };
  if (!commands[command]) {
    console.error(`usage: node scripts/rules.mjs ${Object.keys(commands).join("|")}`);
    process.exit(2);
  }
  let problems;
  try {
    problems = commands[command]();
  } catch (e) {
    problems = [e.message];
  }
  if (problems.length) {
    const prefix = process.env.GITHUB_ACTIONS ? "::error::" : `${command} refused: `;
    for (const p of problems) console.error(`${prefix}${p}`);
    if (!process.env.GITHUB_ACTIONS) console.error("Repository rules: CONTRIBUTING.md");
    process.exit(1);
  }
  if (command === "ci") console.log("rules respected");
}
