// The open/save/conflict state machine for the single open document.
// Owns the editor instance, the titlebar file info and Save/reload buttons,
// and the disk-conflict bar. Callers get four verbs: open, save,
// reloadFromDisk, syncWithDisk - the mtime/baseline bookkeeping stays here.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crepe } from "@milkdown/crepe";
import { backend, isConflict, IN_TAURI } from "./ipc";
import { $ } from "./dom";
import { tildify, middleTruncate, fileName } from "./paths";
import { renderMermaidPreview } from "./mermaid-preview";

const editorEl = $("editor");
const emptyStateEl = $("empty-state");
const fileNameEl = $("file-name");
const filePathEl = $("file-path");
const dirtyDotEl = $("dirty-dot");
const saveStatusEl = $("save-status");
const saveBtn = $<HTMLButtonElement>("btn-save");
const reloadBtn = $<HTMLButtonElement>("btn-reload");
const conflictBar = $("conflict-bar");
const conflictMsg = $("conflict-msg");

let crepe: Crepe | null = null;
let currentPath: string | null = null;
let loadedMtime = 0;
// Serialized form of the doc as loaded/saved; edits compare against this so
// undoing back to the original clears the dirty state.
let baselineMarkdown = "";
let dirty = false;

function setDirty(value: boolean) {
  if (dirty !== value) void backend.setWindowDocument(currentPath, value);
  dirty = value;
  dirtyDotEl.hidden = !value;
  saveBtn.disabled = !value;
}

// Point the titlebar (ours and the native one: title, proxy icon) at the
// current document. Null path = untitled.
function setFileChrome(path: string | null) {
  const name = path ? fileName(path) : "Untitled";
  fileNameEl.textContent = name;
  filePathEl.textContent = path ? middleTruncate(tildify(path), 90) : "";
  if (IN_TAURI) void getCurrentWindow().setTitle(name);
  void backend.setWindowDocument(path, dirty);
}

function flashStatus(text: string) {
  saveStatusEl.textContent = text;
  setTimeout(() => {
    if (saveStatusEl.textContent === text) saveStatusEl.textContent = "";
  }, 2500);
}

function showConflict(message: string) {
  conflictMsg.textContent = message;
  conflictBar.hidden = false;
}

function hideConflict() {
  conflictBar.hidden = true;
}

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

async function doOpenFile(path: string) {
  let file;
  try {
    file = await backend.readFile(path);
  } catch (err) {
    // Read failed before anything was torn down; the current doc is intact.
    flashStatus(`open failed: ${err}`);
    return;
  }
  try {
    await mountEditor(file.content);
  } catch (err) {
    // The old editor is already destroyed; fall back to the empty state
    // rather than leaving state pointing at a doc that never mounted.
    crepe = null;
    currentPath = null;
    editorEl.innerHTML = "";
    emptyStateEl.hidden = false;
    fileNameEl.textContent = "No file open";
    filePathEl.textContent = "";
    reloadBtn.disabled = true;
    setDirty(false);
    flashStatus(`open failed: ${err}`);
    return;
  }
  // Only real document switches touch Open Recent: silent reloads and
  // Revert re-open the same path and must not churn the native menu.
  if (path !== currentPath) void backend.noteRecentFile(path);
  currentPath = path;
  loadedMtime = file.mtime;
  setDirty(false);
  hideConflict();
  reloadBtn.disabled = false;
  setFileChrome(path);
}

// A fresh untitled document (File > New). It has no path until the first
// save, which routes through the native save panel.
async function doNewUntitled() {
  try {
    await mountEditor("");
  } catch (err) {
    flashStatus(`new document failed: ${err}`);
    return;
  }
  currentPath = null;
  loadedMtime = 0;
  setDirty(false);
  hideConflict();
  reloadBtn.disabled = true;
  setFileChrome(null);
}

// `pathOverride` (Save As, untitled first save) writes to a new location.
// The document's path and chrome only move over AFTER the write succeeds:
// a failed save must never strand the document pointing at a dead path.
async function doSaveFile(force: boolean, pathOverride?: string) {
  if (!crepe) return;
  let path = pathOverride ?? currentPath;
  if (!path) {
    // Untitled: the first save is a Save As through the native panel,
    // which already confirmed any overwrite.
    const picked = await backend.pickSavePath("Untitled.md");
    if (!picked) return;
    path = picked;
    force = true;
  }
  try {
    const markdown = crepe.getMarkdown();
    // The backend compares mtimes and writes atomically in one call, so an
    // agent rewriting the file between check and write cannot be clobbered.
    loadedMtime = await backend.writeFile(
      path,
      markdown,
      force ? undefined : loadedMtime
    );
    currentPath = path;
    baselineMarkdown = markdown;
    setDirty(false);
    hideConflict();
    reloadBtn.disabled = false;
    setFileChrome(path);
    void backend.noteRecentFile(path);
    flashStatus("saved");
  } catch (err) {
    if (isConflict(err)) {
      showConflict("The file changed on disk since you loaded it.");
    } else {
      flashStatus(`save failed: ${err}`);
    }
  }
}

// When the window regains focus and the file changed underneath us (the
// AI-rewrote-the-doc case): clean editor reloads silently; unsaved local
// edits raise the conflict bar so you choose.
async function doSyncWithDisk() {
  if (!currentPath) return;
  const mtime = await backend.statMtime(currentPath);
  if (mtime === null || mtime === loadedMtime) return;
  if (dirty) {
    showConflict("The file changed on disk while you have unsaved edits.");
  } else {
    await doOpenFile(currentPath);
    flashStatus("reloaded from disk");
  }
}

// All document operations are serialized through one chain so a palette
// pick, a macOS open request, a save, and a focus-triggered reload can
// never interleave (mountEditor is not reentrant, and a focus event landing
// mid-save must not read half-updated mtime/dirty state).
let chain: Promise<unknown> = Promise.resolve();

function serialized<A extends unknown[]>(
  fn: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  return (...args: A) => {
    const next = chain.then(() => fn(...args));
    chain = next.catch(() => {});
    return next;
  };
}

export const openFile = serialized(doOpenFile);
export const saveFile = serialized((force: boolean = false) =>
  doSaveFile(force)
);
export const syncWithDisk = serialized(doSyncWithDisk);
export const newUntitled = serialized(doNewUntitled);

// Save As: write to a path picked in the native panel (forced - the panel
// confirmed any overwrite). doSaveFile adopts the new path only on success.
export const saveFileAs = serialized(async () => {
  if (!crepe) return;
  const picked = await backend.pickSavePath(
    currentPath ? fileName(currentPath) : "Untitled.md"
  );
  if (!picked) return;
  await doSaveFile(true, picked);
});

export function hasDocument(): boolean {
  return crepe !== null;
}

export function reloadFromDisk() {
  if (currentPath) void openFile(currentPath);
}

saveBtn.disabled = true;
reloadBtn.disabled = true;
saveBtn.addEventListener("click", () => void saveFile());
reloadBtn.addEventListener("click", reloadFromDisk);
$("conflict-reload").addEventListener("click", () => {
  hideConflict();
  reloadFromDisk();
});
$("conflict-overwrite").addEventListener("click", () => void saveFile(true));
$("conflict-dismiss").addEventListener("click", hideConflict);
