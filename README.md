# MD Machine

Local-only macOS desktop app for finding, rendering, and editing markdown (and other text) files in a WYSIWYG editor.
Built for the workflow where an AI agent writes `.md` docs into repo worktrees and you need to locate, read, critique, and edit them fast.
A ~6 MB app: paste a path or fuzzy-type a name, read it typeset properly (mermaid included), edit, save.

## Stack

- Shell: [Tauri 2](https://tauri.app) (Rust core + macOS WKWebView), ~10 MB app.
- Editor: [Milkdown Crepe](https://milkdown.dev) (ProseMirror-based, markdown-first WYSIWYG).
- Diagrams: [mermaid](https://mermaid.js.org) rendered live inside code blocks.
- Search: Rust backend using the `ignore` crate (ripgrep's walker, respects `.gitignore`) and `nucleo-matcher` (Helix's fuzzy matcher).

## Usage

- `⌘P` / `⌘O` opens the quick-open palette. Paste a full or partial path (e.g. `docs/specs/2026-08-29-foo.md`) or fuzzy-type a filename.
- `⌘S` saves. `⌘R` reloads from disk.
- If a file changes on disk while open (an agent rewrote it) and you have no unsaved edits, it auto-reloads when the window regains focus.
- Installed as a standard `.app` with file associations for `.md`, `.markdown`, `.mdown`, `.mdx`, `.txt`.

## Search index

At startup the Rust side walks the configured roots (default: `~/Documents`, `~/Desktop`, `~/Downloads`), respecting `.gitignore`, and indexes text-document extensions (`md`, `markdown`, `mdx`, `txt`, `rst`, `adoc`, `org`), sorted most-recently-modified first.
Roots are configurable in `~/Library/Application Support/co.useenso.mdmachine/roots.json` as `{"roots": ["~/path", ...]}`.

## Develop / build

```sh
pnpm install
pnpm tauri dev      # run in dev mode
pnpm tauri build    # produce .app / .dmg in src-tauri/target/release/bundle
```

## Features

- Quick-open palette (`⌘P`): fuzzy search over a gitignore-aware index of your text files, live-updated by a filesystem watcher, cached across launches. Paste a nonexistent path to create the file.
- WYSIWYG editing via Milkdown Crepe with mermaid diagrams rendered inline.
- Safe saves: atomic temp+rename writes with server-side mtime conflict detection - if an agent rewrote the file under your edits, you get a conflict bar (reload / overwrite), never a silent clobber. Clean editors auto-reload on focus.
- Appearance panel: content width, body/heading fonts, centered titles, zoom.
- Multiple windows (`⌘N`); native macOS window tabbing applies.
- File associations for `.md`, `.markdown`, `.mdown`, `.mdx`, `.txt`.

## License

MIT - see [LICENSE](LICENSE).
