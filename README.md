# Simple MD

A simple markdown viewer for macOS.
Local-only: find, render, critique, and edit markdown (and other text) files in a WYSIWYG editor, typeset properly.
Built for the workflow where an AI agent writes `.md` docs into repo worktrees and you need to read them fast - a ~6 MB app: paste a path or fuzzy-type a name, read it beautifully (mermaid included), edit, save.

## Rendering voices

The same markdown, four typographic traditions.
Voices are researched presets - trade-fiction book pages, LaTeX `article.cls` manners, magazine feature spreads - with every choice they make overridable through progressive controls.

| Novel | Paper |
| --- | --- |
| ![Novel voice](assets/voice-novel.png) | ![Paper voice](assets/voice-paper.png) |

| Standard | Magazine |
| --- | --- |
| ![Standard voice](assets/voice-standard.png) | ![Magazine voice](assets/voice-magazine.png) |

Specimens above: *Alice's Adventures in Wonderland* (Lewis Carroll, 1865), the [SemVer 2.0.0 spec](https://semver.org), [Gruber's original Markdown syntax doc](https://daringfireball.net/projects/markdown/syntax) (2004), and [*You Don't Know JS: Up & Going*](https://github.com/getify/You-Dont-Know-JS) ch. 1 (Kyle Simpson).

## Features

- Quick-open palette (`⌘P`): fuzzy search over a gitignore-aware index of your text files, live-updated by a filesystem watcher, cached across launches. Paste a nonexistent path to create the file.
- WYSIWYG editing via Milkdown Crepe with mermaid diagrams rendered inline; content-aware tables.
- Four rendering voices (Standard, Novel, Paper, Magazine) plus layered controls: fonts, width, zoom, then advanced overrides for heading case/alignment, paragraph style, justification (with implied hyphenation), density, section-break style (`---` as rule, dinkus, or fleuron), ornaments, and heading numbering.
- Light/dark/auto appearance driving the native window theme.
- Safe saves: atomic temp+rename writes with server-side mtime conflict detection - if an agent rewrote the file under your edits, you get a conflict bar (reload / overwrite), never a silent clobber. Clean editors auto-reload on focus.
- Multiple windows (`⌘N`); native macOS window tabbing applies.
- File associations for `.md`, `.markdown`, `.mdown`, `.mdx`, `.txt`.

## Usage

- `⌘P` / `⌘O` opens the quick-open palette; `⌘S` saves; `⌘⇧S` force-saves past a conflict; `⌘R` reloads from disk; `⌘N` opens a new window.
- Click the filename in the title bar to switch files; click the file count in the status bar to reindex.
- The `Aa` button opens the appearance panel.

## Search index

At startup the Rust side walks the configured roots (default: `~/Documents`, `~/Desktop`, `~/Downloads`), respecting `.gitignore`, and indexes text-document extensions (`md`, `markdown`, `mdx`, `txt`, `rst`, `adoc`, `org`), most-recently-modified first.
Roots are configurable in `~/Library/Application Support/co.useenso.simplemd/roots.json` as `{"roots": ["~/path", ...]}`.

## Custom typography

The Aa panel covers the common controls.
For unlimited depth, drop a `theme.css` beside `roots.json` - it loads after the built-in styles.
Hooks: voices are `#editor[data-voice="standard|novel|paper|magazine"]`; override attributes are `data-font`, `data-headings`, `data-heading-case`, `data-heading-align`, `data-heading-numbers`, `data-section-break`, `data-ornaments`, `data-paragraph`, `data-justify`, `data-density`.
Tokens: `--font-sans/-display/-newyork/-book/-charter/-mono`, `--voice-size`, `--voice-lh`, `--indent-depth`, `--content-width`, `--page-pad`, `--editor-zoom`.
A fifth personal voice is just CSS: style `#editor[data-voice="custom"]`.

## Built on the shoulders of

Simple MD is a thin shell around excellent open-source work:

- [Milkdown](https://milkdown.dev) and its [Crepe](https://milkdown.dev/docs/guide/using-crepe) editor by Mirone and contributors - the markdown-first WYSIWYG engine at the heart of the app (MIT).
- [ProseMirror](https://prosemirror.net) by Marijn Haverbeke - the rich-text toolkit under Milkdown - and [CodeMirror](https://codemirror.net), which powers the code blocks (MIT).
- [Mermaid](https://mermaid.js.org) for inline diagram rendering (MIT).
- [Tauri](https://tauri.app) - the Rust + WKWebView shell that keeps the whole app at ~6 MB (MIT/Apache-2.0).
- The [`ignore`](https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore) crate by Andrew Gallant - ripgrep's gitignore-aware directory walker (MIT/Unlicense).
- [`nucleo-matcher`](https://github.com/helix-editor/nucleo) from the Helix editor project - the fuzzy matcher behind the palette (MPL-2.0).
- [`notify`](https://github.com/notify-rs/notify) for filesystem watching, plus [serde](https://serde.rs), [Vite](https://vite.dev), and [TypeScript](https://www.typescriptlang.org).
- Typefaces are the ones Apple ships with macOS - Iowan Old Style (John Downer), Charter (Matthew Carter), New York, Palatino (Hermann Zapf), SF Pro - used as system fonts, not bundled.
- Typographic conventions owe much to Robert Bringhurst's *The Elements of Typographic Style* and Matthew Butterick's [*Practical Typography*](https://practicaltypography.com).

## Develop / build

```sh
pnpm install
pnpm tauri dev      # run in dev mode (also serves a browser demo at localhost:1420)
pnpm tauri build    # produce .app / .dmg in src-tauri/target/release/bundle
```

## License

MIT - see [LICENSE](LICENSE).
