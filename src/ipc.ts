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

export const backend = {
  searchFiles: (query: string) =>
    invoke<SearchResult[]>("search_files", { query }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  /** Returns the file's new mtime. */
  writeFile: (path: string, content: string) =>
    invoke<number>("write_file", { path, content }),
  /** null when the path is not a readable file. */
  statMtime: (path: string) => invoke<number | null>("stat_mtime", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  /** Force a full re-walk of the roots (async; index-ready event follows). */
  refreshIndex: () => invoke<void>("refresh_index"),
  /** Drains the queue of files macOS asked us to open. */
  takePendingOpen: () => invoke<string[]>("take_pending_open"),
};
