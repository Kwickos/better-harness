#!/usr/bin/env node
// Guard for Claude sessions (PreToolUse hook on Bash, wired in .claude/settings.json).
// The git hooks and GitHub enforce the rules; this hook stops a session from getting around them:
// --no-verify, hooks turned off, pushes to main or of tags, merges other than squash, hand-made releases,
// direct writes to the protections through the API. Exit code 2 = command refused, reason on stderr.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EMAIL, MAIN, OWNER, checkTitle, hooksDir } from "../../scripts/rules.mjs";

const RELEASE = "tags and releases are only created by npm run release (see CONTRIBUTING.md)";
const HOOKS_OFF = "the repository's git hooks stay on.";
const INJECTED_CONFIG = "no git alias or include on the fly: write the command in full.";
const HIDDEN_ARGS = "xargs and find -exec hide the arguments of git/gh: write the command in full.";

// ------------------------------------------------------------ shell words

/** Redirection operators, longest first. A file descriptor may come before them (2>). */
const REDIRECTIONS = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", "<", ">>", ">|", ">&", ">"];

/**
 * Splits a shell line into commands (separators ; && || | & and subshells), each one with its words
 * and the targets of its output redirections (> >> >| &> >& <>), which are not words of the command.
 * With `shell` false, only quotes and backslashes count: that is how git splits an alias and env -S its string.
 */
export function parse(line, shell = true) {
  const out = [];
  let words = [];
  let writes = [];
  let word = null;
  let quoted = false;
  let quote = null;
  let redirect = null;
  const endWord = () => {
    if (word !== null) {
      if (redirect === null) words.push(word);
      else if (redirect.includes(">")) writes.push(word);
      redirect = null;
    }
    word = null;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    redirect = null;
    if (words.length || writes.length) out.push({ words, writes });
    words = [];
    writes = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
      quoted = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
      quoted = true;
    } else if (/\s/.test(c)) {
      if (c === "\n" && shell) endCommand();
      else endWord();
    } else if (shell && (c === ">" || c === "<" || (c === "&" && line[i + 1] === ">"))) {
      // The redirection's target is the next word; a number just before is its file descriptor.
      if (word !== null && !quoted && /^\d+$/.test(word)) word = null;
      else endWord();
      redirect = REDIRECTIONS.find((o) => line.startsWith(o, i));
      i += redirect.length - 1;
    } else if (shell && (";&|()`".includes(c) || (c === "$" && line[i + 1] === "("))) {
      endCommand();
      if (c === "$") i++;
    } else word = (word ?? "") + c;
  }
  endCommand();
  return out;
}

/** Splits a shell line into commands, each one into words (redirections left out). */
export const commands = (line) => parse(line).map((c) => c.words).filter((w) => w.length);
/** Words of a string split without shell operators (git alias, env -S). */
const splitWords = (text) => parse(text, false).flatMap((c) => c.words);

const basename = (word) => word.split("/").pop();
const expandHome = (path) => path.replace(/^~(?=\/|$)/, process.env.HOME ?? homedir());
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Words before the real command (shell prefixes and keywords).
const WRAPPERS = new Set(["rtk", "proxy", "builtin", "{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "export"]);
/** Builtins whose NAME=value arguments set variables, like export. */
const DECLARATIONS = new Set(["declare", "typeset", "readonly", "local"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "perl", "deno", "bun", "osascript", "php"]);
/** Files that enforce the rules: a PR touching them is merged by the user, not by a session. */
export const RULE_FILES = /^(scripts\/(rules|protections|release)\.mjs|\.github\/|\.githooks\/|\.claude\/(hooks\/|settings\.json))/;
const HOOK_PATHS = /(^|\/)\.githooks(\/|$)|\.git\/hooks|\.claude\/hooks|\.claude\/settings|scripts\/(rules|protections|release)\.mjs/;
/** git config files (repository, worktree, user): they could turn the hooks off or define aliases. */
const GIT_CONFIG_PATHS = /\.git\/(worktrees\/[^/]+\/)?config(\.worktree)?$|(^|\/)\.gitconfig$|(^|\/)\.config\/git\/config$/;
/** Words whose meaning the shell would change (variables, braces, wildcards): refused where they name refs. */
const EXPANSION = /[$`{}*?[\]]/;
/** Config passed on the fly (-c, GIT_CONFIG_*) that would change what git runs without the guard seeing it. */
const INJECTED = /alias\.|include(if)?\./i;
/** Variables that point git to other config files (/dev/null, an empty config, is fine). */
const CONFIG_FILE_VARS = /^GIT_CONFIG(_GLOBAL|_SYSTEM)?=(?!\/dev\/null$)/i;

/**
 * Launchers (and the shell keywords that work the same way) run the command that follows their options:
 * the whole rest is analysed like a command of its own.
 * `short`, `long`, `single`: their options that take a value (-u root, --user root, -arch arm64);
 * `positional`: words before the command (timeout's duration); `assignments`: NAME=value allowed before it.
 */
const LAUNCHERS = {
  sudo: { short: "CDghpRrTtUu", long: ["chdir", "chroot", "close-from", "command-timeout", "group", "host", "other-user", "prompt", "role", "type", "user"], assignments: true },
  doas: { short: "Cu" },
  env: { short: "CPSu", long: ["chdir", "split-string", "unset"], assignments: true },
  nice: { short: "n", long: ["adjustment"] },
  timeout: { short: "ks", long: ["kill-after", "signal"], positional: 1 },
  caffeinate: { short: "tw" },
  nohup: {},
  time: { short: "fo", long: ["format", "output"] },
  command: {},
  exec: { short: "a" },
  stdbuf: { short: "eio", long: ["error", "input", "output"] },
  arch: { short: "de", single: ["arch"] },
  ionice: { short: "cnp", long: ["class", "classdata", "pid"] },
  xcrun: { long: ["sdk", "toolchain"], single: ["sdk", "toolchain"] },
  noglob: {},
  nocorrect: {},
  coproc: {},
  repeat: { positional: 1 },
  function: { positional: 1 },
};

/** Command run by a launcher (its words) and the NAME=value it sets. */
function launched(name, args) {
  const spec = LAUNCHERS[name];
  const rest = [...args];
  const env = [];
  let positional = spec.positional ?? 0;
  let k = 0;
  // env -S splits its value into words, which take the place of the option.
  const split = (count, text) => rest.splice(k, count, ...splitWords(text));
  while (k < rest.length) {
    const w = rest[k];
    if (w === "--") {
      k++;
      break;
    }
    if (w === "-" && name === "env") k++;
    else if (w.startsWith("--")) {
      const [option, value] = w.slice(2).split(/=(.*)/s);
      if (name === "env" && option && "split-string".startsWith(option)) split(value === undefined ? 2 : 1, value ?? rest[k + 1] ?? "");
      // Long options can be abbreviated (--kill for --kill-after).
      else k += value === undefined && option && spec.long?.some((l) => l.startsWith(option)) ? 2 : 1;
    } else if (w.startsWith("-") && w.length > 1) {
      if (spec.single?.includes(w.slice(1))) {
        k += 2;
        continue;
      }
      // A group of short options: the first one that takes a value ends it (-Eu root, -uroot).
      const at = [...w.slice(1)].findIndex((c) => spec.short?.includes(c)) + 1;
      const value = at ? w.slice(at + 1) : "";
      if (at && name === "env" && w[at] === "S") split(value ? 1 : 2, value || (rest[k + 1] ?? ""));
      else k += at && !value ? 2 : 1;
    } else if (spec.assignments && ASSIGNMENT.test(w)) {
      env.push(w);
      k++;
    } else if (positional > 0) {
      positional--;
      k++;
    } else break;
  }
  return { words: rest.slice(k), env };
}

/** `a` is the option `name`? git accepts unambiguous abbreviations of long options (--no-verif…). */
const isOption = (a, ...names) => {
  const o = a.split("=")[0];
  return names.some((n) => o === n || (n.startsWith("--") && o.startsWith("--") && o.length > 3 && n.startsWith(o)));
};

// ------------------------------------------------------------ git

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const CONFIG_VALUE_OPTIONS = /^(-f|--file|--blob|--type|--default|--comment|--value|--url)$/;
/** Subcommands that xargs or find -exec must not complete with words we do not see. */
const RISKY_WHEN_APPENDED = new Set(["push", "tag", "commit", "config", "merge", "rebase", "update-ref"]);
/** Aliases expanded into aliases beyond this are refused (git itself only stops on loops). */
const ALIAS_LIMIT = 10;

const branchOf = (cwd) => {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

function analyzeGit(args, cwd, env, ctx, appended = false) {
  const expanded = [];
  for (let words = args; ; ) {
    const configs = env.filter((e) => /^GIT_CONFIG/i.test(e));
    let dir = cwd;
    let i = 0;
    for (; i < words.length && words[i].startsWith("-"); i++) {
      const [option, value] = words[i].split(/=(.*)/s);
      if (GIT_VALUE_OPTIONS.has(option)) {
        const v = value ?? words[++i] ?? "";
        if (option === "-C") dir = resolve(dir, v);
        if (option === "-c" || option === "--config-env") configs.push(v);
      }
    }
    if (configs.some((c) => /hookspath/i.test(c))) return HOOKS_OFF;
    if (configs.some((c) => INJECTED.test(c))) return INJECTED_CONFIG;
    const [sub, ...rest] = words.slice(i);
    if (!sub) return appended ? HIDDEN_ARGS : null;
    const reason = checkGitCommand(sub, rest, dir, ctx, appended);
    if (reason) return reason;
    // Aliases are expanded one after another, as git does, options included. git ignores an alias that
    // hides one of its own commands: both are checked. A loop stops git with an error, every step checked.
    const alias = ctx.alias(dir, sub, env);
    if (!alias || expanded.includes(sub)) return null;
    if (alias.startsWith("!")) return `git alias "${sub}" runs a shell: write the command in full.`;
    if (expanded.length >= ALIAS_LIMIT) return "too many nested git aliases: write the command in full.";
    expanded.push(sub);
    words = [...words.slice(0, i), ...splitWords(alias), ...rest];
  }
}

/** One git subcommand with its arguments, aliases aside. */
function checkGitCommand(sub, rest, cwd, ctx, appended) {
  if (appended && RISKY_WHEN_APPENDED.has(sub)) return HIDDEN_ARGS;
  const options = rest.filter((a) => a.startsWith("-"));
  const positionals = rest.filter((a) => !a.startsWith("-"));
  if (rest.some((a) => isOption(a, "--no-verify"))) return "--no-verify is not allowed: fix what the hook reports.";

  if (sub === "config") {
    // git config [get|set|unset|…] <key> [value], or the older options --unset, --add…
    const pos = [];
    for (let k = 0; k < rest.length; k++) {
      if (CONFIG_VALUE_OPTIONS.test(rest[k])) k++;
      else if (!rest[k].startsWith("-")) pos.push(rest[k]);
    }
    const action = ["get", "set", "unset", "list", "edit", "rename-section", "remove-section"].includes(pos[0]) ? pos.shift() : null;
    const key = pos[0]?.toLowerCase();
    const sections = !!action?.endsWith("-section") || options.some((o) => /^--(rename|remove)-section$/.test(o));
    const modifies = action === "set" || action === "unset" || sections || (!action && pos.length >= 2) || options.some((o) => /^(--(unset|unset-all|replace-all|add|edit)|-e)$/.test(o));
    // The names written: the key, or both section names of rename-section.
    const names = sections ? pos : pos.slice(0, 1);
    if (modifies && rest.some((a) => /hookspath/i.test(a))) {
      const installs = key === "core.hookspath" && pos[1] === ".githooks" && action !== "unset" && !options.some((o) => /unset|add|replace/.test(o));
      if (!installs) return "core.hooksPath stays on .githooks.";
    }
    if (sections && names.some((n) => /^core$/i.test(n))) return "core.hooksPath stays on .githooks.";
    if (modifies && names.some((n) => /^alias(\.|$)/i.test(n))) return "no new git alias: write the commands in full.";
    if (modifies && names.some((n) => /^include(if)?(\.|$)/i.test(n))) return "no git config include: it could bring in aliases or turn the hooks off.";
    const value = pos[1];
    if (modifies && ((key === "user.name" && value !== OWNER) || (key === "user.email" && value !== EMAIL))) return `the commits of this repository are signed ${OWNER} <${EMAIL}>.`;
    return null;
  }

  if (sub === "commit" || sub === "push" || sub === "merge" || sub === "rebase") {
    if (!ctx.hooks(cwd)) return "the git hooks are not on: run node scripts/rules.mjs install.";
  }

  if (sub === "commit") {
    // -n in a group of short options (before an option that takes a value) = --no-verify.
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      if (a === "--") break;
      if (/^-[mFCcSt]$/.test(a) || /^--(message|file|reuse-message|reedit-message|author|date|template|fixup|squash|trailer)$/.test(a)) k++;
      else if (/^-[a-zA-Z]+$/.test(a) && /^[^mFCcSt]*n/.test(a.slice(1))) return "git commit -n (--no-verify) is not allowed.";
    }
    if (ctx.branch(cwd) === MAIN) return `no commit on ${MAIN}: create a branch (git switch -c feat/<subject>).`;
    return null;
  }

  if (sub === "push") {
    if (options.some((o) => isOption(o, "--mirror", "--all", "--branches", "--tags", "--follow-tags", "--prune"))) return `git push ${options.join(" ")}: push one branch at a time. ${RELEASE}.`;
    const deletes = options.some((o) => o === "-d" || isOption(o, "--delete"));
    const branch = ctx.branch(cwd);
    const refs = positionals.slice(1);
    if (refs.some((x) => EXPANSION.test(x))) return "write the refs to push literally (no variable, brace or wildcard).";
    if (!refs.length && branch === MAIN) return `${MAIN} only receives PRs merged with squash.`;
    for (const ref of refs) {
      const target = (ref.includes(":") ? ref.split(":")[1] || ref.split(":")[0] : ref).replace(/^\+/, "");
      const name = target === "HEAD" ? branch : target.replace(/^refs\/heads\//, "");
      if (name === MAIN) return `${MAIN} only receives PRs merged with squash.`;
      if (target.startsWith("refs/tags/") || /^v\d/.test(target)) return `${RELEASE}.`;
      if (deletes && /^v\d/.test(name)) return `${RELEASE}.`;
    }
    return null;
  }

  if (sub === "tag") {
    if (positionals.some((x) => EXPANSION.test(x)) && !options.some((o) => ["-l", "--list"].includes(o))) return `${RELEASE}.`;
    const reading = ["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify"];
    const writes = options.some((o) => ["-d", "-a", "-s", "-f", "-m", "-F", "-u", "-e"].includes(o) || isOption(o, "--delete", "--annotate", "--sign", "--force", "--local-user", "--message", "--file", "--edit"));
    if (writes || (positionals.length && !options.some((o) => reading.includes(o.split("=")[0]) || /^-n\d*$/.test(o) || o.startsWith("--sort") || o.startsWith("--format")))) return `${RELEASE}.`;
    return null;
  }

  if (sub === "update-ref" && positionals.some((p) => p === `refs/heads/${MAIN}` || p.startsWith("refs/tags/"))) return `refs/heads/${MAIN} and tags are not changed by hand.`;
  return null;
}

// ------------------------------------------------------------ gh

function analyzeGh(args, cwd, ctx, appended = false) {
  const [group, action, ...rest] = args;
  if (appended && (!group || ["api", "release", "repo", "workflow"].includes(group) || (group === "pr" && (!action || ["merge", "create", "edit"].includes(action))))) return HIDDEN_ARGS;
  const a = [action, ...rest].filter(Boolean);
  const valueOf = (...names) => {
    for (let k = 0; k < a.length; k++) {
      const [o, v] = a[k].split(/=(.*)/s);
      if (names.includes(o)) return v ?? a[k + 1];
    }
    return undefined;
  };
  if (group === "pr" && action === "merge") {
    if (rest.includes("--admin")) return "gh pr merge --admin is not allowed: no exception to the rules of main.";
    if (rest.some((o) => ["--merge", "-m", "--rebase", "-r"].includes(o))) return "main is merged with squash only (gh pr merge --squash).";
    if (!rest.some((o) => o === "--squash" || o === "-s")) return "add --squash: main is merged with squash only.";
    if (rest.some((o) => o === "--auto")) return "no --auto: the PR is merged once its CI has been seen, with --match-head-commit.";
    let pr;
    for (let k = 0; k < rest.length; k++) {
      if (/^(-t|--subject|-b|--body|-F|--body-file|-A|--author-email|--match-head-commit|-R|--repo)$/.test(rest[k])) k++;
      else if (!rest[k].startsWith("-")) pr ??= rest[k];
    }
    const state = ctx.pr(pr, valueOf("-R", "--repo"), cwd);
    if (!state) return "cannot read the PR (gh pr view): merge refused to be safe.";
    const rules = state.files.filter((f) => RULE_FILES.test(f));
    if (rules.length) return `this PR changes the repository rules (${rules.join(", ")}): the user merges it on github.com.`;
    // The head that was checked must be the one that gets merged.
    if (valueOf("--match-head-commit") !== state.head) return `add --match-head-commit ${state.head}: the PR is merged exactly as it was just checked.`;
    return null;
  }
  if (group === "pr" && (action === "create" || action === "edit")) {
    const title = valueOf("--title", "-t");
    const reason = title !== undefined && checkTitle(title);
    if (reason) return reason;
    const base = valueOf("--base", "-B");
    if (base && base !== MAIN) return `a PR targets ${MAIN}.`;
    return null;
  }
  if (group === "release" && !["list", "view", "download", "verify", "verify-asset"].includes(action)) return `gh release ${action}: ${RELEASE}.`;
  if (group === "repo" && ["edit", "delete", "rename", "archive", "unarchive", "sync"].includes(action)) return `gh repo ${action}: the repository settings live in scripts/protections.mjs (npm run protections).`;
  if (group === "workflow" && action === "disable") return "the check workflows stay on.";
  if (group === "api") {
    const WITH_VALUE = /^(-X|-H|-f|-F|-q|-t|-p|--method|--header|--field|--raw-field|--jq|--template|--preview|--input|--hostname|--cache)$/;
    let path = "";
    for (let k = 0; k < a.length; k++) {
      if (WITH_VALUE.test(a[k])) k++;
      else if (!a[k].startsWith("-")) {
        path = a[k];
        break;
      }
    }
    const method = (valueOf("-X", "--method") ?? (a.some((x) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x)) ? "POST" : "GET")).toUpperCase();
    if (path === "graphql") {
      const query = a.join(" ");
      if (/mutation/i.test(query) && /(mergePullRequest|enablePullRequestAutoMerge|createRef|updateRefs?|deleteRef|createRelease|updateRelease|deleteRelease|updateRepository|Ruleset|BranchProtection|createCommitOnBranch)/i.test(query)) {
        return "this GraphQL mutation gets around the PR/release flow.";
      }
      return null;
    }
    const sensitive = /(rulesets|protection|immutable-releases|git\/refs|git\/tags|releases|merges|pulls\/\d+\/merge|actions\/permissions|actions\/workflows\/[^/]+\/disable|contents\/|^\/?repos\/[^/]+\/[^/]+\/?$)/;
    if (method !== "GET" && sensitive.test(path)) return `gh api ${method} ${path}: changes the repository outside the PR/release flow (protections: npm run protections).`;
  }
  return null;
}

// ------------------------------------------------------------ analysis

const WRITERS = new Set(["rm", "mv", "cp", "install", "chmod", "chflags", "ln", "unlink", "truncate", "tee", "touch", "dd", "rsync"]);

/** Head and files of a PR, read together. */
const readPr = (pr, repo, cwd) => {
  try {
    const v = JSON.parse(execFileSync("gh", ["pr", "view", ...(pr ? [pr] : []), ...(repo ? ["--repo", repo] : []), "--json", "headRefOid,files"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    return { head: v.headRefOid, files: v.files.map((f) => f.path) };
  } catch {
    return null;
  }
};
/** Definition of a git alias, read with the variables the command sets (HOME, XDG_CONFIG_HOME…). */
const gitAlias = (cwd, name, env = []) => {
  try {
    const vars = Object.fromEntries(env.map((e) => e.split(/=(.*)/s).slice(0, 2)));
    return execFileSync("git", ["-C", cwd, "config", "--get", `alias.${name}`], { env: { ...process.env, ...vars }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};

function checkEnv(env) {
  if (env.some((e) => /hookspath/i.test(e))) return HOOKS_OFF;
  if (env.some((e) => /^GIT_CONFIG/i.test(e) && INJECTED.test(e))) return INJECTED_CONFIG;
  if (env.some((e) => CONFIG_FILE_VARS.test(e))) return "git reads its usual config files: no GIT_CONFIG, GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM.";
  return null;
}

/** Refusal if a written file (command argument or redirection target) is a hook, a rule file or a git config file. */
function writeReason(targets, cwd) {
  for (const target of targets) {
    // The path itself, the part after = (dd of=…, --target-directory=…), and both resolved from the current folder.
    const forms = [target, target.slice(target.indexOf("=") + 1)].flatMap((f) => [f, resolve(cwd, expandHome(f))]);
    if (forms.some((f) => HOOK_PATHS.test(f))) return "the repository's hooks are not changed from the shell: change them in a PR.";
    if (forms.some((f) => GIT_CONFIG_PATHS.test(f))) return "git config files are not edited from the shell: use git config, which is checked.";
  }
  return null;
}

/**
 * Reason to refuse one command given as words, or null. `state.cwd` follows cd from one command to the next;
 * `inherited`: NAME=value set by a launcher; `appended`: xargs or find -exec adds words we do not see.
 */
function analyzeWords(words, state, ctx, depth, inherited = [], appended = false) {
  const env = [...inherited];
  let k = 0;
  while (k < words.length && (ASSIGNMENT.test(words[k]) || WRAPPERS.has(words[k]))) {
    if (ASSIGNMENT.test(words[k])) env.push(words[k]);
    k++;
  }
  const [cmd, ...args] = words.slice(k);
  const name = basename(cmd ?? "");
  const envReason = checkEnv(DECLARATIONS.has(name) ? [...env, ...args.filter((x) => ASSIGNMENT.test(x))] : env);
  if (envReason) return envReason;
  if (!cmd) return null;
  if (name === "cd" && args[0]) state.cwd = resolve(state.cwd, expandHome(args[0]));
  // Writes to the hooks: file commands, sed/perl -i (redirections are checked by analyze).
  const inPlace = (name === "sed" || name === "perl") && args.some((x) => /^-[a-zA-Z]*i/.test(x));
  const write = (WRITERS.has(name) || inPlace) && writeReason(args, state.cwd);
  if (write) return write;

  if (LAUNCHERS[name]) {
    const run = launched(name, args);
    const reason = analyzeWords(run.words, state, ctx, depth, [...env, ...run.env], appended);
    if (reason) return reason;
    // An option missing from the table would hide the command: as before, git or gh further on are checked too.
    const j = args.findIndex((x) => ["git", "gh"].includes(basename(x)));
    if (j < 0 || args.length - j === run.words.length) return null;
    return analyzeWords(args.slice(j), state, ctx, depth, [...env, ...args.slice(0, j).filter((x) => ASSIGNMENT.test(x))], appended);
  }

  // Nested commands: sh -c and eval run a string, xargs and find -exec run words.
  let reason = null;
  if (SHELLS.has(name)) {
    const c = args.findIndex((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    if (c >= 0) reason = analyze(args[c + 1] ?? "", state.cwd, ctx, depth + 1);
  } else if (name === "eval") reason = analyze(args.join(" "), state.cwd, ctx, depth + 1);
  else if (name === "xargs") {
    let j = 0;
    while (j < args.length && args[j].startsWith("-")) j += /^-[IdELnPs]$/.test(args[j]) ? 2 : 1;
    reason = analyzeWords(args.slice(j), state, ctx, depth, [], true);
  } else if (name === "find") {
    for (let e = 0; e < args.length && !reason; e++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[e])) continue;
      let end = args.findIndex((x, j) => j > e && (x === ";" || x === "+"));
      if (end < 0) end = args.length;
      const run = args.slice(e + 1, end);
      reason = analyzeWords(run.filter((x) => x !== "{}"), state, ctx, depth, [], run.includes("{}"));
      e = end;
    }
  }
  if (reason) return reason;

  if (INTERPRETERS.has(name)) {
    const code = args.filter((_, j) => j > 0 && /^(-e|-c|-p|--eval|--print)$/.test(args[j - 1])).join(" ");
    if (/\b(git|gh)\b/.test(code) && /no-verify|hookspath|push|commit|merge|\btag\b|release|\bapi\b|ruleset/i.test(code)) {
      return "git or gh run from inline code: run the command directly, so that it is checked.";
    }
  }
  if (name === "git") return analyzeGit(args, state.cwd, env, ctx, appended);
  if (name === "gh") return analyzeGh(args, state.cwd, ctx, appended);
  return null;
}

/**
 * Reason to refuse the Bash command line, or null if it passes.
 * `ctx` replaces the real state of the repository in tests (hooks on, current branch, PR, aliases).
 */
export function analyze(line, cwd = process.cwd(), ctx = {}, depth = 0) {
  if (depth > 4) return "command too nested to be checked: simplify it.";
  ctx = { hooks: (dir) => !!hooksDir(dir), branch: branchOf, pr: readPr, alias: gitAlias, ...ctx };
  const state = { cwd };
  for (const { words, writes } of parse(line)) {
    const reason = writeReason(writes, state.cwd) ?? analyzeWords(words, state, ctx, depth);
    if (reason) return reason;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // Unreadable input must not let anything through.
    console.error("Repository rule: unreadable hook input, command refused to be safe.");
    process.exit(2);
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") process.exit(0);
  let reason;
  try {
    reason = analyze(command, input.cwd || process.cwd());
  } catch (e) {
    reason = `check failed (${e.message}): command refused to be safe.`;
  }
  if (reason) {
    console.error(`Repository rule: ${reason}`);
    process.exit(2);
  }
}
