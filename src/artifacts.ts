// Onglet Artefacts : les pages publiées par Claude dans cette conversation.
// Une page dont le fichier est encore là s'affiche sans session claude.ai, dans une vue native placée
// par le cœur Rust ; le reste s'ouvre sur claude.ai.
import type { Api, Artifact } from "./api";
import { copyButton } from "./copy";
import { icon } from "./icons";
import { confirmMenu, showMenu } from "./menu";

interface Deps {
  api: Api;
  inTauri: boolean;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  openExternal: (url: string) => void;
  /** Les artefacts de la conversation affichée, le plus récent d'abord. */
  list: () => Artifact[];
  /** Retire l'artefact de la conversation, une fois supprimé. */
  remove: (url: string) => void;
  /** La vue native peut-elle être à l'écran (onglet ouvert, pas de menu ni de dialogue devant) ? */
  canShow: () => boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const GALLERY = "https://claude.ai/code/artifacts";
/** Une page qui ne signale jamais la fin de son chargement (un script distant bloqué) s'affiche quand même. */
const READY_FALLBACK_MS = 1500;

export function initArtifactTab(d: Deps) {
  const view = $("art-view");
  const empty = $("art-empty");
  const pick = $<HTMLButtonElement>("art-pick");
  const actions = $("art-actions");
  const reload = $<HTMLButtonElement>("art-reload");

  let visible = false;
  let selected: string | null = null;
  /** Le fichier chargé dans la vue native. */
  let loaded: string | null = null;
  let loading = false;
  let readyTimer = 0;
  let queued = false;
  let token = 0;

  const current = () => d.list().find((a) => a.url === selected) ?? d.list()[0] ?? null;
  const rect = () => {
    const r = view.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  // Masquer est immédiat ; seuls les repositionnements sont regroupés par image.
  function sync() {
    if (!d.inTauri || !loaded) return;
    if (loading || !d.canShow()) {
      void d.api.artifactBounds(rect(), false);
      return;
    }
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // Entre-temps, l'artefact affiché a pu changer : `loaded` décide au dernier moment.
      void d.api.artifactBounds(rect(), !!loaded && !loading && d.canShow());
    });
  }
  new ResizeObserver(sync).observe(view);
  window.addEventListener("resize", sync);

  function ready() {
    window.clearTimeout(readyTimer);
    if (!loading) return;
    loading = false;
    sync();
  }

  function showEmpty(title: string, sub: string, action: string, url: string) {
    empty.hidden = false;
    $("art-empty-title").textContent = title;
    $("art-empty-sub").textContent = sub;
    $("art-empty-sub").hidden = !sub;
    const button = $<HTMLButtonElement>("art-empty-act");
    button.textContent = action;
    button.onclick = () => d.openExternal(url);
  }

  async function render() {
    const artifact = current();
    pick.hidden = !artifact;
    actions.hidden = !artifact;
    if (artifact) $("art-name").textContent = artifact.title;
    const mine = ++token;
    if (!visible) {
      sync();
      return;
    }
    if (artifact?.path && d.inTauri) {
      if (artifact.path === loaded) {
        reload.hidden = false;
        empty.hidden = true;
        sync();
        return;
      }
      const shown = await d.guard(d.api.artifactShow(artifact.path, rect().w, rect().h));
      if (mine !== token) return;
      if (shown) {
        loaded = artifact.path;
        loading = true;
        reload.hidden = false;
        empty.hidden = true;
        window.clearTimeout(readyTimer);
        readyTimer = window.setTimeout(ready, READY_FALLBACK_MS);
        return;
      }
    }
    // Rien à montrer ici : la vue native libère sa mémoire et laisse le message.
    if (loaded) void d.api.artifactClose();
    loaded = null;
    loading = false;
    reload.hidden = true;
    if (artifact) showEmpty(artifact.title, artifact.path ? "Le fichier n'est plus sur cet ordinateur." : "", "Ouvrir sur claude.ai", artifact.url);
    else showEmpty("Aucun artefact", "Les pages que Claude publie apparaîtront ici.", "Tous mes artefacts", GALLERY);
  }

  pick.addEventListener("click", () => {
    showMenu(
      pick,
      [
        ...d.list().map((artifact) => ({
          label: artifact.title,
          title: artifact.title,
          checked: artifact.url === current()?.url,
          run: () => {
            selected = artifact.url;
            void render();
          },
        })),
        { label: "Tous mes artefacts", run: () => d.openExternal(GALLERY) },
      ],
      { minWidth: 200 },
    );
  });
  reload.addEventListener("click", () => void d.api.artifactReload());
  $("art-external").addEventListener("click", () => {
    const artifact = current();
    if (artifact) d.openExternal(artifact.url);
  });
  $("art-external").before(copyButton(() => current()?.url ?? "", "Copier le lien", "art-copy"));

  const del = $<HTMLButtonElement>("art-delete");
  del.addEventListener("click", () => {
    const artifact = current();
    if (!artifact) return;
    confirmMenu(del, `Supprimer « ${artifact.title} » ?`, "Son lien cessera de marcher, définitivement. Le fichier local reste.", "Supprimer", () => void remove(artifact), { align: "end" });
  });

  async function remove(artifact: Artifact) {
    del.disabled = true;
    del.classList.add("is-busy");
    del.firstElementChild!.innerHTML = icon("spinner");
    const done = await d.guard(d.api.artifactDelete(artifact.url));
    del.disabled = false;
    del.classList.remove("is-busy");
    del.firstElementChild!.innerHTML = icon("trash");
    if (done) d.remove(artifact.url);
  }

  return {
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      void render();
    },
    /** La conversation ou sa liste a changé. */
    refresh() {
      void render();
    },
    select(url: string) {
      selected = url;
      void render();
    },
    ready,
    sync,
  };
}
