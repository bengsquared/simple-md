// The only module that knows the backend command names and wire shapes.
import { invoke } from "@tauri-apps/api/core";

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

export const backend = {
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
};
