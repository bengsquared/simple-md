# Numeric POC Analysis Design

A test document for **MD Machine** with common markdown features.

## Architecture

```mermaid
flowchart LR
    A[Agent writes .md] --> B(md-machine index)
    B --> C{Quick open}
    C -->|render| D[Crepe WYSIWYG]
    C -->|edit| E[Save to disk]
```

## Checklist

- [x] File search
- [x] Mermaid rendering
- [ ] Styling polish

## Table

| Piece | Language | Role |
| --- | --- | --- |
| Tauri 2 | Rust | Shell + search |
| Milkdown Crepe | TS | Editor |

> Blockquote with `inline code` and [a link](https://example.com).

```python
def hello():
    return "world"
```
