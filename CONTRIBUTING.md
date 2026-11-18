# Règles du dépôt

`main` ne bouge que par une PR mergée en squash. Tout le reste en découle, et rien ne passe à côté : GitHub refuse ce que les hooks laisseraient filer.

## Travailler

1. **Une branche par ajout**, nommée `<type>/<sujet>` : `feat/canal-beta`, `fix/scroll-liste`. Le sujet s'écrit en minuscules, chiffres et tirets.
   - Types : `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
   - `features/…` est le préfixe des sessions de l'app Claude : il est accepté tel quel.
   - `release/v…` est réservé à `npm run release`.
2. **Commits signés `Kwickos <Kwickos@users.noreply.github.com>`**, sans trailer `Co-authored-by`.
3. **Une PR vers `main`** dont le titre suit `<type>: <description>` (ou `<type>(zone): …`), 72 caractères au maximum, sans point final. Ce titre devient le commit de `main`.
4. **La CI doit passer** : `regles` (branche, titre, auteurs, version), `web` (`npm run build`) et `rust` (`cargo check`).
5. **Merge en squash.** La branche est supprimée sur GitHub après le merge.

La version ne change jamais dans une PR ordinaire : seul `npm run release` la monte.

## Publier

Depuis `main` à jour, sur ce Mac :

```bash
npm run release -- 0.2.0 "Ce qui change"
```

```bash
npm run release -- 0.3.0-beta.1 "Ce qui change"
```

```bash
npm run release -- 0.2.0 --dry-run
```

Le script vérifie le compte Kwickos, les hooks et les protections GitHub. Il construit l'app sur une branche `release/v<version>`, puis ouvre la PR `release: v<version>`. Il attend la CI, merge en squash, tague ce commit de `main` et publie la release. Si une étape échoue, la PR est fermée et rien n'est publié. Une fois la PR mergée, relancer la même commande reprend à la publication.

- **Stable** `x.y.z` : la release devient « latest », et les apps installées se mettent à jour.
- **Bêta** `x.y.z-beta.N` : la release est une pré-release, jamais proposée aux apps stables. On l'installe à la main depuis la page des releases. L'app revient ensuite seule sur la stable suivante.

Les tags `v…` et les releases publiées ne se modifient ni ne se suppriment. Une erreur se corrige par une nouvelle version.

## Où c'est appliqué

| Couche | Ce qu'elle fait | Contournable ? |
| --- | --- | --- |
| GitHub (`scripts/protections.mjs`) | `main` : PR obligatoire, squash seul, CI `regles` `web` `rust`, historique linéaire, pas de force-push ni de suppression. Branches : seuls les noms autorisés se créent. Tags : seuls les `v…` se créent, aucun ne bouge ni ne disparaît. Releases immuables. | Non : aucune exception, même pour le propriétaire. |
| CI (`.github/workflows/`) | Contrôles d'une PR, exigés par GitHub avant le merge. | Non. |
| Hooks git (`.githooks/`) | Refusent localement : commit sur `main`, mauvaise identité, `Co-authored-by`, push vers `main`, mauvais nom de branche, tag hors release. | Avec `--no-verify`, mais GitHub refuse ensuite. |
| Sessions Claude (`.claude/settings.json`) | Bloquent `--no-verify`, le débranchement des hooks, les push de `main` ou de tags, les merges hors squash, `--admin`, les releases à la main et les écritures de l'API dans les protections. | Non, pour une session Claude. |

Les hooks s'activent avec `npm install`, et à chaque démarrage d'une session Claude. À la main : `node scripts/regles.mjs installer`.

## Changer une règle

Les règles vivent dans `scripts/regles.mjs`, les protections GitHub dans `scripts/protections.mjs`. On les change par une PR, comme le reste. Une fois la PR mergée :

```bash
npm run protections
```

Le script n'applique que la version mergée sur `main`. `npm run protections:verifier` compare GitHub au fichier, et la release refuse de partir s'ils diffèrent.
