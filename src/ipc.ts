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
  newWindow: async () => {
    window.open(location.href);
  },
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
  /** Opens an additional editor window. */
  newWindow: () => invoke<void>("new_window"),
};

export const backend = IN_TAURI ? tauriBackend : demoBackend;
