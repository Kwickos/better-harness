// Files Claude shows in the conversation (`send_files` tool, src-tauri/src/files_tool.rs):
// images as previews, enlarged on click in a viewer; the others as a card that opens in
// their app. Dimensions come from the file header: the preview has its size before loading,
// so the thread doesn't jump.
import type { Api, Attachment } from "./api";
import { copyButton } from "./copy";
import { fmtNumber, t, tp } from "./i18n";
import { icon, type IconName } from "./icons";
import { sentFiles } from "./labels";
import { animateOut, DUR, enter } from "./motion";
import { el, type ToolView } from "./transcript";

interface Deps {
  api: Api;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  reveal: (path: string) => void;
  /** The viewer opens or closes: the panel's native views must step aside or come back. */
  overlayChanged: () => void;
}

/** A single image shows large; several, as thumbnails of the same height. */
const SINGLE_H = 320;
const THUMB_H = 132;
const THUMB_W = [72, 240] as const;

function fileSize(bytes: number): string {
  if (bytes < 1024) return tp(bytes, "{n} byte", "{n} bytes");
  const units = ["{n} KB", "{n} MB", "{n} GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return t(units[i], { n: fmtNumber(v, { maximumFractionDigits: 1 }) });
}

function iconButton(name: IconName, label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el("button", `icon-btn ${cls}`);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = icon(name, 16);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

export function initAttachments(d: Deps) {
  async function openFile(path: string) {
    // A script or a shortcut isn't opened: it would run. Show it in the Finder instead.
    const opened = await d.guard(d.api.openAttachment(path));
    if (opened === false) d.reveal(path);
  }

  const viewer = createViewer(d, openFile);

  /** Frame size; for a thumbnail, an image smaller than the frame is centered in it without being enlarged. */
  function sizeThumb(node: HTMLElement, ratio: number, single: boolean, natural: [number, number]) {
    node.style.aspectRatio = String(ratio);
    if (single) {
      // Never enlarged beyond its real size, never taller than SINGLE_H.
      node.style.width = `min(100%, ${Math.round(Math.min(natural[0] || Infinity, SINGLE_H * ratio))}px)`;
      return;
    }
    const width = Math.round(Math.min(THUMB_W[1], Math.max(THUMB_W[0], THUMB_H * ratio)));
    node.style.height = `${THUMB_H}px`;
    node.style.width = `${width}px`;
    node.classList.toggle("is-small", natural[0] > 0 && natural[0] <= width && natural[1] <= THUMB_H);
  }

  function thumb(a: Attachment, all: Attachment[], index: number): HTMLElement {
    const single = all.length === 1;
    const b = el("button", "att-img");
    b.type = "button";
    b.title = a.name;
    b.setAttribute("aria-label", t("Enlarge {name}", { name: a.name }));
    // Format without readable dimensions (SVG): a 4:3 frame, corrected on load.
    const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
    sizeThumb(b, ratio, single, [a.width ?? 0, a.height ?? 0]);
    const img = el("img");
    img.alt = a.name;
    img.decoding = "async";
    img.loading = "lazy";
    img.draggable = false;
    img.addEventListener("load", () => {
      // A photo's EXIF orientation can swap width and height.
      const real = img.naturalWidth / img.naturalHeight;
      if (real && Math.abs(real - ratio) > 0.01) sizeThumb(b, real, single, [img.naturalWidth, img.naturalHeight]);
    });
    // Format WebKit can't read: the file card stays usable.
    img.addEventListener("error", () => b.replaceWith(fileCard(a)), { once: true });
    img.src = a.url!;
    b.append(img);
    b.addEventListener("click", () => viewer.open(all, index));
    return b;
  }

  function fileCard(a: Attachment): HTMLElement {
    const row = el("div", `att-file${a.exists ? "" : " is-missing"}`);
    const open = el("button", "att-open");
    open.type = "button";
    open.disabled = !a.exists;
    open.title = a.exists ? `${a.path}\n${fileSize(a.size)}` : t("Not found: {path}", { path: a.path });
    open.innerHTML = icon("file", 16);
    open.append(el("span", "att-name", a.name));
    if (!a.exists) open.append(el("span", "att-note", t("not found")));
    open.addEventListener("click", () => void openFile(a.path));
    row.append(open);
    if (a.exists) row.append(iconButton("folder", t("Show in Finder"), "att-reveal", () => d.reveal(a.path)));
    return row;
  }

  function fill(box: HTMLElement, list: Attachment[], caption: string) {
    const images = list.filter((a) => a.image && a.exists && a.url);
    const frag = document.createDocumentFragment();
    if (images.length) {
      const row = el("div", images.length === 1 ? "att-images is-single" : "att-images");
      images.forEach((a, i) => row.append(thumb(a, images, i)));
      frag.append(row);
    }
    for (const a of list) if (!images.includes(a)) frag.append(fileCard(a));
    if (caption) frag.append(el("div", "att-caption", caption));
    box.replaceChildren(frag);
  }

  return {
    /** Block of a call's files; `settled` when it takes its place, to keep the thread at the bottom. */
    render(tv: ToolView, cwd: string, settled: () => void): HTMLElement {
      const box = el("div", "att");
      const { files, caption } = sentFiles(tv.input);
      if (!files.length) return box;
      // Already described (conversation shown again): everything is in place at once.
      if (tv.files) {
        fill(box, tv.files, caption);
        return box;
      }
      void d.guard(d.api.attachments(cwd, files)).then((list) => {
        if (!list) return;
        tv.files = list;
        fill(box, list, caption);
        settled();
      });
      return box;
    },
  };
}

/** Full-screen viewer: one image at a time, ← → between the images of one send. */
function createViewer(d: Deps, openFile: (path: string) => Promise<void>) {
  const dlg = el("dialog", "viewer");
  dlg.setAttribute("aria-label", t("Preview"));
  dlg.tabIndex = -1;
  const bar = el("div", "viewer-bar");
  bar.dataset.tauriDragRegion = "";
  const name = el("span", "viewer-name");
  const count = el("span", "viewer-count");
  const title = el("div", "viewer-title");
  title.dataset.tauriDragRegion = "";
  title.append(name, count);
  let items: Attachment[] = [];
  let index = 0;
  const current = () => items[index];
  bar.append(
    title,
    copyButton(() => current()?.path ?? "", t("Copy path"), "viewer-btn"),
    iconButton("external", t("Open in its app"), "viewer-btn", () => void openFile(current().path)),
    iconButton("folder", t("Show in Finder"), "viewer-btn", () => d.reveal(current().path)),
    iconButton("close", t("Close"), "viewer-btn", close),
  );
  const stage = el("div", "viewer-stage");
  const img = el("img");
  img.draggable = false;
  img.decoding = "async";
  stage.append(img);
  const prev = iconButton("chevronLeft", t("Previous image"), "viewer-nav is-prev", () => show(index - 1, true));
  const next = iconButton("chevronRight", t("Next image"), "viewer-nav is-next", () => show(index + 1, true));
  dlg.append(bar, stage, prev, next);
  document.body.append(dlg);

  function show(i: number, swap: boolean) {
    if (!items.length) return;
    index = (i + items.length) % items.length;
    const a = current();
    img.src = a.url!;
    img.alt = a.name;
    name.textContent = a.name;
    count.textContent = items.length > 1 ? t("{n} of {total}", { n: index + 1, total: items.length }) : "";
    prev.hidden = next.hidden = items.length < 2;
    if (swap) void enter(img, { opacity: "0" }, { duration: DUR.quick, ease: "easeInOut" });
  }

  function close() {
    if (!dlg.open || dlg.classList.contains("is-closing")) return;
    animateOut(dlg, "is-closing", () => {
      dlg.close();
      // The decoded image doesn't stay in memory once the viewer is closed.
      img.removeAttribute("src");
      d.overlayChanged();
    });
  }

  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  // A click outside the image closes, like Esc.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target === stage) close();
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(index + (e.key === "ArrowLeft" ? -1 : 1), true);
    }
  });

  return {
    open(list: Attachment[], i: number) {
      items = list;
      show(i, false);
      dlg.classList.remove("is-closing");
      dlg.showModal();
      dlg.focus();
      d.overlayChanged();
    },
  };
}
