// Renders ```mermaid code blocks as diagrams inside Crepe's code-block
// preview slot. Everything mermaid-specific lives here.
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "default",
  securityLevel: "strict",
});

let seq = 0;

export function renderMermaidPreview(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void
): void | null {
  if (language.toLowerCase() !== "mermaid" || !content.trim()) return null;
  const id = `mermaid-${seq++}`;
  mermaid
    .render(id, content)
    .then(({ svg }) => {
      const wrap = document.createElement("div");
      wrap.className = "mermaid-preview";
      wrap.innerHTML = svg;
      applyPreview(wrap);
    })
    .catch((err: unknown) => {
      // mermaid.render leaves an orphaned error element behind; clean it up
      document.getElementById(`d${id}`)?.remove();
      const el = document.createElement("div");
      el.className = "mermaid-error";
      el.textContent = `mermaid: ${err instanceof Error ? err.message : err}`;
      applyPreview(el);
    });
}
