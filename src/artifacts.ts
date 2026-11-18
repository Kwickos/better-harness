// Artifacts tab: the pages Claude published in this conversation.
// A page whose file is still here shows without a claude.ai session, in a native view placed
// by the Rust core; the rest opens on claude.ai.
import type { Api, Artifact } from "./api";
import { copyButton } from "./copy";
import { t } from "./i18n";
import { icon } from "./icons";
import { confirmMenu, showMenu } from "./menu";

interface Deps {
  api: Api;
  inTauri: boolean;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  openExternal: (url: string) => void;
  /** Artifacts of the displayed conversation, most recent first. */
  list: () => Artifact[];
  /** Removes the artifact from the conversation, once deleted. */
  remove: (url: string) => void;
  /** Can the native view be on screen (tab open, no menu or dialog in front)? */
  canShow: () => boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const GALLERY = "https://claude.ai/code/artifacts";
/** A page that never reports it finished loading (a blocked remote script) shows anyway. */
const READY_FALLBACK_MS = 1500;

export function initArtifactTab(d: Deps) {
  const view = $("art-view");
  const empty = $("art-empty");
  const pick = $<HTMLButtonElement>("art-pick");
  const actions = $("art-actions");
  const reload = $<HTMLButtonElement>("art-reload");

  let visible = false;
  let selected: string | null = null;
  /** The file loaded in the native view. */
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

  // Hiding is immediate; only repositioning is batched per frame.
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
      // The displayed artifact may have changed meanwhile: `loaded` decides at the last moment.
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
    // Nothing to show here: the native view frees its memory and leaves the message.
    if (loaded) void d.api.artifactClose();
    loaded = null;
    loading = false;
    reload.hidden = true;
    if (artifact) showEmpty(artifact.title, artifact.path ? t("The file is no longer on this computer.") : "", t("Open on claude.ai"), artifact.url);
    else showEmpty(t("No artifacts"), t("Pages Claude publishes will appear here."), t("All my artifacts"), GALLERY);
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
        { label: t("All my artifacts"), run: () => d.openExternal(GALLERY) },
      ],
      { minWidth: 200 },
    );
  });
  reload.addEventListener("click", () => void d.api.artifactReload());
  $("art-external").addEventListener("click", () => {
    const artifact = current();
    if (artifact) d.openExternal(artifact.url);
  });
  $("art-external").before(copyButton(() => current()?.url ?? "", "Copy link", "art-copy"));

  const del = $<HTMLButtonElement>("art-delete");
  del.addEventListener("click", () => {
    const artifact = current();
    if (!artifact) return;
    confirmMenu(del, t("Delete “{title}”?", { title: artifact.title }), t("Its link will stop working for good. The local file stays."), t("Delete"), () => void remove(artifact), { align: "end" });
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
    /** The conversation or its list changed. */
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
