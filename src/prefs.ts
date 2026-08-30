// Appearance preferences: the panel, persistence, and how each choice maps
// onto CSS custom properties. Nothing else knows how styling is stored.
import { $ } from "./dom";

type Preset = "standard" | "novel" | "paper" | "magazine";

interface Prefs {
  preset: Preset;
  width: "narrow" | "medium" | "wide" | "full";
  zoom: string;
}

const DEFAULT_PREFS: Prefs = {
  preset: "standard",
  width: "medium",
  zoom: "1",
};

const WIDTHS: Record<Prefs["width"], string> = {
  narrow: "620px",
  medium: "760px",
  wide: "980px",
  full: "100%",
};

function loadPrefs(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem("prefs") ?? "{}");
    return {
      preset: ["standard", "novel", "paper", "magazine"].includes(stored.preset)
        ? stored.preset
        : DEFAULT_PREFS.preset,
      width: stored.width in WIDTHS ? stored.width : DEFAULT_PREFS.width,
      zoom: typeof stored.zoom === "string" ? stored.zoom : DEFAULT_PREFS.zoom,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const prefs = loadPrefs();

function applyPrefs() {
  const root = document.documentElement.style;
  root.setProperty("--content-width", WIDTHS[prefs.width] ?? WIDTHS.medium);
  root.setProperty("--editor-zoom", prefs.zoom);
  // The preset drives all typography via [data-preset] rules in styles.css.
  $("editor").dataset.preset = prefs.preset;
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
