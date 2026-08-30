// Dispatch for the native menu bar: the backend forwards every menu item
// as a "menu" event carrying the item id; this maps ids onto the existing
// document/palette/prefs verbs. Shortcuts live on the menu items, so this
// is the only keyboard surface in Tauri (main.ts keeps DOM fallbacks for
// the browser demo).
import { listen } from "@tauri-apps/api/event";
import { backend, IN_TAURI } from "./ipc";
import {
  openFile,
  saveFile,
  saveFileAs,
  newUntitled,
  reloadFromDisk,
  hasDocument,
} from "./document";
import { openPalette } from "./palette";
import { zoomIn, zoomOut, zoomActual } from "./prefs";

let pickingOpen = false;

const actions: Record<string, () => void> = {
  // New fills an empty window in place; otherwise each document gets its
  // own window, TextEdit-style.
  new: () => {
    if (hasDocument()) void backend.newWindow(true);
    else void newUntitled();
  },
  "new-window": () => void backend.newWindow(),
  open: () => {
    // One panel at a time: a second ⌘O while the panel is up is a no-op.
    if (pickingOpen) return;
    pickingOpen = true;
    void backend
      .pickOpenPath()
      .then((path) => {
        if (path) void openFile(path);
      })
      .finally(() => {
        pickingOpen = false;
      });
  },
  "open-quick": openPalette,
  save: () => void saveFile(),
  "save-as": () => void saveFileAs(),
  revert: reloadFromDisk,
  "zoom-in": zoomIn,
  "zoom-out": zoomOut,
  "zoom-actual": zoomActual,
};

export async function initMenu() {
  if (!IN_TAURI) return;
  await listen<string>("menu", ({ payload: id }) => {
    if (id.startsWith("recent:")) {
      void openFile(id.slice("recent:".length));
    } else {
      actions[id]?.();
    }
  });
}
