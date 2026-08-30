// The only module that knows the backend command names and wire shapes.
// Outside Tauri (plain browser via `pnpm dev`) a stub backend serves the
// sample docs so the rendering can be reviewed and screenshotted in Chrome.
import { invoke } from "@tauri-apps/api/core";

export const IN_TAURI = "__TAURI_INTERNALS__" in window;

export interface FileContent {
  content: string;
  mtime: number;
}

export interface SearchResult {
  path: string;
  score: number;
}

export interface IndexStatus {
  count: number;
  indexing: boolean;
}

/** Did this backend error signal a save conflict (vs. an IO failure)? */
export function isConflict(err: unknown): boolean {
  return String(err).startsWith("conflict");
}

const DEMO_FILES = [
  "/samples/markdown-cheatsheet.md",
  "/samples/alice-staged.md",
  "/samples/markdown-syntax-gruber-2004.md",
  "/samples/semver-spec.md",
  "/samples/ydkjs-staged.md",
];

const demoBackend: typeof tauriBackend = {
  searchFiles: async (query: string) =>
    DEMO_FILES.filter((p) =>
      p.toLowerCase().includes(query.trim().toLowerCase())
    ).map((path) => ({ path, score: 0 })),
  readFile: async (path: string) => {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return { content: await res.text(), mtime: 1 };
  },
  writeFile: async () => 1,
  statMtime: async () => 1,
  pathExists: async () => false,
  indexStatus: async () => ({ count: DEMO_FILES.length, indexing: false }),
  refreshIndex: async () => {},
  takePendingOpen: async () => [DEMO_FILES[0]],
  newWindow: async (untitled?: boolean) => {
    const url = new URL(location.href);
    if (untitled) url.searchParams.set("untitled", "");
    window.open(url.toString());
  },
  readThemeCss: async () => null,
  setWindowTheme: async () => {},
  pickOpenPath: async () => null,
  pickSavePath: async () => null,
  openExternal: async (url: string) => {
    window.open(url, "_blank", "noopener");
  },
  noteRecentFile: async () => {},
  setWindowDocument: async () => {},
};

const tauriBackend = {
  searchFiles: (query: string) =>
    invoke<SearchResult[]>("search_files", { query }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  /**
   * Atomic save returning the file's new mtime. When expectedMtime is
   * given, the backend refuses with a conflict error (see isConflict) if
   * the file on disk changed since; omit it to force-overwrite.
   */
  writeFile: (path: string, content: string, expectedMtime?: number) =>
    invoke<number>("write_file", { path, content, expectedMtime }),
  /** null when the path is not a readable file. */
  statMtime: (path: string) => invoke<number | null>("stat_mtime", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  /** Force a full re-walk of the roots (async; index-ready event follows). */
  refreshIndex: () => invoke<void>("refresh_index"),
  /** Drains the queue of files macOS asked us to open. */
  takePendingOpen: () => invoke<string[]>("take_pending_open"),
  /** Opens an additional editor window; untitled boots it into a new doc. */
  newWindow: (untitled?: boolean) => invoke<void>("new_window", { untitled }),
  /** User override stylesheet (app config dir/theme.css), or null. */
  readThemeCss: () => invoke<string | null>("read_theme_css"),
  /** Native window theme: "light" | "dark" | "auto" (follow system). */
  setWindowTheme: (theme: string) => invoke<void>("set_window_theme", { theme }),
  /** Native open panel; null when cancelled. */
  pickOpenPath: () => invoke<string | null>("pick_open_path"),
  /** Open an http(s)/mailto link in the system default browser. */
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** Native save panel seeded with defaultName; null when cancelled. */
  pickSavePath: (defaultName?: string) =>
    invoke<string | null>("pick_save_path", { defaultName }),
  /** Add a successfully opened file to File > Open Recent. */
  noteRecentFile: (path: string) => invoke<void>("note_recent_file", { path }),
  /** Native dirty dot + titlebar proxy icon for this window. */
  setWindowDocument: (path: string | null, edited: boolean) =>
    invoke<void>("set_window_document", { path, edited }),
};

export const backend = IN_TAURI ? tauriBackend : demoBackend;
