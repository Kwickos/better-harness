// Tests des règles du dépôt et du garde-fou des sessions Claude : node --test scripts/regles.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyser, commandes } from "../.claude/hooks/garde-git.mjs";
import { comparer, verifierBranche, verifierTitre, versionUnique } from "./regles.mjs";

test("noms de branche", () => {
  for (const ok of ["feat/canal-beta", "fix/scroll", "features/regles-travail-release-abe25c", "docs/readme", "release/v0.2.0", "release/v1.0.0-beta.3", "chore/maj.deps"]) {
    assert.equal(verifierBranche(ok), null, ok);
  }
  for (const non of ["main", "canal-beta", "feature/x", "feat/", "feat/Canal", "feat/a b", "feat/a/b", "release/0.2.0", "release/v0.2", "release/v1.0.0-rc.1", "wip/x", `feat/${"a".repeat(60)}`]) {
    assert.notEqual(verifierBranche(non), null, non);
  }
});

test("titres de PR", () => {
  for (const ok of ["feat: canal bêta dans les réglages", "fix(updater): délai de 20 s", "refactor!: nouveau protocole", "release: v0.2.0", "release: v0.3.0-beta.1"]) {
    assert.equal(verifierTitre(ok), null, ok);
  }
  for (const non of ["Ajoute le canal bêta", "feat:pas d'espace", "feature: x", "feat: fin avec point.", "release: 0.2.0", "release(x): v0.2.0", `feat: ${"x".repeat(70)}`, "", undefined]) {
    assert.notEqual(verifierTitre(non), null, String(non));
  }
});

test("ordre des versions", () => {
  assert.ok(comparer("0.2.0", "0.1.0") > 0);
  assert.ok(comparer("0.2.0-beta.1", "0.1.0") > 0);
  assert.ok(comparer("0.2.0", "0.2.0-beta.4") > 0);
  assert.ok(comparer("0.2.0-beta.2", "0.2.0-beta.10") < 0);
  assert.equal(comparer("1.0.0", "1.0.0"), 0);
  assert.throws(() => comparer("1.0", "1.0.0"));
});

test("version identique dans tous les fichiers du dépôt", () => {
  assert.match(versionUnique(), /^\d+\.\d+\.\d+/);
});

test("découpage des commandes shell", () => {
  assert.deepEqual(commandes('cd x && git commit -m "a && b" ; gh pr list | head'), [["cd", "x"], ["git", "commit", "-m", "a && b"], ["gh", "pr", "list"], ["head"]]);
  assert.deepEqual(commandes("echo $(git tag v1)"), [["echo"], ["git", "tag", "v1"]]);
});

// État simulé : hooks actifs, sur une branche de travail.
const ctx = { hooks: () => true, branche: () => "feat/x", alias: () => null, pr: () => ({ head: "abc123", files: ["src/main.ts"] }) };

test("garde-fou : contournements refusés", () => {
  for (const cmd of [
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
    "sh -lc \"git commit --no-verify -m x\"",
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
    "sed -i '' 's/exit 1/exit 0/' .githooks/_regles",
    "tee .claude/settings.json < /dev/null",
    "git commit -nm x",
    "git commit -anm x",
    "git -c core.hooksPath=/dev/null commit -m x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m x",
    "git config core.hooksPath /tmp/vide",
    "git config --unset core.hooksPath",
    "git config unset core.hooksPath",
    "git config set core.hooksPath /tmp",
    "git config --unset user.email",
    "git config user.email autre@example.com",
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
    'gh pr create --title "Ajoute un truc" --body x',
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
    "gh workflow disable regles.yml",
    "gh pr merge 4 --squash --auto --match-head-commit abc123",
    "gh pr merge 4 --squash",
    "gh pr merge 4 --squash --match-head-commit autre",
    "git config alias.st status",
    "git -c alias.x=status x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=x git ci",
    "git push origin {main,feat/x}",
    "git push origin $CIBLE",
    "B=v1.0.0; git tag $B",
    "sudo -u moi git push origin main",
    "env -i git push origin main",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git commit -m x",
    "time git push origin main",
    "command git push origin main",
    "nice -n 5 git commit --no-verify -m x",
    "timeout -k 5 30 git push origin main",
    "echo x > scripts/regles.mjs",
    "eval eval eval eval eval eval git push origin main",
  ]) {
    assert.notEqual(analyser(cmd, "/depot", ctx), null, cmd);
  }
});

test("garde-fou : travail normal autorisé", () => {
  for (const cmd of [
    "git status",
    "git log --oneline -5",
    "git switch -c feat/canal-beta",
    "git push -u origin feat/canal-beta",
    "git push --force-with-lease origin feat/canal-beta",
    "git push origin --delete feat/vieux",
    "git tag",
    "git tag -l 'v*'",
    "git tag --contains HEAD",
    "git config --get core.hooksPath",
    "git config core.hooksPath",
    "git config core.hooksPath .githooks",
    "git config user.name Kwickos",
    "gh pr create --title 'feat: canal bêta' --body 'x'",
    "gh pr merge 3 --squash --match-head-commit abc123",
    "gh pr merge 3 -s --match-head-commit=abc123",
    "gh pr checks 3",
    "gh release list",
    "gh release view v0.1.0",
    "gh api repos/Kwickos/better-harness/rulesets",
    "gh api user --jq .login",
    "gh api -X POST repos/Kwickos/better-harness/issues -f title=x",
    "npm run release -- 0.2.0 --dry-run",
    "npm run protections:verifier",
    "ls .githooks",
    "cat .githooks/pre-push",
    "sed -n 1,20p .githooks/pre-push",
    "bash -c 'git status && git log -1'",
    "node -e 'console.log(1)'",
    "echo ok > /tmp/x",
    "find . -name '*.mjs' -exec grep -l regles {} +",
  ]) {
    assert.equal(analyser(cmd, "/depot", ctx), null, cmd);
  }
});

test("garde-fou : état du dépôt", () => {
  const surMain = { hooks: () => true, branche: () => "main" };
  assert.notEqual(analyser("git commit -m x", "/depot", surMain), null);
  assert.notEqual(analyser("git push", "/depot", surMain), null);
  assert.notEqual(analyser("git push origin HEAD", "/depot", surMain), null);
  const sansHooks = { hooks: () => false, branche: () => "feat/x" };
  assert.notEqual(analyser("git commit -m x", "/depot", sansHooks), null);
  assert.notEqual(analyser("git push -u origin feat/x", "/depot", sansHooks), null);
  assert.equal(analyser("git status", "/depot", sansHooks), null);
});

test("garde-fou : PR illisible ou qui touche aux règles, alias", () => {
  const m = "gh pr merge 2 --squash --match-head-commit abc123";
  assert.notEqual(analyser(m, "/depot", { ...ctx, pr: () => ({ head: "abc123", files: [".github/workflows/regles.yml"] }) }), null);
  assert.notEqual(analyser(m, "/depot", { ...ctx, pr: () => null }), null);
  let demande;
  analyser("gh pr merge -s https://github.com/Kwickos/better-harness/pull/7 -t titre -R Kwickos/better-harness", "/depot", { ...ctx, pr: (pr, repo) => ((demande = [pr, repo]), { head: "x", files: [] }) });
  assert.deepEqual(demande, ["https://github.com/Kwickos/better-harness/pull/7", "Kwickos/better-harness"]);
  const alias = (def) => ({ ...ctx, alias: (_, nom) => (nom === "ci" ? def : null) });
  assert.notEqual(analyser("git ci -m x", "/depot", alias("commit --no-verify")), null);
  assert.notEqual(analyser("git ci", "/depot", alias("!sh -c x")), null);
  assert.equal(analyser("git ci -m x", "/depot", alias("commit")), null);
});
