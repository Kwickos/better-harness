English · [Français](CONTRIBUTING.fr.md)

# Repository rules

`main` only moves through a PR merged with squash. Everything else follows from that, and nothing slips past: GitHub refuses what the hooks would let through.

## Branches

| Branch | What it is | Who moves it |
| --- | --- | --- |
| `main` | Development: every change lands here. | Squash-merged PRs. |
| `beta` | The last published release, beta or stable: what beta testers run. | `npm run release`, for every release. |
| `stable` | The last stable release: what every installed app runs. | `npm run release`, for stable releases. |
| `<type>/<subject>` | One change in progress, deleted once merged. | You, then the PR. |

`beta` and `stable` only move forward, always onto a commit of `main` tagged by a release, and are never deleted. Nobody pushes to them by hand.

## Working

1. **One branch per change**, named `<type>/<subject>`: `feat/beta-channel`, `fix/list-scroll`. The subject is written in lowercase letters, digits and hyphens.
   - Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
   - `features/…` is the prefix of Claude app sessions: it is accepted as is.
   - `release/v…` is reserved for `npm run release`.
2. **Commits signed `Kwickos <126871467+Kwickos@users.noreply.github.com>`**, with no `Co-authored-by` trailer. It is the account's noreply address, the one GitHub uses for squash merges: with any other address, each merge adds a `Co-authored-by`.
3. **A PR to `main`** whose title follows `<type>: <description>` (or `<type>(scope): …`), 72 characters at most, no trailing period. This title becomes the commit on `main`.
4. **The CI must pass**: `rules` (branch, title, authors, version), `web` (`npm run build`) and `rust` (`cargo check`).
5. **Squash merge.** The branch is deleted on GitHub after the merge.

The version never changes in an ordinary PR: only `npm run release` bumps it.

## Issues

An issue starts from one of the three templates: **Bug**, **Enhancement** (new feature or improvement) or **Documentation**. Each template sets its label (`bug`, `enhancement`, `documentation`). Blank issues are turned off. A PR that fixes an issue says so in its description (`Closes #12`).

## Publishing

From an up-to-date `main`, on this Mac:

```bash
npm run release -- 0.2.0 "What changes"
```

```bash
npm run release -- 0.3.0-beta.1 "What changes"
```

```bash
npm run release -- 0.2.0 --dry-run
```

The script checks the Kwickos account, the hooks and the GitHub protections. It builds the app on a `release/v<version>` branch, then opens the `release: v<version>` PR. It waits for the CI, merges with squash, tags that commit of `main`, publishes the release and moves `beta` (and `stable` for a stable version) onto it. If a step fails, the PR is closed and nothing is published. Once the PR is merged, running the same command again resumes at publishing.

- **Stable** `x.y.z`: the release becomes "latest", and installed apps update themselves.
- **Beta** `x.y.z-beta.N`: the release is a pre-release, offered only to apps on the beta channel (Settings → About). Stable apps never see it.

`v…` tags and published releases are never changed or deleted. A mistake is fixed with a new version.

## Where it is enforced

| Layer | What it does | Can it be bypassed? |
| --- | --- | --- |
| GitHub (`scripts/protections.mjs`) | `main`: PR required, squash only, CI `rules` `web` `rust`, linear history, no force-push or deletion. Branches: only allowed names can be created. `beta`, `stable`: forward only, never deleted. Tags: only `v…` can be created, and none moves or disappears. Immutable releases. | No: no exception, not even for the owner. |
| CI (`.github/workflows/`) | Checks of a PR, required by GitHub before the merge. | No. |
| Git hooks (`.githooks/`) | Refuse locally: commit on `main`, wrong identity, `Co-authored-by`, push to `main`, wrong branch name, tag outside a release, `beta` or `stable` moved anywhere but forward onto a release commit. | With `--no-verify`, but GitHub refuses afterwards. |
| Claude sessions (`.claude/settings.json`) | Block `--no-verify`, turning the hooks off (including through `sh -c`, `xargs`, aliases), pushes of `main`, `beta`, `stable` or tags, merges other than squash, `--admin`, hand-made releases and API writes to the protections. A PR that touches the rules is merged by the user on github.com, never by a session. | No, for a Claude session. |

The hooks are turned on by `npm install`, and at the start of every Claude session. By hand: `node scripts/rules.mjs install`.

## Changing a rule

The rules live in `scripts/rules.mjs`, the GitHub protections in `scripts/protections.mjs`. They change through a PR, like everything else. Once the PR is merged:

```bash
npm run protections
```

The script only applies the version merged on `main`. `npm run protections:verify` compares GitHub with the file, and the release refuses to start if they differ.
