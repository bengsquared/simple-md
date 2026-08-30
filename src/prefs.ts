// Appearance preferences: the panel, persistence, and how each choice maps
// onto CSS custom properties. Nothing else knows how styling is stored.
import { $ } from "./dom";

interface Prefs {
  width: "narrow" | "medium" | "wide" | "full";
  font: "sans" | "serif" | "mono";
  headingFont: "sans" | "serif";
  titles: "left" | "center";
  zoom: string;
}

const DEFAULT_PREFS: Prefs = {
  width: "medium",
  font: "sans",
  headingFont: "serif",
  titles: "left",
  zoom: "1",
};

const WIDTHS: Record<Prefs["width"], string> = {
  narrow: "680px",
  medium: "860px",
  wide: "1080px",
  full: "100%",
};

function loadPrefs(): Prefs {
  try {
    return {
      ...DEFAULT_PREFS,
      ...JSON.parse(localStorage.getItem("prefs") ?? "{}"),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const prefs = loadPrefs();

function fontVar(f: string): string {
  return f === "serif"
    ? "var(--font-serif)"
    : f === "mono"
      ? "var(--font-mono)"
      : "var(--font-sans)";
}

function applyPrefs() {
  const root = document.documentElement.style;
  root.setProperty("--content-width", WIDTHS[prefs.width] ?? WIDTHS.medium);
  root.setProperty("--editor-zoom", prefs.zoom);
  root.setProperty("--editor-body-font", fontVar(prefs.font));
  root.setProperty("--editor-heading-font", fontVar(prefs.headingFont));
  $("editor").classList.toggle("centered-titles", prefs.titles === "center");
  // Reflect active state in the panel.
  document.querySelectorAll<HTMLElement>(".ap-seg").forEach((seg) => {
    const key = seg.dataset.pref as keyof Prefs;
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.v === String(prefs[key]));
    });
  });
}

export function initAppearancePanel() {
  const panel = $("appearance-panel");
  const button = $("btn-appearance");
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });
  // Close on outside click - but not on the toggle button, whose mousedown
  // would otherwise close the panel just before its click re-opens it.
  document.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (!panel.hidden && !panel.contains(target) && !button.contains(target)) {
      panel.hidden = true;
    }
  });
  panel.querySelectorAll<HTMLButtonElement>(".ap-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = (btn.parentElement as HTMLElement).dataset.pref as keyof Prefs;
      (prefs as unknown as Record<string, string>)[key] = btn.dataset.v!;
      localStorage.setItem("prefs", JSON.stringify(prefs));
      applyPrefs();
    });
  });
  applyPrefs();
}
