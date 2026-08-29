// Bootstrap: theme, global shortcuts, backend events, launch-file handling.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import "@milkdown/crepe/theme/common/style.css";
import frameLight from "@milkdown/crepe/theme/frame.css?url";
import frameDark from "@milkdown/crepe/theme/frame-dark.css?url";
import "./styles.css";

import { backend } from "./ipc";
import { $ } from "./dom";
import { openFile, saveFile, reloadFromDisk, syncWithDisk } from "./document";
import { openPalette } from "./palette";
import { initAppearancePanel } from "./prefs";

// Load the editor theme matching the system appearance so the editor and
// the chrome (palette, bars) never disagree on light vs dark.
for (const [href, media] of [
  [frameLight, "(prefers-color-scheme: light)"],
  [frameDark, "(prefers-color-scheme: dark)"],
] as const) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.media = media;
  document.head.appendChild(link);
}

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === "p" || key === "o") {
    e.preventDefault();
    openPalette();
  } else if (key === "s") {
    e.preventDefault();
    void saveFile(e.shiftKey); // ⌘⇧S force-saves past a disk conflict
  } else if (key === "r" && !e.shiftKey) {
    e.preventDefault();
    reloadFromDisk();
  }
});

const indexStatusEl = $("index-status");

async function refreshIndexStatus() {
  const status = await backend.indexStatus();
  indexStatusEl.textContent = status.indexing
    ? "indexing…"
    : `${status.count.toLocaleString()} files indexed`;
}

// macOS "open with" requests queue in the backend; the open-request event is
// just a wake-up. Drain on event and once at startup (for requests that
// arrived before this listener existed).
async function drainOpenRequests() {
  const paths = await backend.takePendingOpen();
  const last = paths[paths.length - 1];
  if (last) await openFile(last);
}

async function main() {
  initAppearancePanel();
  await listen("open-request", () => void drainOpenRequests());
  await listen<number>("index-ready", (event) => {
    indexStatusEl.textContent = `${event.payload.toLocaleString()} files indexed`;
  });
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void syncWithDisk();
  });

  await drainOpenRequests();
  await refreshIndexStatus();
}

void main();
