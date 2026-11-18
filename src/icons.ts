// Phosphor icons (MIT, https://phosphoricons.com), bundled as raw SVG.
import appWindow from "@phosphor-icons/core/assets/regular/app-window.svg?raw";
import archive from "@phosphor-icons/core/assets/regular/archive.svg?raw";
import arrowCircleUp from "@phosphor-icons/core/assets/regular/arrow-circle-up.svg?raw";
import arrowClockwise from "@phosphor-icons/core/assets/regular/arrow-clockwise.svg?raw";
import arrowLeft from "@phosphor-icons/core/assets/regular/arrow-left.svg?raw";
import arrowRight from "@phosphor-icons/core/assets/regular/arrow-right.svg?raw";
import arrowSquareOut from "@phosphor-icons/core/assets/regular/arrow-square-out.svg?raw";
import arrowUp from "@phosphor-icons/core/assets/bold/arrow-up-bold.svg?raw";
import circleNotch from "@phosphor-icons/core/assets/bold/circle-notch-bold.svg?raw";
import arrowUUpLeft from "@phosphor-icons/core/assets/regular/arrow-u-up-left.svg?raw";
import folderDashed from "@phosphor-icons/core/assets/regular/folder-dashed.svg?raw";
import gitDiff from "@phosphor-icons/core/assets/regular/git-diff.svg?raw";
import gitBranch from "@phosphor-icons/core/assets/regular/git-branch.svg?raw";
import laptop from "@phosphor-icons/core/assets/regular/laptop.svg?raw";
import brain from "@phosphor-icons/core/assets/regular/brain.svg?raw";
import camera from "@phosphor-icons/core/assets/regular/camera.svg?raw";
import deviceMobile from "@phosphor-icons/core/assets/regular/device-mobile.svg?raw";
import houseSimple from "@phosphor-icons/core/assets/regular/house-simple.svg?raw";
import moon from "@phosphor-icons/core/assets/regular/moon.svg?raw";
import power from "@phosphor-icons/core/assets/regular/power.svg?raw";
import sun from "@phosphor-icons/core/assets/regular/sun.svg?raw";
import caretLeft from "@phosphor-icons/core/assets/bold/caret-left-bold.svg?raw";
import caretDown from "@phosphor-icons/core/assets/bold/caret-down-bold.svg?raw";
import caretRight from "@phosphor-icons/core/assets/bold/caret-right-bold.svg?raw";
import check from "@phosphor-icons/core/assets/bold/check-bold.svg?raw";
import copy from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import cpu from "@phosphor-icons/core/assets/regular/cpu.svg?raw";
import dotsThree from "@phosphor-icons/core/assets/bold/dots-three-bold.svg?raw";
import file from "@phosphor-icons/core/assets/regular/file.svg?raw";
import folderSimple from "@phosphor-icons/core/assets/regular/folder-simple.svg?raw";
import gauge from "@phosphor-icons/core/assets/regular/gauge.svg?raw";
import gearSix from "@phosphor-icons/core/assets/regular/gear-six.svg?raw";
import globeSimple from "@phosphor-icons/core/assets/regular/globe-simple.svg?raw";
import hand from "@phosphor-icons/core/assets/regular/hand.svg?raw";
import hardDrives from "@phosphor-icons/core/assets/regular/hard-drives.svg?raw";
import info from "@phosphor-icons/core/assets/regular/info.svg?raw";
import lightning from "@phosphor-icons/core/assets/regular/lightning.svg?raw";
import magicWand from "@phosphor-icons/core/assets/regular/magic-wand.svg?raw";
import magnifyingGlass from "@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw";
import mapTrifold from "@phosphor-icons/core/assets/regular/map-trifold.svg?raw";
import notePencil from "@phosphor-icons/core/assets/regular/note-pencil.svg?raw";
import pencilSimple from "@phosphor-icons/core/assets/regular/pencil-simple.svg?raw";
import play from "@phosphor-icons/core/assets/fill/play-fill.svg?raw";
import plug from "@phosphor-icons/core/assets/regular/plug.svg?raw";
import plus from "@phosphor-icons/core/assets/bold/plus-bold.svg?raw";
import sidebarSimple from "@phosphor-icons/core/assets/regular/sidebar-simple.svg?raw";
import sparkle from "@phosphor-icons/core/assets/regular/sparkle.svg?raw";
import stop from "@phosphor-icons/core/assets/fill/stop-fill.svg?raw";
import terminalWindow from "@phosphor-icons/core/assets/regular/terminal-window.svg?raw";
import trash from "@phosphor-icons/core/assets/regular/trash.svg?raw";
import warning from "@phosphor-icons/core/assets/regular/warning.svg?raw";
import x from "@phosphor-icons/core/assets/bold/x-bold.svg?raw";

export const icons = {
  compose: notePencil,
  copy,
  file,
  undo: arrowUUpLeft,
  folderDashed,
  gitDiff,
  gitBranch,
  laptop,
  archive,
  spinner: circleNotch,
  plus,
  send: arrowUp,
  stop,
  more: dotsThree,
  search: magnifyingGlass,
  chevronDown: caretDown,
  chevronRight: caretRight,
  chevronLeft: caretLeft,
  folder: folderSimple,
  settings: gearSix,
  check,
  globe: globeSimple,
  server: hardDrives,
  device: deviceMobile,
  artifact: appWindow,
  home: houseSimple,
  camera,
  moon,
  sun,
  power,
  play,
  back: arrowLeft,
  forward: arrowRight,
  reload: arrowClockwise,
  update: arrowCircleUp,
  external: arrowSquareOut,
  close: x,
  panel: sidebarSimple,
  gauge,
  plug,
  hand,
  pencil: pencilSimple,
  map: mapTrifold,
  magic: magicWand,
  warning,
  lightning,
  sparkle,
  brain,
  cpu,
  terminal: terminalWindow,
  info,
  trash,
};

export type IconName = keyof typeof icons;

export function icon(name: IconName, size = 16): string {
  return icons[name].replace("<svg ", `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false" `);
}
