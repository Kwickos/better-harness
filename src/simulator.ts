// Simulator tab: the live screen of an iOS simulator, touch-enabled, on a canvas in the panel.
// The bridge only runs while the tab is shown. The next frame is only requested once the previous
// one is painted: if the UI falls behind, the Rust core skips frames instead of queuing them.
import type { Api, SimDevice, UiEvent } from "./api";
import { t } from "./i18n";
import { icon } from "./icons";
import { showMenu } from "./menu";
import { DUR, SCALE, enter, iconIn } from "./motion";

interface Deps {
  api: Api;
  guard: <T>(p: Promise<T>) => Promise<T | undefined>;
  attach: (path: string) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORE_KEY = "bh.sim.udid";
/** A gesture starting less than 10 px from an edge triggers the system gesture, as on the device. */
const EDGE_ZONE = 10;
const EDGE = { top: 1, left: 2, bottom: 3, right: 4 } as const;
/** Corner radius of a screen, as a share of its width: iPhone, then iPad. */
const RADIUS_PHONE = 0.13;
const RADIUS_TABLET = 0.025;
const SHOT_FEEDBACK_MS = 1400;

/** Physical keys → HID codes (keyboard page). The iPhone applies its own layout. */
const HID: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57, IntlBackslash: 100,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, Delete: 76, Home: 74, End: 77, PageUp: 75, PageDown: 78,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
for (let i = 0; i < 26; i++) HID[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
for (let i = 1; i <= 9; i++) HID[`Digit${i}`] = 29 + i;
HID.Digit0 = 39;
for (let i = 1; i <= 12; i++) HID[`F${i}`] = 57 + i;

const read = () => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};
const remember = (udid: string) => {
  try {
    localStorage.setItem(STORE_KEY, udid);
  } catch {
    /* preference not remembered */
  }
};

export function initSimulatorTab(d: Deps) {
  const canvas = $<HTMLCanvasElement>("sim-screen");
  const context = canvas.getContext("2d", { alpha: false });
  const empty = $("sim-empty");
  const emptyTitle = $("sim-empty-title");
  const emptySub = $("sim-empty-sub");
  const emptyAct = $<HTMLButtonElement>("sim-empty-act");
  const deviceBtn = $<HTMLButtonElement>("sim-device");
  const actions = $("sim-actions");
  const themeBtn = $<HTMLButtonElement>("sim-theme");
  const shotBtn = $<HTMLButtonElement>("sim-shot");

  let visible = false;
  let devices: SimDevice[] = [];
  let udid = read();
  /** One value per screen session: incrementing it stops the running frame loop. */
  let session = 0;
  let streaming: string | null = null;
  let hasFrame = false;
  /** The device whose last frame the canvas keeps: it shows right away when the tab reopens. */
  let painted: string | null = null;
  /** Error to show instead of the screen, with its action. */
  let problem: { title: string; sub?: string; action?: string; run?: () => void } | null = null;
  let booting = false;
  let appearance: "light" | "dark" | null = null;

  const current = () => devices.find((x) => x.udid === udid) ?? null;
  const send = (line: string) => void d.api.simInput(line).catch(() => {});

  /** The remembered choice if it still exists, else an already booted device, else the first iPhone. */
  function pickDevice() {
    if (current()) return;
    const fallback = devices.find((x) => x.state === "Booted") ?? devices.find((x) => x.name.includes("iPhone")) ?? devices[0];
    udid = fallback?.udid ?? null;
  }

  function label(device: SimDevice) {
    const twin = devices.some((x) => x !== device && x.name === device.name);
    return twin ? `${device.name} (${device.runtime})` : device.name;
  }

  // ------------------------------------------------------------ display

  function render() {
    const device = current();
    const on = device?.state === "Booted";
    deviceBtn.hidden = !device;
    if (device) $("sim-device-name").textContent = label(device);
    actions.hidden = !on || !!problem;
    themeBtn.hidden = !on || appearance === null;
    if (appearance) {
      themeBtn.title = appearance === "dark" ? t("Switch to light mode") : t("Switch to dark mode");
      themeBtn.setAttribute("aria-label", themeBtn.title);
      themeBtn.firstElementChild!.innerHTML = icon(appearance === "dark" ? "sun" : "moon");
    }

    const showScreen = on && !problem && hasFrame;
    canvas.hidden = !showScreen;
    let title = "";
    let sub = "";
    let action = "";
    let run: (() => void) | undefined;
    if (problem) {
      ({ title, sub = "", action = "", run } = problem);
    } else if (!device) {
      title = t("No simulators");
      sub = t("Create a device in Xcode.");
    } else if (!on) {
      title = label(device);
      action = booting ? t("Starting…") : t("Start");
      run = booting ? undefined : () => void boot(device.udid);
    } else if (!hasFrame) {
      title = label(device);
      sub = t("Connecting to the screen…");
    }
    empty.hidden = showScreen;
    emptyTitle.textContent = title;
    emptySub.textContent = sub;
    emptySub.hidden = !sub;
    emptyAct.textContent = action;
    emptyAct.hidden = !action;
    emptyAct.disabled = !run;
    emptyAct.onclick = run ?? null;
  }

  function paint(bitmap: ImageBitmap) {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      fitCorners();
    }
    context?.drawImage(bitmap, 0, 0);
    bitmap.close();
    painted = streaming;
    if (hasFrame) return;
    hasFrame = true;
    render();
    void enter(canvas, { opacity: "0", transform: `scale(${SCALE.medium})` }, { duration: DUR.fast });
  }

  function fitCorners() {
    const share = canvas.height / Math.max(1, canvas.width) > 1.7 ? RADIUS_PHONE : RADIUS_TABLET;
    canvas.style.setProperty("--sim-radius", `${canvas.getBoundingClientRect().width * share}px`);
  }
  new ResizeObserver(fitCorners).observe(canvas);

  // ------------------------------------------------------------ stream

  async function loop(token: number) {
    while (token === session) {
      const buffer = await d.api.simFrame().catch(() => null);
      if (token !== session) return;
      if (!buffer) {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        continue;
      }
      if (!buffer.byteLength) continue;
      const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/jpeg" })).catch(() => null);
      if (!bitmap) continue;
      if (token !== session) {
        bitmap.close();
        return;
      }
      paint(bitmap);
      // Suspended while the window is hidden: nothing is decoded for nothing.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async function startStream(target: string) {
    if (streaming === target) {
      render();
      return;
    }
    const token = ++session;
    streaming = target;
    hasFrame = painted === target;
    problem = null;
    render();
    try {
      await d.api.simAttach(target);
    } catch (error) {
      if (token !== session) return;
      streaming = null;
      showProblem(String(error));
      return;
    }
    if (token !== session) return;
    void loop(token);
    void readAppearance(target);
  }

  function stopStream() {
    if (!streaming) return;
    session++;
    streaming = null;
    releaseInputs();
    void d.api.simDetach().catch(() => {});
  }

  function showProblem(message: string) {
    problem = { title: t("Screen unavailable"), sub: message, action: t("Retry"), run: () => void sync() };
    render();
  }

  /** Brings the tab back in line with the chosen device. */
  async function sync() {
    problem = null;
    const device = current();
    if (visible && device?.state === "Booted") await startStream(device.udid);
    else {
      stopStream();
      render();
    }
  }

  async function refresh() {
    try {
      devices = await d.api.simDevices();
    } catch (error) {
      devices = [];
      problem = { title: t("Simulator unavailable"), sub: String(error) };
      stopStream();
      render();
      return;
    }
    pickDevice();
    void d.api.simSelect(udid).catch(() => {});
    await sync();
  }

  async function boot(target: string) {
    booting = true;
    render();
    try {
      await d.guard(d.api.simBoot(target));
      devices = (await d.guard(d.api.simDevices())) ?? devices;
    } finally {
      booting = false;
    }
    await sync();
  }

  async function readAppearance(target: string) {
    const value = await d.api.simAppearance(target).catch(() => null);
    if (target !== udid) return;
    appearance = value === "light" || value === "dark" ? value : null;
    render();
  }

  // ------------------------------------------------------------ bar controls

  deviceBtn.addEventListener("click", () => {
    showMenu(
      deviceBtn,
      devices.map((device) => ({
        label: label(device),
        checked: device.udid === udid,
        run: () => {
          if (device.udid === udid) return;
          udid = device.udid;
          remember(udid);
          void d.api.simSelect(udid).catch(() => {});
          appearance = null;
          stopStream();
          void sync();
        },
      })),
      { minWidth: 200 },
    );
  });

  $("sim-home").addEventListener("click", () => send("home"));

  shotBtn.addEventListener("click", async () => {
    if (!udid) return;
    const path = await d.guard(d.api.simScreenshot(udid));
    if (!path) return;
    d.attach(path);
    const slot = shotBtn.firstElementChild as HTMLElement;
    slot.innerHTML = icon("check");
    iconIn(slot);
    window.setTimeout(() => {
      slot.innerHTML = icon("camera");
      iconIn(slot);
    }, SHOT_FEEDBACK_MS);
  });

  themeBtn.addEventListener("click", async () => {
    if (!udid || !appearance) return;
    const next = appearance === "dark" ? "light" : "dark";
    const value = await d.guard(d.api.simAppearance(udid, next));
    if (!value) return;
    appearance = next;
    render();
    iconIn(themeBtn.firstElementChild as HTMLElement);
  });

  $("sim-power").addEventListener("click", async () => {
    const device = current();
    if (!device) return;
    stopStream();
    hasFrame = false;
    painted = null;
    device.state = "Shutdown";
    render();
    await d.guard(d.api.simShutdown(device.udid));
    await refresh();
  });

  // ------------------------------------------------------------ touch

  /** Position as a fraction of the screen, and the nearest edge if the gesture starts in the edge zone. */
  function locate(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const fromBottom = r.bottom - e.clientY;
    const fromLeft = e.clientX - r.left;
    const fromRight = r.right - e.clientX;
    const fromTop = e.clientY - r.top;
    let edge = 0;
    if (fromBottom <= EDGE_ZONE) edge = EDGE.bottom;
    else if (fromLeft <= EDGE_ZONE) edge = EDGE.left;
    else if (fromRight <= EDGE_ZONE) edge = EDGE.right;
    else if (fromTop <= EDGE_ZONE) edge = EDGE.top;
    return { x: x.toFixed(4), y: y.toFixed(4), edge };
  }

  let touching = false;
  /** Start at the screen edge: wait to know whether it's a gesture or a plain tap. */
  let heldStart: { x: string; y: string; edge: number } | null = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    touching = true;
    const at = locate(e);
    if (at.edge) heldStart = at;
    else send(`touch down ${at.x} ${at.y} 0`);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!touching) return;
    const at = locate(e);
    if (heldStart) {
      send(`touch down ${heldStart.x} ${heldStart.y} ${heldStart.edge}`);
      heldStart = null;
    }
    send(`touch move ${at.x} ${at.y}`);
  });

  const release = (e: PointerEvent) => {
    if (!touching) return;
    touching = false;
    const at = locate(e);
    if (heldStart) {
      send(`touch down ${heldStart.x} ${heldStart.y} 0`);
      heldStart = null;
    }
    send(`touch up ${at.x} ${at.y}`);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  // ------------------------------------------------------------ keyboard

  const held = new Set<number>();
  function releaseInputs() {
    for (const code of held) send(`key up ${code}`);
    held.clear();
    touching = false;
    heldStart = null;
  }

  canvas.addEventListener("keydown", (e) => {
    // ⌘ stays with the app: its shortcuts also work while the screen has focus.
    if (e.metaKey) return;
    const code = HID[e.code];
    if (code === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || held.has(code)) return;
    held.add(code);
    send(`key down ${code}`);
  });
  canvas.addEventListener("keyup", (e) => {
    const code = HID[e.code];
    if (code === undefined || !held.delete(code)) return;
    e.preventDefault();
    e.stopPropagation();
    send(`key up ${code}`);
  });
  canvas.addEventListener("blur", () => {
    for (const code of held) send(`key up ${code}`);
    held.clear();
  });

  // ------------------------------------------------------------ lifecycle

  // The remembered choice is Claude's default, even if the tab was never opened.
  if (udid) void d.api.simSelect(udid).catch(() => {});

  document.addEventListener("visibilitychange", () => {
    if (streaming) send(document.hidden ? "pause" : "resume");
  });
  // A device may have been booted or shut down elsewhere (Xcode, the terminal, Claude).
  window.addEventListener("focus", () => {
    if (visible) void refresh();
  });

  return {
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      if (next) void refresh();
      else stopStream();
    },
    onEvent(ev: Extract<UiEvent, { kind: "simulator" }>) {
      if (ev.state === "agent") {
        // Claude acts on this device: the panel shows the same one.
        if (udid !== ev.udid) appearance = null;
        udid = ev.udid;
        remember(udid);
        if (visible) void refresh();
        return;
      }
      if (ev.udid !== streaming) return;
      if (ev.state === "no-input") canvas.title = t("Input unavailable with this Xcode version");
      else if (ev.state === "ready") canvas.removeAttribute("title");
      else if (ev.state === "error") {
        streaming = null;
        session++;
        showProblem(ev.message ?? t("The simulator bridge stopped."));
      } else if (ev.state === "ended") {
        streaming = null;
        session++;
        hasFrame = false;
        painted = null;
        void refresh();
      }
    },
  };
}
