# Better Harness

Les règles du dépôt sont dans [CONTRIBUTING.md](CONTRIBUTING.md). Elles sont imposées par GitHub, et un hook bloque les commandes qui les contournent. En bref :

- Ne jamais committer ni pousser sur `main`. Travailler sur la branche de la session (`features/…`) ou sur une branche `<type>/<sujet>`.
- Titre de PR : `<type>: <description>`, avec un type parmi feat, fix, perf, refactor, docs, test, build, ci, chore, revert. Il devient le commit de `main`.
- Commits `Kwickos <Kwickos@users.noreply.github.com>`, sans `Co-authored-by`.
- Merge en squash uniquement (`gh pr merge --squash`).
- Ne pas toucher aux versions, aux tags ni aux releases : seul `npm run release` le fait, et seulement si l'utilisateur le demande.
- Un refus de hook se corrige, il ne se contourne pas : pas de `--no-verify`, pas de changement de `core.hooksPath`.
