// Quick-open palette: fuzzy search over the backend index, plus direct
// pasted-path lookup. Owns its overlay DOM and keyboard handling.
import { backend, type SearchResult } from "./ipc";
import { $ } from "./dom";
import { tildify, middleTruncate, fileName, dirName } from "./paths";
import { openFile } from "./document";

const MAX_ROWS = 50;

const overlayEl = $("palette-overlay");
const inputEl = $<HTMLInputElement>("palette-input");
const resultsEl = $<HTMLUListElement>("palette-results");

// A row is an existing indexed/stat'd file, or an offer to create the
// typed path when it doesn't exist yet.
type Row = SearchResult & { create?: boolean };

let results: Row[] = [];
let selected = 0;
let searchToken = 0;

export function isPaletteOpen(): boolean {
  return !overlayEl.hidden;
}

export function openPalette() {
  overlayEl.hidden = false;
  inputEl.value = "";
  inputEl.focus();
  void runSearch("");
}

function closePalette() {
  overlayEl.hidden = true;
}

function pick(result: Row) {
  closePalette();
  if (result.create) {
    void backend
      .writeFile(result.path, "")
      .then(() => openFile(result.path));
    return;
  }
  void openFile(result.path);
}

async function runSearch(query: string) {
  const token = ++searchToken;
  const q = query.trim();

  let found: Row[] = [];
  // Pasted absolute or ~ path: offer it directly, even if outside the
  // index - or offer to create it if it names a text file that isn't there.
  if (q.startsWith("/") || q.startsWith("~")) {
    if (await backend.pathExists(q)) {
      found.push({ path: q, score: 0 });
    } else if (/\.(md|markdown|mdx|txt)$/i.test(q)) {
      found.push({ path: q, score: 0, create: true });
    }
  }
  found = found.concat(await backend.searchFiles(q));
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
  results.slice(0, MAX_ROWS).forEach((r, i) => {
    const li = document.createElement("li");
    if (i === selected) li.classList.add("selected");
    const name = document.createElement("div");
    name.className = "r-name";
    name.textContent = r.create
      ? `Create "${fileName(r.path)}"`
      : fileName(r.path);
    if (r.create) li.classList.add("r-create");
    const dir = document.createElement("div");
    dir.className = "r-dir";
    dir.textContent = middleTruncate(tildify(dirName(r.path)), 78);
    li.append(name, dir);
    li.addEventListener("click", () => pick(r));
    resultsEl.appendChild(li);
  });
  resultsEl.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

inputEl.addEventListener("input", () => void runSearch(inputEl.value));

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selected = Math.min(selected + 1, Math.min(results.length, MAX_ROWS) - 1);
    renderResults();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selected = Math.max(selected - 1, 0);
    renderResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (results[selected]) pick(results[selected]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});

overlayEl.addEventListener("mousedown", (e) => {
  if (e.target === overlayEl) closePalette();
});
