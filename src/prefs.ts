// Appearance preferences: the panel, persistence, and how each choice maps
// onto CSS custom properties. Nothing else knows how styling is stored.
import { $ } from "./dom";
import { backend } from "./ipc";

type Voice = "standard" | "novel" | "paper" | "magazine";

interface Prefs {
  // Window theme: follows system, or forced. Not voice-related.
  appearance: "auto" | "light" | "dark";
  // Typographic character: fonts, headings, ornaments. Curated set.
  voice: Voice;
  // Overrides on top of the voice ("auto" = voice default).
  font: "auto" | "book" | "charter" | "newyork" | "sans" | "mono";
  headings: "auto" | "book" | "charter" | "newyork" | "sans" | "mono";
  headingCase: "auto" | "normal" | "smallcaps";
  headingAlign: "auto" | "left" | "center";
  sectionBreak: "auto" | "line" | "dinkus" | "fleuron";
  ornaments: "auto" | "on" | "off";
  headingNumbers: "auto" | "on" | "off";
  // Page mechanics, independent of voice.
  paragraph: "flowing" | "indented";
  justify: "ragged" | "justified"; // justified implies hyphenation (CSS)
  density: "compact" | "standard" | "relaxed";
  width: "narrow" | "medium" | "wide" | "full";
  zoom: string;
}

type LayoutPrefs = Pick<Prefs, "paragraph" | "justify" | "density" | "width">;

// Applied when a voice is *selected*, so each voice looks right
// immediately; the layout rows override freely afterwards.
const VOICE_LAYOUTS: Record<Voice, LayoutPrefs> = {
  standard: { paragraph: "flowing", justify: "ragged", density: "standard", width: "medium" },
  novel: { paragraph: "indented", justify: "justified", density: "standard", width: "medium" },
  // Paper defaults narrow: ~62ch at Charter 17px, matching LaTeX's ~60ch.
  paper: { paragraph: "indented", justify: "justified", density: "standard", width: "narrow" },
  magazine: { paragraph: "flowing", justify: "ragged", density: "standard", width: "medium" },
};

// Every voice-level decision an override can unpick, reset when a voice
// is chosen so the preset arrives whole.
const AUTO_OVERRIDES = {
  font: "auto",
  headings: "auto",
  headingCase: "auto",
  headingAlign: "auto",
  sectionBreak: "auto",
  ornaments: "auto",
  headingNumbers: "auto",
} as const;

const DEFAULT_PREFS: Prefs = {
  appearance: "auto",
  voice: "standard",
  ...AUTO_OVERRIDES,
  ...VOICE_LAYOUTS.standard,
  width: "medium",
  zoom: "1",
};

// [column width, side padding]: padding scales with the stop so the fixed
// chrome doesn't read generous at narrow and tight at wide.
const WIDTHS: Record<Prefs["width"], [string, string]> = {
  narrow: ["680px", "44px"], /* ~60-62ch at 18-19px body */
  medium: ["780px", "48px"], /* ~67-72ch - the Bringhurst band */
  // Wide exceeds the 75ch prose ceiling on purpose: it exists for
  // table- and code-heavy documents where cell measure governs.
  wide: ["980px", "56px"],
  full: ["100%", "56px"],
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
    if (stored.headings === "serif") stored.headings = "newyork";
    if (typeof stored.preset === "string" && !stored.voice) {
      stored.voice = stored.preset;
      Object.assign(stored, VOICE_LAYOUTS[stored.preset as Voice] ?? {});
    }
    return {
      appearance: pick(stored, "appearance", ["auto", "light", "dark"]),
      voice: pick(stored, "voice", ["standard", "novel", "paper", "magazine"]),
      font: pick(stored, "font", ["auto", "book", "charter", "newyork", "sans", "mono"]),
      headings: pick(
        stored,
        "headings",
        ["auto", "book", "charter", "newyork", "sans", "mono"],
      ),
      headingCase: pick(stored, "headingCase", ["auto", "normal", "smallcaps"]),
      headingAlign: pick(stored, "headingAlign", ["auto", "left", "center"]),
      sectionBreak: pick(stored, "sectionBreak", ["auto", "line", "dinkus", "fleuron"]),
      ornaments: pick(stored, "ornaments", ["auto", "on", "off"]),
      headingNumbers: pick(stored, "headingNumbers", ["auto", "on", "off"]),
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
  void backend.setWindowTheme(prefs.appearance);
  const root = document.documentElement.style;
  const [width, pad] = WIDTHS[prefs.width] ?? WIDTHS.medium;
  root.setProperty("--content-width", width);
  root.setProperty("--page-pad", pad);
  root.setProperty("--editor-zoom", prefs.zoom);
  const editor = $("editor");
  editor.dataset.voice = prefs.voice;
  editor.dataset.font = prefs.font;
  editor.dataset.headings = prefs.headings;
  editor.dataset.headingCase = prefs.headingCase;
  editor.dataset.headingAlign = prefs.headingAlign;
  editor.dataset.sectionBreak = prefs.sectionBreak;
  editor.dataset.ornaments = prefs.ornaments;
  editor.dataset.headingNumbers = prefs.headingNumbers;
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
        Object.assign(prefs, VOICE_LAYOUTS[prefs.voice], AUTO_OVERRIDES);
      }
      localStorage.setItem("prefs", JSON.stringify(prefs));
      applyPrefs();
    });
  });
  applyPrefs();
}
