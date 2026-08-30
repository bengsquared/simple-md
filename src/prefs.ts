// Appearance preferences: the panel, persistence, and how each choice maps
// onto CSS custom properties. Nothing else knows how styling is stored.
import { $ } from "./dom";

type Voice = "standard" | "novel" | "paper" | "magazine";

interface Prefs {
  // Typographic character: fonts, headings, ornaments. Curated set.
  voice: Voice;
  // Type overrides on top of the voice ("auto" = voice default).
  font: "auto" | "book" | "charter" | "newyork" | "sans" | "mono";
  headings: "auto" | "serif" | "sans";
  // Page mechanics, independent of voice.
  paragraph: "flowing" | "indented";
  justify: "ragged" | "justified"; // justified implies hyphenation (CSS)
  density: "compact" | "standard" | "relaxed";
  width: "narrow" | "medium" | "wide" | "full";
  zoom: string;
}

type LayoutPrefs = Pick<Prefs, "paragraph" | "justify" | "density">;

// Applied when a voice is *selected*, so each voice looks right
// immediately; the layout rows override freely afterwards.
const VOICE_LAYOUTS: Record<Voice, LayoutPrefs> = {
  standard: { paragraph: "flowing", justify: "ragged", density: "standard" },
  novel: { paragraph: "indented", justify: "justified", density: "standard" },
  paper: { paragraph: "indented", justify: "justified", density: "standard" },
  magazine: { paragraph: "flowing", justify: "ragged", density: "standard" },
};

const DEFAULT_PREFS: Prefs = {
  voice: "standard",
  font: "auto",
  headings: "auto",
  ...VOICE_LAYOUTS.standard,
  width: "medium",
  zoom: "1",
};

const WIDTHS: Record<Prefs["width"], string> = {
  narrow: "620px",
  medium: "760px",
  wide: "980px",
  full: "100%",
};

function pick<K extends keyof Prefs>(
  stored: Record<string, unknown>,
  key: K,
  valid: readonly string[]
): Prefs[K] {
  const v = stored[key];
  return (typeof v === "string" && valid.includes(v) ? v : DEFAULT_PREFS[key]) as Prefs[K];
}

function loadPrefs(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem("prefs") ?? "{}");
    // Migrate pre-split records: `preset` becomes voice + its layout.
    if (typeof stored.preset === "string" && !stored.voice) {
      stored.voice = stored.preset;
      Object.assign(stored, VOICE_LAYOUTS[stored.preset as Voice] ?? {});
    }
    return {
      voice: pick(stored, "voice", ["standard", "novel", "paper", "magazine"]),
      font: pick(stored, "font", ["auto", "book", "charter", "newyork", "sans", "mono"]),
      headings: pick(stored, "headings", ["auto", "serif", "sans"]),
      paragraph: pick(stored, "paragraph", ["flowing", "indented"]),
      justify: pick(stored, "justify", ["ragged", "justified"]),
      density: pick(stored, "density", ["compact", "standard", "relaxed"]),
      width: pick(stored, "width", Object.keys(WIDTHS)),
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
  const editor = $("editor");
  editor.dataset.voice = prefs.voice;
  editor.dataset.font = prefs.font;
  editor.dataset.headings = prefs.headings;
  editor.dataset.paragraph = prefs.paragraph;
  editor.dataset.justify = prefs.justify;
  editor.dataset.density = prefs.density;
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
      // Choosing a voice applies its layout defaults; the layout rows
      // remain free overrides afterwards.
      if (key === "voice") {
        Object.assign(prefs, VOICE_LAYOUTS[prefs.voice], {
          font: "auto",
          headings: "auto",
        });
      }
      localStorage.setItem("prefs", JSON.stringify(prefs));
      applyPrefs();
    });
  });
  applyPrefs();
}
