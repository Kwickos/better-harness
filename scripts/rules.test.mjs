// Tests of the repository rules and of the Claude session guard: node --test scripts/rules.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyze, commands, parse } from "../.claude/hooks/git-guard.mjs";
import { EMAIL, channelAccepts, checkBranch, checkTitle, compareVersions, singleVersion } from "./rules.mjs";

test("branch names", () => {
  for (const ok of ["feat/beta-channel", "fix/scroll", "features/regles-travail-release-abe25c", "docs/readme", "release/v0.2.0", "release/v1.0.0-beta.3", "chore/bump.deps"]) {
    assert.equal(checkBranch(ok), null, ok);
  }
  for (const no of ["main", "beta-channel", "feature/x", "feat/", "feat/Beta", "feat/a b", "feat/a/b", "release/0.2.0", "release/v0.2", "release/v1.0.0-rc.1", "wip/x", `feat/${"a".repeat(60)}`]) {
    assert.notEqual(checkBranch(no), null, no);
  }
});

test("release channels", () => {
  assert.notEqual(checkBranch("beta"), null);
  assert.notEqual(checkBranch("stable"), null);
  assert.ok(channelAccepts("stable", ["v0.2.0"]));
  assert.ok(!channelAccepts("stable", ["v0.3.0-beta.1"]));
  assert.ok(channelAccepts("beta", ["v0.3.0-beta.1"]));
  assert.ok(channelAccepts("beta", ["v0.2.0"]));
  assert.ok(!channelAccepts("beta", ["essai"]));
  assert.ok(!channelAccepts("stable", []));
  for (const cmd of ["git push origin main:beta", "git push origin HEAD:stable", "git push origin v0.2.0:refs/heads/stable", "git push origin :beta", "git push origin --delete stable", "git push -f origin feat/x:beta"]) {
    assert.notEqual(analyze(cmd, "/repo", ctx), null, cmd);
  }
  assert.notEqual(analyze("git push", "/repo", { ...ctx, branch: () => "beta" }), null);
});

test("PR titles", () => {
  for (const ok of ["feat: beta channel in the settings", "fix(updater): 20 s timeout", "refactor!: new protocol", "release: v0.2.0", "release: v0.3.0-beta.1"]) {
    assert.equal(checkTitle(ok), null, ok);
  }
  for (const no of ["Add the beta channel", "feat:no space", "feature: x", "feat: ends with a period.", "release: 0.2.0", "release(x): v0.2.0", `feat: ${"x".repeat(70)}`, "", undefined]) {
    assert.notEqual(checkTitle(no), null, String(no));
  }
});

test("version order", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
  assert.ok(compareVersions("0.2.0-beta.1", "0.1.0") > 0);
  assert.ok(compareVersions("0.2.0", "0.2.0-beta.4") > 0);
  assert.ok(compareVersions("0.2.0-beta.2", "0.2.0-beta.10") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.throws(() => compareVersions("1.0", "1.0.0"));
});

test("same version in every file of the repository", () => {
  assert.match(singleVersion(), /^\d+\.\d+\.\d+/);
});

test("splitting shell commands", () => {
  assert.deepEqual(commands('cd x && git commit -m "a && b" ; gh pr list | head'), [["cd", "x"], ["git", "commit", "-m", "a && b"], ["gh", "pr", "list"], ["head"]]);
  assert.deepEqual(commands("echo $(git tag v1)"), [["echo"], ["git", "tag", "v1"]]);
  // Redirections are not words of the command; output targets are kept apart.
  assert.deepEqual(parse("git log 2>&1 >out.txt | head"), [{ words: ["git", "log"], writes: ["1", "out.txt"] }, { words: ["head"], writes: [] }]);
  assert.deepEqual(parse("echo x>a &>>b >|c <in"), [{ words: ["echo", "x"], writes: ["a", "b", "c"] }]);
  assert.deepEqual(commands('git commit -m ">" -m "a;b" 2> /dev/null'), [["git", "commit", "-m", ">", "-m", "a;b"]]);
});

// Simulated state: hooks on, on a work branch.
const ctx = { hooks: () => true, branch: () => "feat/x", alias: () => null, pr: () => ({ head: "abc123", files: ["src/main.ts"] }) };

test("guard: workarounds refused", () => {
  for (const cmd of [
    "find . -name x -exec git push origin refs/heads/{} \\;",
    "echo main | xargs -o git push origin",
    "echo main | xargs --max-args 1 git push origin",
    "echo v1 | xargs -J % git tag %",
    "git commit --no-verify -m x",
    "git commit --no-verif -m x",
    "git push --no-ver origin feat/x",
    "git push --mirr",
    "git push --tag",
    "git push --dele origin v0.1.0",
    "git tag --del v0.1.0",
    "git -c alias.ci='commit --no-verify' ci -m x",
    "git config alias.ci '!git commit --no-verify'",
    "bash -c 'git push origin main'",
    'sh -lc "git commit --no-verify -m x"',
    "eval git push origin main",
    "echo v0.2.0 | xargs git tag",
    "echo main | xargs -I{} git push origin {}",
    "find . -name x -exec git push origin main \\;",
    "timeout 30 git push origin main",
    "{ git push origin main; }",
    "if true; then git push origin main; fi",
    "node -e \"require('child_process').execSync('git push origin main')\"",
    "python3 -c 'import os; os.system(\"git commit --no-verify -m x\")'",
    "echo '' > .githooks/pre-commit",
    "printf x >>.githooks/pre-push",
    "cp /dev/null .githooks/pre-push",
    "sed -i '' 's/exit 1/exit 0/' .githooks/_rules",
    "tee .claude/settings.json < /dev/null",
    "git commit -nm x",
    "git commit -anm x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m x",
    "git config core.hooksPath /tmp/empty",
    "git config --unset core.hooksPath",
    "git config unset core.hooksPath",
    "git config set core.hooksPath /tmp",
    "git config --unset user.email",
    "git config user.email other@example.com",
    "rm -rf .githooks",
    "chmod -x .githooks/pre-push",
    "git push origin main",
    "git push origin HEAD:main",
    "git push -f origin feat/x:refs/heads/main",
    "git push --delete origin main",
    "git push origin :main",
    "git push --tags",
    "git push --mirror",
    "git push origin v0.2.0",
    "git push origin refs/tags/v0.2.0",
    "git push origin :refs/tags/v0.1.0",
    "git tag v0.2.0",
    "git tag -d v0.1.0",
    "git tag -a v0.2.0 -m x",
    "rtk git push --no-verify",
    "cd /tmp && git push origin main",
    "gh pr merge 3 --admin --squash",
    "gh pr merge 3 --merge",
    "gh pr merge 3 --rebase",
    "gh pr merge 3",
    'gh pr create --title "Add a thing" --body x',
    "gh pr create --base dev --title 'feat: x'",
    "gh release create v0.2.0 a.dmg",
    "gh release delete v0.1.0",
    "gh release upload v0.1.0 a.dmg",
    "gh repo edit --enable-merge-commit",
    "gh api -X DELETE repos/Kwickos/better-harness/rulesets/1",
    "gh api repos/Kwickos/better-harness/rulesets -f name=x",
    "gh api --method PUT repos/Kwickos/better-harness/rulesets/1 --input r.json",
    "gh api -X PATCH repos/Kwickos/better-harness -F allow_merge_commit=true",
    "gh api -X DELETE repos/Kwickos/better-harness/immutable-releases",
    "gh api -X POST repos/Kwickos/better-harness/git/refs -f ref=refs/heads/main",
    "gh api -X PUT repos/Kwickos/better-harness/pulls/3/merge",
    "gh api graphql -f query='mutation { mergePullRequest(input:{}) { clientMutationId } }'",
    "gh workflow disable rules.yml",
    "gh pr merge 4 --squash --auto --match-head-commit abc123",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }'",
    "gh pr merge 4 --squash",
    "gh pr merge 4 --squash --match-head-commit other",
    "git config alias.st status",
    "git -c alias.x=status x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=x git ci",
    "git push origin {main,feat/x}",
    "git push origin $TARGET",
    "B=v1.0.0; git tag $B",
    "sudo -u me git push origin main",
    "env -i git push origin main",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m x",
    "time git push origin main",
    "command git push origin main",
    "nice -n 5 git commit --no-verify -m x",
    "timeout -k 5 30 git push origin main",
    "echo x > scripts/rules.mjs",
    "eval eval eval eval eval eval git push origin main",
  ]) {
    assert.notEqual(analyze(cmd, "/repo", ctx), null, cmd);
  }
});

test("guard: normal work allowed", () => {
  for (const cmd of [
    "git status",
    "git log --oneline -5",
    "git switch -c feat/beta-channel",
    "git push -u origin feat/beta-channel",
    "git push --force-with-lease origin feat/beta-channel",
    "git push origin --delete feat/old",
    "git tag",
    "git tag -l 'v*'",
    "git tag --contains HEAD",
    "git config --get core.hooksPath",
    "git config core.hooksPath",
    "git config core.hooksPath .githooks",
    "git config user.name Kwickos",
    "gh pr create --title 'feat: beta channel' --body 'x'",
    "gh pr merge 3 --squash --match-head-commit abc123",
    "gh pr merge 3 -s --match-head-commit=abc123",
    "gh pr checks 3",
    "gh release list",
    "gh release view v0.1.0",
    "gh api repos/Kwickos/better-harness/rulesets",
    "gh api user --jq .login",
    "gh api -X POST repos/Kwickos/better-harness/issues -f title=x",
    "npm run release -- 0.2.0 --dry-run",
    "npm run protections:verify",
    "ls .githooks",
    "cat .githooks/pre-push",
    "sed -n 1,20p .githooks/pre-push",
    "bash -c 'git status && git log -1'",
    "node -e 'console.log(1)'",
    "echo ok > /tmp/x",
    "find . -name '*.mjs' -exec grep -l rules {} +",
  ]) {
    assert.equal(analyze(cmd, "/repo", ctx), null, cmd);
  }
});

test("guard: repository state", () => {
  const onMain = { hooks: () => true, branch: () => "main" };
  assert.notEqual(analyze("git commit -m x", "/repo", onMain), null);
  assert.notEqual(analyze("git push", "/repo", onMain), null);
  assert.notEqual(analyze("git push origin HEAD", "/repo", onMain), null);
  // A redirection is not a ref to push.
  assert.notEqual(analyze("git push 2>&1", "/repo", onMain), null);
  assert.notEqual(analyze("git push > /tmp/log", "/repo", onMain), null);
  const noHooks = { hooks: () => false, branch: () => "feat/x" };
  assert.notEqual(analyze("git commit -m x", "/repo", noHooks), null);
  assert.notEqual(analyze("git push -u origin feat/x", "/repo", noHooks), null);
  assert.equal(analyze("git status", "/repo", noHooks), null);
});

test("guard: unreadable PR or PR that touches the rules, aliases", () => {
  const m = "gh pr merge 2 --squash --match-head-commit abc123";
  assert.notEqual(analyze(m, "/repo", { ...ctx, pr: () => ({ head: "abc123", files: [".github/workflows/rules.yml"] }) }), null);
  assert.notEqual(analyze(m, "/repo", { ...ctx, pr: () => ({ head: "abc123", files: ["scripts/rules.mjs"] }) }), null);
  assert.notEqual(analyze(m, "/repo", { ...ctx, pr: () => null }), null);
  let asked;
  analyze("gh pr merge -s https://github.com/Kwickos/better-harness/pull/7 -t title -R Kwickos/better-harness", "/repo", { ...ctx, pr: (pr, repo) => ((asked = [pr, repo]), { head: "x", files: [] }) });
  assert.deepEqual(asked, ["https://github.com/Kwickos/better-harness/pull/7", "Kwickos/better-harness"]);
  const alias = (def) => ({ ...ctx, alias: (_, name) => (name === "ci" ? def : null) });
  assert.notEqual(analyze("git ci -m x", "/repo", alias("commit --no-verify")), null);
  assert.notEqual(analyze("git ci", "/repo", alias("!sh -c x")), null);
  assert.equal(analyze("git ci -m x", "/repo", alias("commit")), null);
});

test("guard: launchers, the whole rest of the command is checked", () => {
  for (const cmd of [
    "sudo tee .githooks/pre-push < /dev/null",
    "sudo -E -u root cp /dev/null .githooks/pre-push",
    "sudo sh -c 'git push origin main'",
    "sudo -iu root bash -c 'git commit --no-verify -m x'",
    "env bash -c 'git push origin main'",
    "env FOO=1 eval git push origin main",
    "nice -n 5 rm -rf .githooks",
    "nice -10 sed -i '' s/1/0/ .githooks/_rules",
    "nohup tee -a .claude/settings.json",
    "command -p cp /dev/null .claude/hooks/git-guard.mjs",
    "time node -e \"require('child_process').execSync('git push origin main')\"",
    "timeout 30 python3 -c 'import os; os.system(\"git push origin main\")'",
    "timeout --signal=KILL 30s xargs git tag",
    "exec -a x git push origin main",
    "env -C /tmp git push origin main",
    "env -S 'git push origin main'",
    "env --split-string='git commit --no-verify -m x'",
    "env -u HOME GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit git ci -m x",
    "sudo GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/tmp'\" git commit -m x",
    "stdbuf -o0 git push origin main",
    "stdbuf -o L git push origin main",
    "caffeinate -t 5 git push origin main",
    "arch -arch arm64 git push origin main",
    "arch -arm64 sh -c 'git push origin main'",
    "xcrun git push origin main",
    "xcrun -sdk macosx git push origin main",
    "noglob git push origin main",
    "repeat 2 git push origin main",
    "doas -u root git push origin main",
    "sudo nice timeout 5 env A=1 git push origin main",
    "function f { git push origin main; }",
    // An unknown option that takes a value: git further on is still checked.
    "sudo --unknown-option value git push origin main",
  ]) {
    assert.notEqual(analyze(cmd, "/repo", ctx), null, cmd);
  }
  for (const cmd of ["sudo -u me ls", "env FOO=1 npm test", "timeout 30 npm test", "nice -n 5 git status", "env -i git status", "time git log -1", "command -v git", "sudo -u me cat .githooks/pre-push"]) {
    assert.equal(analyze(cmd, "/repo", ctx), null, cmd);
  }
});

test("guard: nested commands keep their words", () => {
  // Words are passed on as they are, never joined and split again.
  for (const cmd of ["nice git commit -m 'x;git' push origin main", "sudo git commit -m \"a && b | c\"", "env git tag -l 'v*'", "timeout 5 git log --format='%h %s'"]) {
    assert.equal(analyze(cmd, "/repo", ctx), null, cmd);
  }
  // A quoted > is a word, not a redirection.
  assert.notEqual(analyze("git commit -m '>' --no-verify", "/repo", ctx), null);
  assert.notEqual(analyze("sudo git commit -m '>' --no-verify", "/repo", ctx), null);
  // xargs and find -exec add words we do not see.
  for (const cmd of ["echo push origin main | xargs git", "echo --no-verify | xargs git commit -m x", "echo 3 --admin | xargs gh pr merge", "echo merge 3 | xargs gh pr", "find . -name x -exec git commit {} \\;", "ls | xargs sudo git push"]) {
    assert.notEqual(analyze(cmd, "/repo", ctx), null, cmd);
  }
  for (const cmd of ["ls | xargs git add", "git ls-files | xargs -n1 git log -1 --", "echo 3 | xargs gh pr view", "find . -name '*.ts' -exec git add {} +"]) {
    assert.equal(analyze(cmd, "/repo", ctx), null, cmd);
  }
  const ci = { ...ctx, alias: (_, name) => (name === "ci" ? "commit" : null) };
  assert.notEqual(analyze("echo --no-verify | xargs git ci", "/repo", ci), null);
});

test("guard: git aliases resolved like git does", () => {
  const aliases = (defs) => ({ ...ctx, alias: (_, name) => defs[name] ?? null });
  // Chains.
  assert.notEqual(analyze("git a -m x", "/repo", aliases({ a: "b", b: "commit --no-verify" })), null);
  assert.notEqual(analyze("git a main", "/repo", aliases({ a: "b origin", b: "push" })), null);
  assert.notEqual(analyze("git a", "/repo", aliases({ a: "b", b: "!git push origin main" })), null);
  assert.equal(analyze("git a -m x", "/repo", aliases({ a: "b", b: "commit" })), null);
  // A loop stops git with an error; a chain too long to follow is refused.
  assert.equal(analyze("git a", "/repo", aliases({ a: "b", b: "a" })), null);
  const chain = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`a${n}`, `a${n + 1}`]));
  assert.notEqual(analyze("git a0", "/repo", aliases(chain)), null);
  // git ignores an alias that hides one of its commands: the command itself is checked.
  assert.notEqual(analyze("git push origin main", "/repo", aliases({ push: "status" })), null);
  assert.equal(analyze("git status", "/repo", aliases({ status: "status -sb" })), null);
  // Options inside an alias are checked like the others.
  assert.notEqual(analyze("git x -m y", "/repo", aliases({ x: "-c core.hooksPath=/dev/null commit" })), null);
  assert.notEqual(analyze("git x", "/repo", aliases({ x: "commit -m '>' --no-verify" })), null);
  // The alias is read with the variables the command sets.
  const home = { ...ctx, alias: (_, name, env) => (name === "ci" && env.includes("HOME=/tmp/h") ? "commit --no-verify" : null) };
  assert.notEqual(analyze("HOME=/tmp/h git ci -m x", "/repo", home), null);
  assert.equal(analyze("git ci -m x", "/repo", home), null);
});

test("guard: includes and git config files", () => {
  for (const cmd of [
    "git -c include.path=/tmp/x commit -m x",
    "git -c includeIf.onbranch:feat/x.path=/tmp/x status",
    "git --config-env=include.path=X status",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/x git status",
    "GIT_CONFIG_PARAMETERS=\"'include.path'='/tmp/x'\" git status",
    "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=x; git ci",
    "declare -x GIT_CONFIG_KEY_0=include.path",
    "GIT_CONFIG_GLOBAL=/tmp/x git ci -m x",
    "export GIT_CONFIG_SYSTEM=/tmp/x",
    "git config include.path /tmp/x",
    "git config --global include.path /tmp/x",
    "git config set includeIf.gitdir:~/src/.path /tmp/x",
    "git config --file .git/config alias.ci 'commit --no-verify'",
    "git config -f ~/.gitconfig user.email other@example.com",
    "git config rename-section foo alias",
    "git config --rename-section foo include",
    "git config --remove-section core",
    "echo '[core]' >> .git/config",
    "printf x > ~/.gitconfig",
    'tee -a "$HOME/.gitconfig"',
    "cp /tmp/x .git/worktrees/w/config.worktree",
    "mv /tmp/x /Users/me/repo/.git/config",
    "sed -i '' 's/x/y/' .git/config",
    "cd .git && echo x >> config",
    "cd .githooks && rm pre-push",
    "echo x > ~/.config/git/config",
    "echo x>.githooks/pre-commit",
    "echo x >| .githooks/pre-push",
    "echo x &> .githooks/pre-push",
    "echo x >& .githooks/pre-push",
    "dd if=/dev/null of=.githooks/pre-push",
  ]) {
    assert.notEqual(analyze(cmd, "/repo", ctx), null, cmd);
  }
  for (const cmd of ["cat .git/config", "git config --get alias.st", "git config --list", "git config --get-regexp alias", "cat ~/.gitconfig", "echo x > /tmp/config", "grep x .git/config > /tmp/out", "git log 2>&1 | head", "GIT_CONFIG_GLOBAL=/dev/null git status", "GIT_CONFIG_NOSYSTEM=1 git status"]) {
    assert.equal(analyze(cmd, "/repo", ctx), null, cmd);
  }
});

test("pre-push: release channels move forward, onto release commits of main", () => {
  const dir = mkdtempSync(join(tmpdir(), "bh-channels-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Kwickos");
    git("config", "user.email", EMAIL);
    const commit = (message, tag) => {
      git("commit", "-q", "--allow-empty", "-m", message);
      if (tag) git("tag", tag);
      return git("rev-parse", "HEAD");
    };
    const [stable, beta, untagged] = [commit("A", "v0.1.0"), commit("B", "v0.2.0-beta.1"), commit("C")];
    git("update-ref", "refs/remotes/origin/main", untagged);
    const zero = "0".repeat(40);
    const rules = fileURLToPath(new URL("./rules.mjs", import.meta.url));
    const accepted = (line) =>
      spawnSync(process.execPath, [rules, "pre-push", "origin", "https://github.com/Kwickos/better-harness.git"], { cwd: dir, input: `${line}\n`, encoding: "utf8" }).status === 0;
    assert.ok(accepted(`refs/heads/stable ${stable} refs/heads/stable ${zero}`), "stable created on a stable release");
    assert.ok(!accepted(`refs/heads/stable ${beta} refs/heads/stable ${stable}`), "stable never takes a beta");
    assert.ok(accepted(`refs/heads/beta ${beta} refs/heads/beta ${stable}`), "beta moves to a beta release");
    assert.ok(!accepted(`refs/heads/beta ${untagged} refs/heads/beta ${beta}`), "no channel on an untagged commit");
    assert.ok(!accepted(`refs/heads/beta ${stable} refs/heads/beta ${beta}`), "channels never move back");
    assert.ok(!accepted(`(delete) ${zero} refs/heads/beta ${beta}`), "channels are never deleted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
