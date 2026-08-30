// Bootstrap: theme, global shortcuts, backend events, launch-file handling.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import "@milkdown/crepe/theme/common/style.css";
import frameLight from "@milkdown/crepe/theme/frame.css?url";
import frameDark from "@milkdown/crepe/theme/frame-dark.css?url";
import "./styles.css";

import { backend, IN_TAURI } from "./ipc";
import { $ } from "./dom";
import {
  openFile,
  saveFile,
  reloadFromDisk,
  syncWithDisk,
  newUntitled,
} from "./document";
import { openPalette, isPaletteOpen } from "./palette";
import { initAppearancePanel, zoomIn, zoomOut, zoomActual } from "./prefs";
import { initMenu } from "./menu";

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

// In Tauri every shortcut is declared on its native menu item (menu.ts
// dispatches); these DOM handlers exist only for the browser demo.
if (!IN_TAURI) {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (isPaletteOpen()) return; // the palette owns the keyboard while open
    const key = e.key.toLowerCase();
    if (key === "p" || key === "o") {
      e.preventDefault();
      openPalette();
    } else if (key === "s") {
      e.preventDefault();
      void saveFile(e.shiftKey);
    } else if (key === "r" && !e.shiftKey) {
      e.preventDefault();
      reloadFromDisk();
    } else if (key === "n") {
      e.preventDefault();
      void backend.newWindow();
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      zoomIn();
    } else if (key === "-") {
      e.preventDefault();
      zoomOut();
    } else if (key === "0") {
      e.preventDefault();
      zoomActual();
    }
  });
}

// The filename/path are click targets (switch file); the rest of the bar
// is the drag surface, since a drag-region element swallows clicks.
$("file-name").addEventListener("click", openPalette);
$("file-path").addEventListener("click", openPalette);

const indexStatusEl = $("index-status");

async function refreshIndexStatus() {
  const status = await backend.indexStatus();
  indexStatusEl.textContent = status.indexing
    ? "indexing…"
    : `${status.count.toLocaleString()} files indexed`;
}

// The index is served from a disk cache between launches; click the count
// to force a re-walk of the roots.
indexStatusEl.title = "Click to reindex";
indexStatusEl.addEventListener("click", () => {
  indexStatusEl.textContent = "indexing…";
  void backend.refreshIndex();
});

// macOS "open with" requests queue in the backend; the open-request event is
// just a wake-up. Drain on event and once at startup (for requests that
// arrived before this listener existed).
async function drainOpenRequests() {
  const paths = await backend.takePendingOpen();
  const last = paths[paths.length - 1];
  if (last) await openFile(last);
}

// User theme.css: unlimited typography depth without more panel rows.
async function loadUserTheme() {
  const css = await backend.readThemeCss();
  if (css) {
    const style = document.createElement("style");
    style.id = "user-theme";
    style.textContent = css;
    document.head.appendChild(style);
  }
}

async function main() {
  initAppearancePanel();
  void loadUserTheme();
  if (IN_TAURI) {
    await initMenu();
    await listen("open-request", () => void drainOpenRequests());
    await listen<number>("index-ready", (event) => {
      indexStatusEl.textContent = `${event.payload.toLocaleString()} files indexed`;
    });
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void syncWithDisk();
    });
  }

  // Windows spawned by File > New boot straight into an untitled document
  // (and skip the open queue: this window can't have anything pending).
  if (new URLSearchParams(location.search).has("untitled")) {
    await newUntitled();
  } else {
    await drainOpenRequests();
  }
  await refreshIndexStatus();
}

void main();

// Dev-only WKWebView ground truth: run the toggle sweep inside the real
// Tauri webview and write results to a file, since the webview cannot be
// driven by external tooling. Never runs in production builds.
if (import.meta.env.DEV && IN_TAURI && localStorage.getItem("selftest")) {
  setTimeout(async () => {
    try {
      await openFile(
        "/Users/ben/Documents/Projects/code/enzo/md-machine/samples/markdown-cheatsheet.md"
      );
      const ed = $("editor");
      const milk = document.querySelector(".milkdown") as HTMLElement;
      const pm = document.querySelector(".ProseMirror") as HTMLElement;
      if (!milk || !pm) return;
      const cs = (el: Element, p: string, pseudo?: string) =>
        getComputedStyle(el, pseudo).getPropertyValue(p);
      const set = (a: Record<string, string>) =>
        Object.entries(a).forEach(([k, v]) => (ed.dataset[k] = v));
      const hr = pm.querySelector("hr");
      const h1 = pm.querySelector("h1");
      const results: Record<string, unknown> = {
        doc: document.title,
        hasHr: !!hr,
        hasH1: !!h1,
        blocks: [...pm.children].map((c) => c.tagName).slice(0, 20),
      };
      set({ voice: "novel", density: "relaxed" });
      results.relaxedLh = cs(milk, "line-height");
      set({ density: "compact" });
      results.compactLh = cs(milk, "line-height");
      set({ density: "standard" });
      results.standardLh = cs(milk, "line-height");
      if (hr) {
        set({ sectionBreak: "fleuron" });
        results.fleuronBreak = cs(hr, "content", "::before");
        set({ sectionBreak: "dinkus" });
        results.dinkusBreak = cs(hr, "content", "::before");
        results.dinkusColor = cs(hr, "color", "::before");
        set({ sectionBreak: "auto" });
        results.autoBreakNovel = cs(hr, "content", "::before");
      }
      if (h1) {
        set({ ornaments: "on" });
        results.ornamentOn = cs(h1, "content", "::after");
        set({ ornaments: "off" });
        results.ornamentOff = cs(h1, "content", "::after");
        set({ ornaments: "auto" });
        results.ornamentAutoNovel = cs(h1, "content", "::after");
        set({ headingCase: "normal" });
        results.caseNormal = cs(h1, "font-variant-caps");
        set({ headingCase: "auto" });
      }
      await backend.writeFile(
        "/tmp/mdmachine-selftest.json",
        JSON.stringify(results, null, 2)
      );
    } catch (err) {
      await backend.writeFile("/tmp/mdmachine-selftest.json", String(err));
    }
  }, 4000);
}
