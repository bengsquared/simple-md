import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crepe } from "@milkdown/crepe";
import mermaid from "mermaid";

import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./styles.css";

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

const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({
  startOnLoad: false,
  theme: isDark ? "dark" : "default",
  securityLevel: "strict",
});

let crepe: Crepe | null = null;
let currentPath: string | null = null;
let loadedMtime = 0;
let dirty = false;
let mermaidSeq = 0;

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
    listener.markdownUpdated(() => setDirty(true));
  });
  await crepe.create();
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
    const name = path.split("/").pop() ?? path;
    fileNameEl.textContent = name;
    filePathEl.textContent = path;
    getCurrentWindow().setTitle(name);
  } catch (err) {
    flashSaveStatus(`open failed: ${err}`);
  }
}

async function saveFile() {
  if (!crepe || !currentPath) return;
  try {
    const markdown = crepe.getMarkdown();
    loadedMtime = await invoke<number>("write_file", {
      path: currentPath,
      content: markdown,
    });
    setDirty(false);
    flashSaveStatus("saved");
  } catch (err) {
    flashSaveStatus(`save failed: ${err}`);
  }
}

// Reload from disk when the window regains focus and the file changed
// underneath us (the AI-rewrote-the-doc case). Never clobber unsaved edits.
async function maybeReloadOnFocus() {
  if (!currentPath || dirty) return;
  const mtime = await invoke<number | null>("stat_mtime", {
    path: currentPath,
  });
  if (mtime !== null && mtime !== loadedMtime) {
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
    dir.textContent = r.path.slice(0, r.path.lastIndexOf("/"));
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
    void saveFile();
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

async function main() {
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
