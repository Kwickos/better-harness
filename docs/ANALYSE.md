# Analyse de Claude Desktop : pourquoi il consomme autant

Les relevés ont été faits le 7 novembre 2026 sur un MacBook Pro M1 Pro (8 cœurs, 16 Go de RAM), sous macOS 27.0.1, avec Claude Desktop **4.23118.0**.
Les outils utilisés sont REA (`analyze_javascript_application` sur `app.asar`), une extraction manuelle de l'ASAR et du binaire Bun, puis `ps`, `top` et `vm_stat`.

Chaque constat est marqué d'un tag :
- **[observé]** : vu directement dans le binaire ou sur la machine ;
- **[inféré]** : déduit des observations, sans preuve directe ;
- **[inconnu]** : pas vérifié.

## 1. Architecture

```
Claude.app (Electron 4.23118.0)
├── main process  (.vite/build/index.pre.js → index.chunk-*.js, ~13 Mo de JS)
│   ├── WebContentsView « mainView » : l'UI (chat + onglet Code)
│   ├── workers : file-index, heavy-work, transcript-search, pty-host,
│   │             shell-path, stall-sampler, mcp-runtime/directMcpHost
│   ├── Agent SDK embarqué (index.chunk-CqnLpjST.js)
│   │     └── pour CHAQUE session Code :
│   │         disclaimer --pgroup -- …/claude-code/2.1.317/…/claude
│   │              --output-format stream-json --verbose --input-format stream-json …
│   │              ├── serveur MCP rea          (npm exec → node)
│   │              ├── serveur MCP touchdesigner (npm exec → node)
│   │              └── serveur MCP blender      (uv → python)
│   └── serveurs MCP côté chat (StudioMCP ×2, rea ×2, blender ×2…)
├── Claude Helper (GPU)
├── Claude Helper (Renderer) ×2
└── Claude Helper (Network, Audio, Video capture, Plugin…)
```

- **[observé]** L'onglet Code ne contient pas d'agent propre. Le main process embarque l'**Agent SDK**, qui lance pour chaque session un binaire `claude` séparé en mode `stream-json`. On trouve la construction des arguments dans `index.chunk-CqnLpjST.js` (`["--output-format","stream-json","--verbose","--input-format","stream-json"]`, `--permission-prompt-tool=stdio`, `--resume`, `--thinking`, `--effort`…). Preuve REA : `ev_bb4a6abe1b97…`. Ces processus apparaissent aussi dans `ps`.
- **[observé]** Desktop télécharge **ses propres copies du CLI** dans `~/Library/Application Support/Claude/claude-code/` : 2.1.309 (263 Mo) et 2.1.317 (312 Mo). Elles s'ajoutent aux versions de `~/.local/share/claude/versions` (1,2 Go pour 4 versions).
- **[observé]** Le CLI est un exécutable **Bun** de 307 Mo. Sa section Mach-O `__BUN` (186 Mo) contient 3 147 modules : 2 900 fichiers JS, soit 54,7 Mo de source, plus environ 108 Mo de bytecode JSC précompilé. Le point d'entrée est `/$bunfs/root/cli`.
- **[observé]** La fenêtre principale est servie par le protocole personnalisé `app://localhost`, avec 36 références à `https://claude.ai` dans le main process. **[inféré]** L'UI du chat et de l'onglet Code est donc l'application web claude.ai (React), rendue par Chromium.

## 2. Où partent le CPU et la RAM

Mesures faites pendant qu'une session Code streamait une réponse (`top`, 4 × 4 s) :

| Processus | CPU | RAM |
|---|---:|---:|
| Claude Helper (Renderer) : l'UI web | **45 %** | **893 Mo** |
| WindowServer (compositing macOS) | **50 %** | 551 Mo |
| Claude Helper (GPU) | **17 %** | 305 Mo |
| Claude (main process) | 8,5 % | 435 Mo |
| `claude` CLI de la session active | 4,2 % | 283 Mo |

État de la machine au même moment **[observé]** :
- 4 sessions CLI ouvertes, qui pèsent entre 137 et 349 Mo chacune ;
- environ 40 Mo de serveurs MCP **dupliqués par session** ;
- l'ensemble des processus Claude.app consomme 1,3 Go et 55 % CPU ;
- le swap atteint **2,9 Go sur 4 Go**.

Conclusions :
1. **[observé]** Le coût principal vient du **rendu**, pas de l'agent. Pendant le streaming, le renderer et le GPU de Desktop consomment environ 62 % CPU, contre 4 % pour le CLI qui fait le vrai travail. WindowServer, à 50 %, se partage avec les autres apps et n'est donc pas compté. **[inféré]** Une bonne part de ce coût vient tout de même du compositing de Desktop.
2. **[observé]** Il y a **un processus CLI par session ouverte**, même inactive. Chacun garde 150 à 350 Mo, et Desktop ne les suspend pas tant que la session reste ouverte.
3. **[observé]** **Tous les serveurs MCP stdio sont relancés dans chaque session**, souvent via `npx -y …`, qui résout le paquet à chaque démarrage. Les connecteurs claude.ai et les outils MCP alourdissent aussi le contexte, car les définitions d'outils coûtent des tokens.
4. **[observé]** `backgroundThrottling` est désactivé pour la mainView dans plusieurs cas : popouts visibles, verrou computer-use, démarrage, capture d'écran (`mainView backgroundThrottling disabled (visible popouts: …)`). Dans ces cas, l'UI continue de se rendre à plein régime même en arrière-plan.
5. **[observé]** Il y a aussi un coût disque : `~/Library/Application Support/Claude` pèse **14 Go**, dont 11 Go dans `vm_bundles`, et `~/.claude/projects` **5,8 Go** de transcripts (jusqu'à 133 Mo par session).

## 3. Protocole du CLI (vérifié)

- Lancement : `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`.
- Le client envoie d'abord `{"type":"control_request","request_id":…,"request":{"subtype":"initialize"}}`. La réponse est un `control_response` qui contient les commandes et skills disponibles. **[observé en direct]**
- Le CLI émet ensuite `system:init` (session_id, tools, mcp_servers, model), `system:status`, `rate_limit_event`, `stream_event` (deltas), `assistant`, `user` (tool_result) et `result`. **[observé en direct]**
- Permissions : le CLI envoie un `control_request` `can_use_tool` (tool_name, input, tool_use_id, permission_suggestions…). La réponse attendue est `control_response{subtype:"success", response:{behavior:"allow", updatedInput, toolUseID}}` ou `{behavior:"deny", message}`. **[observé dans le code du SDK ; pas encore testé en direct]** Le compte avait atteint sa limite hebdomadaire `seven_day`.
- Autres requêtes de contrôle utilisées : `interrupt`, `set_permission_mode`, `set_model`, `get_context_usage`, `mcp_status`…

## 4. Ce que Better Harness fait différemment

| Problème mesuré | Réponse de Better Harness |
|---|---|
| UI Chromium + React claude.ai (≈1,6 Go, ~62 % CPU en streaming pour le renderer et le GPU) | Tauri : WebKit système, UI en TypeScript sans framework (98 Ko de JS), aucune animation, Markdown rendu une seule fois par message terminé, `content-visibility: auto` |
| Deltas rendus en continu | Coalescence côté Rust (40 ms) et envoi **uniquement** pour la session affichée quand la fenêtre est visible |
| Un CLI vivant par session ouverte | Spawn paresseux (aucun processus avant le premier message), `max_live` processus au plus, suspension après inactivité et reprise transparente via `--resume` |
| Serveurs MCP dupliqués dans chaque session | Sélection par session (`--strict-mcp-config --mcp-config`) ; kill du **groupe** de processus (CLI + MCP) à la suspension |
| Transcripts de 100 Mo et plus | Liste construite en lisant 64 Ko au début et à la fin de chaque fichier ; chargement d'un transcript en remontant depuis la fin (plafond 24 Mo) |
| Tout le JSON brut transmis à l'UI | Projection compacte : résultats d'outils tronqués à 6 Ko pour l'affichage (le jsonl du CLI reste complet) |

Les mesures du harness lui-même sont dans [`MESURES.md`](MESURES.md).
