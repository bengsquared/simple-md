import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crepe } from "@milkdown/crepe";
import mermaid from "mermaid";

import "@milkdown/crepe/theme/common/style.css";
import frameLight from "@milkdown/crepe/theme/frame.css?url";
import frameDark from "@milkdown/crepe/theme/frame-dark.css?url";
import "./styles.css";

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

interface FileContent {
  content: string;
  mtime: number;
}

interface SearchResult {
  path: string;
  score: number;
}

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const editorEl = $("editor");
const emptyStateEl = $("empty-state");
const fileNameEl = $("file-name");
const filePathEl = $("file-path");
const dirtyDotEl = $("dirty-dot");
const indexStatusEl = $("index-status");
const saveStatusEl = $("save-status");
const overlayEl = $("palette-overlay");
const inputEl = $<HTMLInputElement>("palette-input");
const resultsEl = $<HTMLUListElement>("palette-results");

/** /Users/<name>/foo -> ~/foo */
function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Keep the informative tail of a path, truncating the middle. */
function middleTruncate(path: string, max: number): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let tail = "";
  for (let i = parts.length - 1; i > 0; i--) {
    const next = parts[i] + (tail ? "/" + tail : "");
    if (next.length + 2 > max) break;
    tail = next;
  }
  return (parts[0] || "/") + "/…/" + tail;
}

const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({
  startOnLoad: false,
  theme: isDark ? "dark" : "default",
  securityLevel: "strict",
});

let crepe: Crepe | null = null;
let currentPath: string | null = null;
let loadedMtime = 0;
// Serialized form of the doc as loaded/saved; edits compare against this so
// undoing back to the original clears the dirty state.
let baselineMarkdown = "";
let dirty = false;
let mermaidSeq = 0;

// ---------- Appearance preferences ----------

interface Prefs {
  width: "narrow" | "medium" | "wide" | "full";
  font: "sans" | "serif" | "mono";
  headingFont: "sans" | "serif";
  titles: "left" | "center";
  zoom: string;
}

const DEFAULT_PREFS: Prefs = {
  width: "medium",
  font: "sans",
  headingFont: "serif",
  titles: "left",
  zoom: "1",
};

const WIDTHS: Record<Prefs["width"], string> = {
  narrow: "680px",
  medium: "860px",
  wide: "1080px",
  full: "100%",
};

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("prefs") ?? "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

let prefs = loadPrefs();

function applyPrefs() {
  const root = document.documentElement.style;
  root.setProperty("--content-width", WIDTHS[prefs.width] ?? WIDTHS.medium);
  root.setProperty("--editor-zoom", prefs.zoom);
  const fontVar = (f: string) =>
    f === "serif" ? "var(--font-serif)" : f === "mono" ? "var(--font-mono)" : "var(--font-sans)";
  root.setProperty("--editor-body-font", fontVar(prefs.font));
  root.setProperty("--editor-heading-font", fontVar(prefs.headingFont));
  editorEl.classList.toggle("centered-titles", prefs.titles === "center");
  // Reflect active state in the panel.
  document.querySelectorAll<HTMLElement>(".ap-seg").forEach((seg) => {
    const key = seg.dataset.pref as keyof Prefs;
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.v === String(prefs[key]));
    });
  });
}

function initAppearancePanel() {
  const panel = $("appearance-panel");
  $("btn-appearance").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("mousedown", (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) panel.hidden = true;
  });
  panel.querySelectorAll<HTMLButtonElement>(".ap-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = (btn.parentElement as HTMLElement).dataset.pref as keyof Prefs;
      (prefs as unknown as Record<string, string>)[key] = btn.dataset.v!;
      localStorage.setItem("prefs", JSON.stringify(prefs));
      applyPrefs();
    });
  });
  applyPrefs();
}

// ---------- Mermaid preview inside Crepe code blocks ----------

function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void
): void | null {
  if (language.toLowerCase() !== "mermaid" || !content.trim()) return null;
  const id = `mermaid-${mermaidSeq++}`;
  mermaid
    .render(id, content)
    .then(({ svg }) => {
      const wrap = document.createElement("div");
      wrap.className = "mermaid-preview";
      wrap.innerHTML = svg;
      applyPreview(wrap);
    })
    .catch((err: unknown) => {
      // mermaid.render leaves an orphaned error element behind; clean it up
      document.getElementById(`d${id}`)?.remove();
      const el = document.createElement("div");
      el.className = "mermaid-error";
      el.textContent = `mermaid: ${err instanceof Error ? err.message : err}`;
      applyPreview(el);
    });
}

// ---------- Editor lifecycle ----------

async function mountEditor(markdown: string) {
  if (crepe) {
    await crepe.destroy();
    crepe = null;
  }
  editorEl.innerHTML = "";
  crepe = new Crepe({
    root: editorEl,
    defaultValue: markdown,
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        renderPreview: renderMermaidPreview,
        previewOnlyByDefault: true,
      },
    },
  });
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md) => setDirty(md !== baselineMarkdown));
  });
  await crepe.create();
  baselineMarkdown = crepe.getMarkdown();
  emptyStateEl.hidden = true;
}

function setDirty(value: boolean) {
  dirty = value;
  dirtyDotEl.hidden = !value;
}

function flashSaveStatus(text: string) {
  saveStatusEl.textContent = text;
  setTimeout(() => {
    if (saveStatusEl.textContent === text) saveStatusEl.textContent = "";
  }, 2500);
}

async function openFile(path: string) {
  try {
    const file = await invoke<FileContent>("read_file", { path });
    currentPath = path;
    loadedMtime = file.mtime;
    await mountEditor(file.content);
    setDirty(false);
    hideConflict();
    const name = path.split("/").pop() ?? path;
    fileNameEl.textContent = name;
    filePathEl.textContent = middleTruncate(tildify(path), 90);
    getCurrentWindow().setTitle(name);
  } catch (err) {
    flashSaveStatus(`open failed: ${err}`);
  }
}

async function saveFile(force = false) {
  if (!crepe || !currentPath) return;
  if (!force) {
    // Refuse to silently clobber a file another agent rewrote after we
    // loaded it; surface the conflict bar instead.
    const disk = await invoke<number | null>("stat_mtime", { path: currentPath });
    if (disk !== null && disk !== loadedMtime) {
      showConflict("The file changed on disk since you loaded it.");
      return;
    }
  }
  try {
    const markdown = crepe.getMarkdown();
    loadedMtime = await invoke<number>("write_file", {
      path: currentPath,
      content: markdown,
    });
    baselineMarkdown = markdown;
    setDirty(false);
    hideConflict();
    flashSaveStatus("saved");
  } catch (err) {
    flashSaveStatus(`save failed: ${err}`);
  }
}

// ---------- Disk conflict handling ----------

const conflictBar = $("conflict-bar");
const conflictMsg = $("conflict-msg");

function showConflict(message: string) {
  conflictMsg.textContent = message;
  conflictBar.hidden = false;
}

function hideConflict() {
  conflictBar.hidden = true;
}

$("conflict-reload").addEventListener("click", () => {
  hideConflict();
  if (currentPath) void openFile(currentPath);
});
$("conflict-overwrite").addEventListener("click", () => void saveFile(true));
$("conflict-dismiss").addEventListener("click", hideConflict);

// When the window regains focus and the file changed underneath us (the
// AI-rewrote-the-doc case): clean editor reloads silently; unsaved local
// edits raise the conflict bar so you choose.
async function maybeReloadOnFocus() {
  if (!currentPath) return;
  const mtime = await invoke<number | null>("stat_mtime", {
    path: currentPath,
  });
  if (mtime === null || mtime === loadedMtime) return;
  if (dirty) {
    showConflict("The file changed on disk while you have unsaved edits.");
  } else {
    await openFile(currentPath);
    flashSaveStatus("reloaded from disk");
  }
}

// ---------- Quick-open palette ----------

let results: SearchResult[] = [];
let selected = 0;
let searchToken = 0;

function openPalette() {
  overlayEl.hidden = false;
  inputEl.value = "";
  inputEl.focus();
  void runSearch("");
}

function closePalette() {
  overlayEl.hidden = true;
}

async function runSearch(query: string) {
  const token = ++searchToken;
  const q = query.trim();

  let found: SearchResult[] = [];
  // Pasted absolute or ~ path: offer it directly, even if outside the index.
  if (q.startsWith("/") || q.startsWith("~")) {
    if (await invoke<boolean>("path_exists", { path: q })) {
      found.push({ path: q, score: 0 });
    }
  }
  found = found.concat(
    await invoke<SearchResult[]>("search_files", { query: q })
  );
  if (token !== searchToken) return; // a newer search superseded this one

  results = found;
  selected = 0;
  renderResults();
}

function renderResults() {
  resultsEl.innerHTML = "";
  if (results.length === 0) {
    const li = document.createElement("li");
    li.className = "r-empty";
    li.textContent = "No matching files";
    resultsEl.appendChild(li);
    return;
  }
  results.slice(0, 50).forEach((r, i) => {
    const li = document.createElement("li");
    if (i === selected) li.classList.add("selected");
    const name = document.createElement("div");
    name.className = "r-name";
    name.textContent = r.path.split("/").pop() ?? r.path;
    const dir = document.createElement("div");
    dir.className = "r-dir";
    dir.textContent = middleTruncate(
      tildify(r.path.slice(0, r.path.lastIndexOf("/"))),
      78
    );
    li.append(name, dir);
    li.addEventListener("click", () => {
      closePalette();
      void openFile(r.path);
    });
    resultsEl.appendChild(li);
  });
  resultsEl
    .querySelector(".selected")
    ?.scrollIntoView({ block: "nearest" });
}

inputEl.addEventListener("input", () => void runSearch(inputEl.value));

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selected = Math.min(selected + 1, Math.min(results.length, 50) - 1);
    renderResults();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selected = Math.max(selected - 1, 0);
    renderResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = results[selected];
    if (r) {
      closePalette();
      void openFile(r.path);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});

overlayEl.addEventListener("mousedown", (e) => {
  if (e.target === overlayEl) closePalette();
});

// ---------- Global shortcuts ----------

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
    if (currentPath) void openFile(currentPath);
  }
});

// ---------- Startup ----------

async function refreshIndexStatus() {
  const [count, indexing] = await invoke<[number, boolean]>("index_status");
  indexStatusEl.textContent = indexing
    ? "indexing…"
    : `${count.toLocaleString()} files indexed`;
}

$("btn-save").addEventListener("click", () => void saveFile());
$("btn-reload").addEventListener("click", () => {
  if (currentPath) void openFile(currentPath);
});

async function main() {
  initAppearancePanel();
  await listen<string[]>("open-files", (event) => {
    const path = event.payload[event.payload.length - 1];
    if (path) void openFile(path);
  });
  await listen<number>("index-ready", (event) => {
    indexStatusEl.textContent = `${event.payload.toLocaleString()} files indexed`;
  });
  getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void maybeReloadOnFocus();
  });

  const pending = await invoke<string[]>("take_pending_open");
  const launchFile = pending[pending.length - 1];
  if (launchFile) {
    await openFile(launchFile);
  }
  await refreshIndexStatus();
}

void main();
