# Mesures : Better Harness vs Claude Desktop

Machine : MacBook Pro M1 Pro (8 cœurs), 16 Go de RAM, macOS 27.0.1. Mesures du 7 novembre 2026.

Outils :
- `top -stats pid,command,cpu,mem`. La colonne MEM est l'empreinte physique, la même métrique que le Moniteur d'activité.
- `ps` (RSS) pour les instantanés.

Les mesures du harness ont été faites avec `scripts/fake-claude.py`, parce que le quota du compte était épuisé. Le coût du vrai CLI est donné à part.

**À lire avec prudence :**
- Desktop tournait en même temps : c'est lui qui affichait la session qui a écrit ce code.
- WindowServer, partagé par toutes les apps, n'est pas attribuable à un processus.

## Taille

| | Claude Desktop 4.23118.0 | Better Harness 0.1.0 |
|---|---:|---:|
| Application | 649 Mo | **3,5 Mo** |
| Copies du CLI propres à l'app | 575 Mo (2.1.309 + 2.1.317) | 0 (le CLI déjà installé est réutilisé) |
| JS de l'interface | ~13 Mo pour le main process, plus l'app web claude.ai | **98 Ko** |

## Au repos (aucune génération en cours)

| | CPU | Mémoire |
|---|---:|---:|
| Claude Desktop (main + renderer + GPU + helpers), 4 sessions Code ouvertes | 8–55 % selon l'activité | 1,3 Go (RSS) |
| … plus les 4 processus CLI de ces sessions | ~0 % | 810 Mo, plus ~160 Mo de serveurs MCP |
| **Better Harness** (cœur + WebContent + GPU + Networking), 2 sessions ouvertes et suspendues | **0,0 %** | **≈ 97–122 Mo** |
| … processus CLI | 0 (suspendus : aucun processus) | **0** |

Le harness consommait d'abord ~1,5 % CPU au repos : le compteur mémoire interrogeait la table des processus toutes les 4 s. Cette mesure ne tourne plus que toutes les 10 s, et seulement quand la fenêtre a le focus.

## Pendant le streaming (fenêtre visible, ≈80 deltas/s pendant 20 s)

| | CPU moyen | Mémoire |
|---|---:|---:|
| Desktop : renderer + GPU (mesuré au même moment, en train d'afficher sa propre session) | ≈ 40 % (19 % + 21 %) | ≈ 1,1 Go |
| Desktop : mesure initiale pendant une génération (cf. ANALYSE.md) | ≈ 62 % (45 % + 17 %), plus 8,5 % pour le main | 1,6 Go |
| **Better Harness v1** (un nœud texte par delta, flush toutes les 40 ms) | 21 % | WebContent jusqu'à 180 Mo |
| **Better Harness actuel** (paragraphes figés, flush toutes les 50 ms) | **17,6 %** (cœur 3,8 + WebContent 7,6 + GPU 6,2) | pic WebContent 182 Mo, **retour à 61 Mo** après le message |

Quand la fenêtre est masquée ou réduite, ou qu'une autre session est affichée, le harness n'envoie **aucun** delta : seul le message final est rendu. Le coût du rendu tombe alors à zéro.

## Processus CLI

| | Desktop | Better Harness |
|---|---|---|
| Processus par session ouverte | 1, gardé tant que la session reste ouverte (137–349 Mo) | 0 avant le premier message ; suspendu après 10 min d'inactivité ; 3 vivants au maximum |
| Serveurs MCP | toute la configuration relancée dans chaque session (~40 Mo par session ici) | au choix pour chaque session ; vrai CLI sans MCP : **176 Mo**, 0 processus enfant |
| Arrêt | `disclaimer --pgroup` | fermeture de stdin, puis SIGTERM et SIGKILL du **groupe** (CLI + MCP) ; vérifié à la suspension et à la fermeture de l'app |

## Ce qui n'est pas mesuré

- **La part de WindowServer.** Elle est sans doute plus faible pour le harness (pas d'animation, 20 rafraîchissements/s au maximum), mais ce n'est pas mesuré.
- **Un vrai streaming du modèle.** Quota épuisé ; le faux CLI reproduit le débit et le format des événements.
