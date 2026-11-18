# Better Harness

The repository rules are in [CONTRIBUTING.md](CONTRIBUTING.md). GitHub enforces them, and a hook blocks the commands that get around them. In short:

- Never commit or push to `main`. Work on the session's branch (`features/…`) or on a `<type>/<subject>` branch.
- `beta` and `stable` are release channels: only `npm run release` moves them. Never push to them.
- PR title: `<type>: <description>`, with a type among feat, fix, perf, refactor, docs, test, build, ci, chore, revert. It becomes the commit on `main`.
- Commits by `Kwickos <126871467+Kwickos@users.noreply.github.com>`, without `Co-authored-by`.
- Squash merge only (`gh pr merge --squash`).
- Do not touch versions, tags or releases: only `npm run release` does it, and only when the user asks.
- A hook refusal gets fixed, not bypassed: no `--no-verify`, no change to `core.hooksPath`.
- Write code, comments, commits, PR titles and docs in English. User-visible UI strings go through `t()` in `src/i18n.ts`, with the French in `src/locales/fr.ts`. Rust messages the user sees use `tr(en, fr)` from `src-tauri/src/i18n.rs`; text sent to the model stays English.
