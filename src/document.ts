// The open/save/conflict state machine for the single open document.
// Owns the editor instance, the titlebar file info and Save/reload buttons,
// and the disk-conflict bar. Callers get four verbs: open, save,
// reloadFromDisk, syncWithDisk - the mtime/baseline bookkeeping stays here.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crepe } from "@milkdown/crepe";
import { backend, isConflict } from "./ipc";
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
  dirty = value;
  dirtyDotEl.hidden = !value;
  saveBtn.disabled = !value;
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
  currentPath = path;
  loadedMtime = file.mtime;
  setDirty(false);
  hideConflict();
  reloadBtn.disabled = false;
  const name = fileName(path);
  fileNameEl.textContent = name;
  filePathEl.textContent = middleTruncate(tildify(path), 90);
  void getCurrentWindow().setTitle(name);
}

async function doSaveFile(force: boolean) {
  if (!crepe || !currentPath) return;
  try {
    const markdown = crepe.getMarkdown();
    // The backend compares mtimes and writes atomically in one call, so an
    // agent rewriting the file between check and write cannot be clobbered.
    loadedMtime = await backend.writeFile(
      currentPath,
      markdown,
      force ? undefined : loadedMtime
    );
    baselineMarkdown = markdown;
    setDirty(false);
    hideConflict();
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
