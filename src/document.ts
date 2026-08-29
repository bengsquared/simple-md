// The open/save/conflict state machine for the single open document.
// Owns the editor instance, the titlebar file info and Save/reload buttons,
// and the disk-conflict bar. Callers get four verbs: open, save,
// reloadFromDisk, syncWithDisk - the mtime/baseline bookkeeping stays here.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Crepe } from "@milkdown/crepe";
import { backend } from "./ipc";
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

export async function openFile(path: string) {
  try {
    const file = await backend.readFile(path);
    currentPath = path;
    loadedMtime = file.mtime;
    await mountEditor(file.content);
    setDirty(false);
    hideConflict();
    reloadBtn.disabled = false;
    const name = fileName(path);
    fileNameEl.textContent = name;
    filePathEl.textContent = middleTruncate(tildify(path), 90);
    void getCurrentWindow().setTitle(name);
  } catch (err) {
    flashStatus(`open failed: ${err}`);
  }
}

export async function saveFile(force = false) {
  if (!crepe || !currentPath) return;
  if (!force) {
    // Refuse to silently clobber a file another agent rewrote after we
    // loaded it; surface the conflict bar instead.
    const disk = await backend.statMtime(currentPath);
    if (disk !== null && disk !== loadedMtime) {
      showConflict("The file changed on disk since you loaded it.");
      return;
    }
  }
  try {
    const markdown = crepe.getMarkdown();
    loadedMtime = await backend.writeFile(currentPath, markdown);
    baselineMarkdown = markdown;
    setDirty(false);
    hideConflict();
    flashStatus("saved");
  } catch (err) {
    flashStatus(`save failed: ${err}`);
  }
}

export function reloadFromDisk() {
  if (currentPath) void openFile(currentPath);
}

// When the window regains focus and the file changed underneath us (the
// AI-rewrote-the-doc case): clean editor reloads silently; unsaved local
// edits raise the conflict bar so you choose.
export async function syncWithDisk() {
  if (!currentPath) return;
  const mtime = await backend.statMtime(currentPath);
  if (mtime === null || mtime === loadedMtime) return;
  if (dirty) {
    showConflict("The file changed on disk while you have unsaved edits.");
  } else {
    await openFile(currentPath);
    flashStatus("reloaded from disk");
  }
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
