# Better Harness

Better Harness est un harness léger pour le CLI `claude`, conçu pour remplacer l'onglet **Code** de Claude Desktop sur un Mac qui sature.

Le moteur ne change pas : c'est le **CLI `claude` officiel**, piloté en `stream-json` exactement comme le fait l'Agent SDK embarqué dans Desktop. Tu gardes donc ton abonnement, les outils, les skills, les hooks, les plugins et les MCP. Seule la couche autour change, pour être beaucoup plus sobre :
- l'interface ;
- la gestion des processus ;
- les serveurs MCP.

Le pourquoi, chiffres à l'appui : [`docs/ANALYSE.md`](docs/ANALYSE.md). Les mesures du harness : [`docs/MESURES.md`](docs/MESURES.md).

## Lancer

Prérequis : Rust ≥ 1.80, Node ≥ 20, et le CLI `claude` installé et connecté (`claude` doit marcher dans un terminal).

```bash
npm install
```

```bash
npm run app
```

`npm run app` lance l'app en mode développement. Pour produire `Better Harness.app` (dans `src-tauri/target/release/bundle/macos/`) :

```bash
npm run bundle
```

Pour tester sans consommer de quota, mets ce chemin dans **Réglages → Chemin du binaire claude** : `scripts/fake-claude.py`. C'est un faux CLI qui parle le même protocole : streaming, appel d'outil, demande de permission et résultat. Un message contenant « long » déclenche 20 s de streaming continu, pour les mesures.

### Diagnostic

- **Journal du protocole.** Lance l'app avec la variable `BH_PROTOCOL_LOG`. Chaque ligne échangée avec le CLI y est écrite, horodatée (`→` envoyé, `←` reçu).

  ```bash
  open --env BH_PROTOCOL_LOG=/tmp/bh-protocol.log "src-tauri/target/release/bundle/macos/Better Harness.app"
  ```

- **CLI muet.** Si le CLI ne répond pas dans les 20 s après son lancement, une notice s'affiche avec la fin de son stderr.
- **Demandes d'accès macOS.** macOS demande l'autorisation la première fois que l'app accède à un dossier protégé (Documents, Bureau…). Avec une signature ad hoc, la demande revient **après chaque rebuild**. Tant que la demande n'a pas reçu de réponse, le CLI attend. Pour éviter ces demandes répétées, signe l'app avec un certificat stable (`bundle.macOS.signingIdentity` dans `tauri.conf.json`).

## Installer

Télécharge `Better-Harness_<version>_universal.dmg` dans les [releases](https://github.com/Kwickos/better-harness/releases/latest). L'app est universelle (Apple Silicon et Intel) et tourne à partir de **macOS 13 Ventura** (13.7.8 compris).

Elle n'est pas notariée par Apple : au premier lancement, fais **clic droit → Ouvrir** sur l'app dans le dossier Applications, ou lance :

```bash
xattr -dr com.apple.quarantine "/Applications/Better Harness.app"
```

## Mises à jour

L'app cherche une nouvelle version 20 s après son lancement, puis toutes les 6 heures. Elle lit `latest.json` dans la dernière release de ce dépôt. Une version trouvée se télécharge en arrière-plan et sa signature est vérifiée. Ensuite, un bouton **Mettre à jour** apparaît en bas de la barre latérale. Si tu ne cliques pas, elle s'installe à la fermeture de l'app. **Réglages → À propos** permet aussi de lancer la recherche à la main.

### Publier une version

Les versions sont publiées depuis ce Mac, sous le compte GitHub **Kwickos** uniquement :

```bash
npm run release -- 0.2.0 "Ce qui change"
```

Le script s'arrête si gh, git ou le remote ne sont pas Kwickos, ou si des modifications ne sont pas commitées. Il fait ensuite, dans l'ordre :

1. il monte la version dans `package.json`, `Cargo.toml` et `tauri.conf.json` ;
2. il construit l'app universelle ;
3. il vérifie que chaque binaire démarre sur macOS 13 ;
4. il signe le paquet de mise à jour avec `~/.tauri/better-harness.key` (mot de passe dans le Trousseau, élément « better-harness updater key ») ;
5. il pousse le commit et le tag, puis crée la release avec le `.dmg`, le `.app.tar.gz` et `latest.json`.

**Sauvegarde la clé et son mot de passe.** Sans eux, les apps déjà installées ne pourront plus se mettre à jour.

Le hook `.githooks/pre-push` refuse tout push vers un autre propriétaire que Kwickos, ou contenant un commit d'un autre auteur. Pour l'activer dans un nouveau clone :

```bash
git config core.hooksPath .githooks
```

## Ce qui le rend léger

- **Pas de Chromium.** L'app utilise le WebKit du système via Tauri. L'UI est en TypeScript sans framework (environ 220 Ko de JS, 75 Ko compressés).
- **Outils allégés.** `Workflow` et `ScheduleWakeup` (utilisé par `/loop`) sont retirés par défaut : environ 5 000 tokens de moins à chaque requête (39 500 → 34 400, mesuré avec `get_context_usage`). Une case dans les Réglages les remet.
- **Streaming coalescé.** Le texte en cours de génération est regroupé côté Rust : 25 envois par seconde au maximum. Il n'est envoyé que pour la session affichée, et seulement quand la fenêtre est visible.
- **Processus à la demande :**
  - aucun processus `claude` n'est lancé avant ton premier message ;
  - au plus *N* processus vivent en même temps (3 par défaut) ;
  - une session inactive est suspendue après *X* minutes (10 par défaut) ;
  - le message suivant la reprend automatiquement via `--resume`.
- **MCP à la carte.** Pour chaque session, tu choisis « configuration standard » ou « seulement ceux cochés » (`--strict-mcp-config`). À la suspension, tout le groupe de processus est tué, serveurs MCP compris.
- **Historique sans tout charger.** La liste lit 64 Ko au début et à la fin de chaque fichier de `~/.claude/projects` ; un transcript se charge en partant de la fin.
- **Compteur mémoire intégré.** En bas à gauche s'affichent la mémoire du cœur Rust et celle de chaque session (CLI + MCP). Les processus WebKit ne sont pas comptés.

## Fonctionnalités

- **Conversations par projet.** La barre latérale regroupe les conversations ouvertes et l'historique de `~/.claude/projects`. L'ordre ne bouge qu'en cas de vraie activité, pas quand tu ouvres une conversation.
- **Nouvelle conversation sans dialogue.** Tu choisis le dossier dans le composer (dossiers récents ou sélecteur natif), tu écris, tu valides. La conversation est créée au premier message.
- **Markdown en direct.** Seul le dernier bloc est recalculé pendant l'écriture.
- **Lignes d'activité.** Les appels d'outils consécutifs se replient, par exemple en « 2 fichiers lus, 1 commande ». Pendant qu'ils tournent, la ligne montre l'étape en cours.
- **Modèle et effort.** Les modèles proposés sont ceux que renvoie le CLI (`initialize`). Il y a 5 niveaux d'effort, appliqués à chaud via `apply_flag_settings`, comme dans Claude Desktop.
- **Conseiller Opus.** Dans le menu du modèle, par conversation : le modèle choisi travaille et consulte Opus aux moments clés (`--advisor opus` au lancement, `advisorModel` à chaud). Désactivé par défaut.
- **Monde des agents.** Au-dessus du champ de saisie, chaque Claude de la conversation est un animal (renard pour Opus, chat pour Sonnet, lapin pour Haiku, chiot pour Fable) qui va au poste de ce qu'il fait et le dit dans une bulle ; les sous-agents arrivent par la porte et reviennent faire leur rapport. Coût mesuré, fenêtre visible : environ +2 % de CPU au repos (4 images par seconde quand tout le monde dort, 12 sinon), rien quand la fenêtre est cachée. Se coupe dans les Réglages.
- **Jauge de contexte.** Le détail par catégorie (`get_context_usage`) est accessible en un clic, ainsi que l'action « Compacter ».
- **Projets.** On les réordonne en glissant leur en-tête (ou `⌥↑` / `⌥↓`), on les replie d'un clic. Un projet replié garde le signal de ses conversations en cours ou en attente.
- **Sans dossier.** Une conversation peut se lancer sans projet : le CLI travaille alors dans un dossier dédié de l'app, regroupé sous « Sans dossier ».
- **Modèle et effort.** Par défaut, ceux que le CLI appliquerait (`model` et `effortLevel` de ses réglages utilisateur, projet et local), sauf choix dans les Réglages. Un choix dans le composer ne vaut que pour la conversation en cours.
- **Modifications** (`⌘⇧D`). Les fichiers modifiés selon Git, avec leur diff, l'affichage dans le Finder et le rétablissement de la dernière version (la version actuelle part à la corbeille). Les outils `Edit` et `Write` montrent aussi leur diff dans les étapes et dans la demande de permission.
- **Mentions.** Dans le composer, `/` propose les skills et commandes que le CLI a chargées, avec leur description ; `@` propose les fichiers et dossiers du projet, les autres projets connus, ou le contenu d'un chemin absolu (`@/Users/…`).
- **Questions et plans.** Quand le modèle pose une question (`AskUserQuestion`), une carte présente les questions une à une : choisir une option, plusieurs, ou écrire sa réponse. Un plan (`ExitPlanMode`) s'affiche en Markdown, à valider ou à refuser.
- **Actions sur les messages.** Au survol : copier et modifier un message envoyé, copier une réponse ou réessayer.
- **Copie.** Un bouton au survol sur les blocs de code, les sorties d'outils, les diffs (le nouveau code) et les journaux.
- **Archives.** Archiver masque une conversation sans toucher à son fichier ; supprimer l'envoie à la corbeille.
- **Titres automatiques.** Le CLI résume le premier message en un titre court, écrit dans son transcript : il reste à la réouverture et se retrouve dans Claude Code. En cas d'échec, le début du message sert de titre.
- **Artefacts** (`⌘⇧A`). Les pages publiées par Claude s'ouvrent dans le panneau, sans session claude.ai quand le fichier HTML est encore là, et sur claude.ai sinon. Le bouton n'apparaît que pour une conversation qui en a. On y change d'artefact, recharge, copie le lien et supprime après confirmation.
- **Simulateur iOS** (`⌘⇧M`). L'écran en direct d'un simulateur dans le panneau de droite : toucher, glisser, gestes depuis les bords (accueil, retour, centre de contrôle) et clavier physique. Une capture se joint au message en un clic. On y démarre et éteint l'appareil, et on passe du clair au sombre. Le pont (`helper/sim-bridge.swift`) ne tourne que pendant que l'onglet est affiché ou que Claude s'en sert, et n'encode une image que si l'écran a changé.
- **Claude pilote le simulateur.** Un outil `mcp__ios-simulator__control` lui permet de voir l'écran, toucher, glisser, écrire, revenir à l'accueil, ouvrir une URL et démarrer un appareil. Chaque action passe par la permission habituelle et le panneau s'ouvre sur l'appareil concerné. Par défaut, l'outil vise l'appareil du panneau ou le seul démarré, jamais un appareil au hasard. Il passe par le canal `stream-json` déjà ouvert : aucun processus de plus par conversation, et le CLI ne charge sa définition que s'il s'en sert. Un interrupteur par conversation se trouve dans l'onglet Serveurs.
- **Navigateur intégré** (`⌘⇧B`). C'est une vraie WKWebView placée dans le panneau de droite, sans accès à l'IPC de l'app. Elle s'écarte quand un dialogue ou un menu passe devant. Un lien `localhost` dans une réponse s'y ouvre.
- **Serveurs** (`⌘⇧S`) :
  - les serveurs de dev viennent de `.claude/launch.json` (même format que Desktop) et des scripts `dev`, `start`, `serve`… de `package.json` ;
  - tu peux les démarrer et les arrêter, chacun dans son propre groupe de processus ;
  - leurs journaux sont visibles en direct, et l'URL locale détectée s'ouvre dans le navigateur intégré ;
  - l'état des serveurs MCP de la conversation s'affiche aussi, avec activation, désactivation et reconnexion.
- **Réglages en sections** (`⌘,`) : Général, Performance, Serveurs MCP et À propos. Chaque changement est enregistré automatiquement.

## Utilisation

| Action | Comment |
|---|---|
| Nouvelle conversation | `⌘N`, l'icône en haut de la barre latérale, ou le `+` d'un projet |
| Rechercher | `⌘K` |
| Envoyer / nouvelle ligne | `Entrée` / `Maj+Entrée` |
| Interrompre | `Échap` |
| Navigateur / serveurs / simulateur / artefacts | `⌘⇧B` / `⌘⇧S` / `⌘⇧M` / `⌘⇧A` |
| Réglages | `⌘,` |
| Libérer la RAM d'une conversation | Menu `⋯` → « Suspendre le processus » (la conversation reste ouverte) |

## Architecture

```
src-tauri/src/
  hub.rs        sessions, processus claude, protocole stream-json, permissions,
                coalescence du streaming, superviseur (suspension auto)
  protocol.rs   traduction des messages du CLI en événements UI compacts
  history.rs    lecture partielle des transcripts ~/.claude/projects
  mcp.rs        liste des serveurs MCP et écriture d'un --mcp-config restreint
  metrics.rs    RAM/CPU par session (arbre de processus)
  shellenv.rs   PATH du shell de login (pour claude, npx, uv…)
  artifacts.rs  aperçu local et suppression des artefacts
  simulator.rs  simulateurs iOS (simctl) et flux du pont helper/sim-bridge.swift
  simulator_tool.rs  outil MCP qui laisse Claude piloter le simulateur
  commands.rs   commandes Tauri
src/
  main.ts       sidebar, en-tête, permissions, dialogues, métriques
  transcript.ts modèle par session + rendu DOM
  markdown.ts   marked + DOMPurify
```

## Limites actuelles

- Ces requêtes de contrôle reçoivent une réponse d'erreur pour ne jamais bloquer le CLI :
  - `hook_callback` (hooks définis par un SDK) ;
  - `elicitation` (formulaires MCP) ;
  - `mcp_message` (serveurs MCP SDK, sauf l'outil simulateur).
- Pas encore de glisser-déposer d'images (une image se joint par mention `@`), ni de partage d'une seule instance de chaque serveur MCP entre sessions.
- Le navigateur intégré sert à l'aperçu. Claude ne peut pas encore le piloter : il faudrait l'exposer au CLI comme serveur MCP.
- Le simulateur passe par les frameworks privés d'Xcode (CoreSimulator, SimulatorKit), testés avec Xcode 27 et iOS 27. Un autre Xcode peut les changer : le pont tourne dans son propre processus, l'app ne plante donc pas et l'onglet affiche une erreur. La rotation n'est pas gérée.
- Claude écrit au simulateur en frappant de vraies touches, sur un appareil en français (AZERTY) ou en anglais américain (QWERTY, pas encore essayé sur un appareil). Ailleurs, ou pour un caractère absent du clavier comme « É », il colle le texte, et iOS demande alors une autorisation que Claude doit accepter.
- L'aperçu local d'un artefact tourne sans son environnement claude.ai : pas de capacités `window.claude.*` ni de données partagées, et `fetch` ne lit pas les fichiers voisins. Le bouton « Ouvrir sur claude.ai » donne la vraie page.
- Seul l'outil du CLI sait supprimer un artefact : l'interface lance pour cela un petit processus Haiku à part, limité à cette seule adresse. La liste ne montre que les artefacts de la conversation ; « Tous mes artefacts » ouvre la galerie sur claude.ai.
- La webview enfant utilise l'API `unstable` de Tauri 2 (`Window::add_child`).
- Le flux de permission `can_use_tool` est implémenté d'après le code de l'Agent SDK. Les trois choix (Autoriser, Toujours autoriser, Refuser) sont testés de bout en bout avec le faux CLI.
- Le vrai CLI est testé jusqu'à la réponse de limite d'utilisation : `init` (31 outils), bannière `rate_limit_event`, résultat en erreur. Un vrai tour de modèle avec outils n'a pas pu être exécuté, car la limite hebdomadaire était atteinte.

## Crédits

- Créatures du monde des agents : [Free Pets Pack](https://frakassets.itch.io/free-pets-pack) par Frakassets, sous licence [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Seuls le renard, le chat, le lapin, le chiot et le hérisson sont repris, en 48 px vue de côté (`src/assets/critters/`).
