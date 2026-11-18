#!/usr/bin/env node
// The repository's GitHub protections, versioned here: the only layer nothing gets around.
// No "bypass actor": even the owner account goes through a PR.
//
//   npm run protections          applies this file as it is on origin/main
//   npm run protections:verify   compares GitHub with this file (the release requires it)

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { channelAccepts, CHANNELS, compareVersions, MAIN, PREFIXES, REPO, VERSION } from "./rules.mjs";

/** ID of the GitHub Actions app: only its checks satisfy the required statuses. */
const GITHUB_ACTIONS = 15368;
/** Jobs of .github/workflows/ (rules.yml, build.yml) that must succeed before a merge. */
export const CHECKS = ["rules", "web", "rust"];

export const SETTINGS = {
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
    name: "branch names",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH", ...CHANNELS.map((c) => `refs/heads/${c}`), ...PREFIXES.map((p) => `refs/heads/${p}/*`), "refs/heads/release/v*"] },
    },
    rules: [{ type: "creation" }],
  },
  {
    // beta and stable only move forward (npm run release pushes them), and never disappear.
    name: "release channels",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: CHANNELS.map((c) => `refs/heads/${c}`), exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }],
  },
  {
    name: "immutable tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    rules: [{ type: "update" }, { type: "deletion" }],
  },
  {
    name: "tag names",
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

/** Is `expected` contained in `actual`? (GitHub adds its own default fields.) */
function contains(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e) => actual.some((a) => contains(e, a)));
  }
  if (expected && typeof expected === "object") return !!actual && typeof actual === "object" && Object.entries(expected).every(([k, v]) => contains(v, actual[k]));
  return expected === actual;
}

/** GitHub's rulesets in detail. A ruleset is found by its name, or by its target if it was renamed. */
function githubRulesets() {
  const details = api([`repos/${REPO}/rulesets`, "--paginate"]).map((r) => api([`repos/${REPO}/rulesets/${r.id}`]));
  return (expected) =>
    details.find((r) => r.name === expected.name) ??
    details.find((r) => r.target === expected.target && contains(expected.conditions, r.conditions) && !RULESETS.some((e) => e.name === r.name));
}

/** Differences between GitHub and this file (empty when everything is in place). */
/** Version tags of GitHub, and the newest one each channel accepts. */
function releaseTags() {
  const tags = api([`repos/${REPO}/tags`, "--paginate", "--slurp"]).flat();
  const newest = (channel) =>
    tags
      .filter((t) => /^v/.test(t.name) && VERSION.test(t.name.slice(1)) && channelAccepts(channel, [t.name]))
      .sort((a, b) => compareVersions(b.name.slice(1), a.name.slice(1)))[0];
  return { tags, newest };
}

/** Commit a channel branch points to on GitHub, or null if it doesn't exist yet. */
function channelSha(channel) {
  try {
    return api([`repos/${REPO}/git/ref/heads/${channel}`]).object.sha;
  } catch {
    return null;
  }
}

export function verify() {
  const gaps = [];
  const repo = api([`repos/${REPO}`]);
  for (const [key, value] of Object.entries(SETTINGS)) if (repo[key] !== value) gaps.push(`setting ${key} = ${repo[key]} (expected ${value})`);
  if (repo.default_branch !== MAIN) gaps.push(`default branch ${repo.default_branch} (expected ${MAIN})`);
  if (!api([`repos/${REPO}/immutable-releases`]).enabled) gaps.push("immutable releases off");
  const find = githubRulesets();
  for (const expected of RULESETS) {
    const actual = find(expected);
    if (!actual) {
      gaps.push(`ruleset "${expected.name}" missing`);
      continue;
    }
    if (actual.name !== expected.name) gaps.push(`ruleset "${actual.name}" to rename to "${expected.name}"`);
    if (actual.enforcement !== "active") gaps.push(`ruleset "${expected.name}": ${actual.enforcement} (expected active)`);
    if (actual.bypass_actors?.length) gaps.push(`ruleset "${expected.name}": ${actual.bypass_actors.length} bypass exception(s)`);
    if (actual.target !== expected.target || !contains(expected.conditions, actual.conditions)) gaps.push(`ruleset "${expected.name}": target changed`);
    for (const rule of expected.rules) {
      const r = actual.rules.find((x) => x.type === rule.type);
      if (!r || !contains(rule.parameters ?? {}, r.parameters ?? {})) gaps.push(`ruleset "${expected.name}": rule ${rule.type} missing or changed`);
    }
  }
  const { tags, newest } = releaseTags();
  for (const channel of CHANNELS) {
    const sha = channelSha(channel);
    // No release of this kind yet: the branch appears with the first one.
    if (!sha) {
      if (newest(channel)) gaps.push(`branch ${channel} missing`);
      continue;
    }
    if (!channelAccepts(channel, tags.filter((t) => t.commit.sha === sha).map((t) => t.name))) gaps.push(`branch ${channel} does not point to a ${channel} release`);
  }
  return gaps;
}

function apply() {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("fetch", "--quiet", "origin", MAIN);
  // Only the merged version counts: a branch cannot weaken the protections.
  // Exception: the very first install, when main does not have this file yet.
  const files = ["scripts/protections.mjs", "scripts/rules.mjs"];
  let first = false;
  try {
    git("cat-file", "-e", `origin/${MAIN}:scripts/protections.mjs`);
  } catch {
    first = true;
  }
  if (!first) {
    try {
      git("diff", "--quiet", `origin/${MAIN}`, "--", ...files);
    } catch {
      throw new Error(`${files.join(" and ")} differ from origin/${MAIN}: merge the PR that changes them first.`);
    }
  } else {
    console.log("first install: protections applied from this branch");
  }

  api([`repos/${REPO}`, "-X", "PATCH"], SETTINGS);
  console.log("repository settings: squash only, branches deleted after merge");
  execFileSync("gh", ["api", "-X", "PUT", `repos/${REPO}/immutable-releases`], { stdio: ["ignore", "ignore", "inherit"] });
  console.log("immutable releases");
  const find = githubRulesets();
  for (const ruleset of RULESETS) {
    const id = find(ruleset)?.id;
    api(id ? [`repos/${REPO}/rulesets/${id}`, "-X", "PUT"] : [`repos/${REPO}/rulesets`, "-X", "POST"], ruleset);
    console.log(`ruleset "${ruleset.name}" ${id ? "updated" : "created"}`);
  }
  const { newest } = releaseTags();
  for (const channel of CHANNELS) {
    if (channelSha(channel)) continue;
    const tag = newest(channel);
    if (!tag) {
      console.log(`branch ${channel}: no ${channel} release yet, it appears with the first one`);
      continue;
    }
    api([`repos/${REPO}/git/refs`, "-X", "POST"], { ref: `refs/heads/${channel}`, sha: tag.commit.sha });
    console.log(`branch ${channel} created at ${tag.name}`);
  }
  const gaps = verify();
  if (gaps.length) throw new Error(`applied, but GitHub still differs:\n- ${gaps.join("\n- ")}`);
  console.log("protections in place");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === "apply") apply();
    else if (command === "verify") {
      const gaps = verify();
      if (gaps.length) throw new Error(`the GitHub protections do not match scripts/protections.mjs:\n- ${gaps.join("\n- ")}`);
      console.log("protections in place");
    } else throw new Error("usage: node scripts/protections.mjs apply|verify");
  } catch (e) {
    console.error(`protections: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
}
