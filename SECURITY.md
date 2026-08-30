# Security notes

Simple MD is a local-only, single-user desktop editor.
There is no network surface: the CSP allows no remote scripts, styles, or connections, and the app makes no outbound requests.
This document records the audit steps that keep the dependency tree clean and the risks that are accepted deliberately.
Do not "fix" an accepted risk into a sandbox or permission prompt without an explicit decision to change the product's trust model.

## Audit routine

- `cargo audit` over `src-tauri/Cargo.lock` (install with `cargo install cargo-audit --locked`).
- `pnpm audit` over the JS tree.
- Review `src-tauri/capabilities/default.json` and the CSP in `src-tauri/tauri.conf.json` after any capability or plugin change.

Last run: 2026-08-30.
`pnpm audit`: no known vulnerabilities.
`cargo audit`: no vulnerabilities; 17 warnings, all "unmaintained"/"unsound" notices in Linux-only GTK crates and the `unic-*` family pulled in by Tauri's cross-platform dependency tree.
None of those crates are compiled into the macOS binary, so they are noise here; re-check if the app ever targets Linux.

## Trust model

The app trusts the local user completely and trusts local file content partially.
Documents are untrusted input to the renderer; the local user's configuration is trusted input.

## Accepted risks (by design)

- `read_file` / `write_file` accept arbitrary paths.
  This is the product: a local editor that opens what the user asks for, including paths typed into the palette and files handed over by Finder.
  Sandboxing to selected roots would break "Open With" and agent-driven workflows.
- Mermaid renders untrusted markdown content.
  Defense layers: mermaid runs with `securityLevel: "strict"`, and the CSP blocks remote scripts, remote styles, and all outbound connections, so a malicious diagram cannot exfiltrate or execute.
- `theme.css` is user-authored CSS injected into every window.
  It is a local file in the app config directory, writable only by the local user, and CSS in a no-network page cannot exfiltrate content.
  `style-src 'unsafe-inline'` exists for this and for the editor's inline styles.
- The webview capability surface is minimal on purpose: `core:default`, `set-title`, `start-dragging`.
  The dialog plugin is registered but only called from Rust commands, so the webview has no dialog permissions.
- `recents.json` stores recently opened paths in plain text in the app config directory.
  Paths are not secrets in a single-user app; clearing File > Open Recent deletes them.

## Non-goals

Code signing and notarization are tracked in the backlog, not here.
