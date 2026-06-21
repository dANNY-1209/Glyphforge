# Glyphforge — DESIGN.md

> AI-readable design system. Any coding agent (or human) editing Glyphforge UI
> reads this first and conforms to it. Goal: a deliberate **arcane / glyph-tech**
> identity — a spellbook crossed with a technical schematic — with zero of the
> generic "AI-generated dashboard" tells.

---

## 1. Atmosphere / motif

Glyphforge curates LoRAs, embeddings and prompts — it "reshapes the latent
space." The room should feel like a **dark forge / arcane archive**: cool
violet-black ground, faint engraved rune-grid, a single **molten-ember** accent
that glows only where it matters (the forge light). Technical, precise,
slightly occult. Monospace carries the "sigil / schematic" texture; the sans
keeps reading clean. Restraint everywhere; the ember is earned, never sprayed.

Adjectives: forged · arcane · precise · dim-with-a-glow · technical.
NOT: glassy, pillowy, neon, playful, gradient-y.

---

## 2. Color — one ground, one accent

Replace the current charcoal grayscale + dual themes with **one** palette.
The accent is **ember** (forge). A faint **rune-violet** is ambient only
(hairlines, focus glow, links) — never a fill, never gradient-paired with ember.

```css
:root {
  /* Ground — cool violet-black, NOT pure #141414 */
  --gf-bg:        #0b0a10;   /* app background */
  --gf-surface:   #131019;   /* cards, panels */
  --gf-surface-2: #1b1726;   /* inputs, raised rows, popovers */
  --gf-line:      #2a2438;   /* structural borders */
  --gf-hairline:  rgba(179,157,255,0.10); /* arcane hairline / rune grid */

  /* Ember — THE accent. Solid, flat, sparing. */
  --gf-ember:      #ff6a3d;
  --gf-ember-press:#e2542b;
  --gf-ember-glow: rgba(255,106,61,0.30); /* focus ring halo only */

  /* Rune-violet — ambient secondary. Links, faint glows. Used rarely. */
  --gf-rune:      #b39dff;

  /* Text */
  --gf-text:      #ece8f5;
  --gf-text-dim:  #9a93ad;
  --gf-text-faint:#5f596f;

  /* Semantic — muted, never neon */
  --gf-ok:  #5fcf8e;
  --gf-warn:#e0a955;
  --gf-bad: #e5604f;
  --gf-r18: #e86aa0;   /* R18 marker — distinct but desaturated */
}
```

**Rules**
- Ember is for: primary action, active nav, focus ring, "live/selected" glyph
  marks, key counts. Cap it at **~1 ember element per viewport region**.
- Never `linear-gradient(ember → rune)` or any 2-hue gradient. (That purple-cyan
  family is the #1 AI tell.)
- Surfaces are separated by the **bg step + a 1px line/hairline**, not by color.

---

## 3. Typography

```css
--font-sans: "Geist", system-ui, "Noto Sans TC", sans-serif;
--font-mono: "Geist Mono", ui-monospace, SFMono-Regular, monospace;
```

- **Body / UI** → sans.
- **Mono is a motif**, not just code: IDs, tags, counts, timestamps, section
  labels, file names, trigger words. Mono = the "sigil/schematic" texture.
- **Section labels**: mono, `UPPERCASE`, `letter-spacing:.10em`, 12px,
  `--gf-text-dim`, preceded by a short 14×2px ember rule.
- **Headings**: sans, weight 600, tracking `-0.02em`. Scale (px):
  `12 · 13 · 14(base) · 16 · 20 · 26 · 34`. Line-height 1.5 body / 1.2 headings.
- Numbers/metrics: `font-variant-numeric: tabular-nums` (mono feel, aligned).

---

## 4. Space, radius, elevation

```css
/* 4px base scale — only these steps */
--s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-6:24px; --s-8:32px; --s-12:48px;

/* Radius — sharp-ish (arcane/technical), ONE scale. Kill 8/10/12/16/20 chaos. */
--r-1:6px;  --r-2:10px;  --r-3:14px;  --r-pill:999px;

/* Elevation — hairlines, not big glows. NO 0 10px 40px shadows. */
--e-1: 0 1px 2px rgba(0,0,0,.45);
--e-2: 0 8px 24px rgba(0,0,0,.45);            /* popovers/modals only */
--focus: 0 0 0 1px var(--gf-ember), 0 0 0 4px var(--gf-ember-glow);
```

- Depth = `bg step + 1px var(--gf-line)`. Heavy drop-shadows are banned on cards.
- The only "glow" is the **ember focus ring** (`--focus`) — the forge igniting.

---

## 5. Components

- **Button / primary**: solid `--gf-ember`, `#1a0d08` text, `--r-2`, no gradient.
  Hover = `brightness(1.06)`; active = `--gf-ember-press`. No scale/bounce.
- **Button / ghost**: transparent, `1px var(--gf-line)`, `--gf-text-dim`.
  Hover = border `--gf-ember`, text `--gf-text`, **faint ember edge glow**
  (`box-shadow: inset 0 0 0 1px var(--gf-ember-glow)`).
- **Card**: `--gf-surface` + `1px var(--gf-line)`, `--r-3`, `--e-1`. Hover = the
  border hairline shifts to a low-opacity ember. Never nest a card in a card.
- **Tag / chip**: mono, `--r-pill`, `1px var(--gf-line)`, `--gf-text-dim`.
- **Input**: `--gf-surface-2`, `1px var(--gf-line)`, `--r-2`; focus → `--focus`.
- **Section label**: ember rule + mono uppercase (see §3).
- **Rune grid** (bg texture / empty states):
  `background-image: radial-gradient(var(--gf-hairline) 1px, transparent 1px);
   background-size: 22px 22px;` — faint, behind content only.
- **Icons**: thin (1.5px) line icons; for "marks/glyphs" use simple geometric
  sigils. No emoji in chrome.

---

## 6. Motion

- Duration 120–180ms, `cubic-bezier(.2,.7,.3,1)` (ease-out). Color/opacity/border
  transitions preferred over transform.
- **Banned**: bounce/elastic easing, scale-pop on hover, long (>250ms) anims.
- Tasteful motif move: hover "ignite" = border/edge fades to ember over 140ms.

---

## 7. Do / Don't (anti-AI guardrails)

**Don't** (these are the tells found in the old CSS — remove them):
- `linear-gradient(145deg, …)` card backgrounds, or any 2-hue gradient.
- Grayscale/desaturated accent (`#C8C8C8`) — there must be ONE real accent.
- Big soft shadows `0 10px 40px …` + `0 0 0 1px` ring stacks.
- Gradient buttons; glassmorphism / heavy `backdrop-filter` blur.
- Inconsistent radii (8/10/12/16/20 mixed); nested cards; identical card grids
  with no hierarchy; emoji as UI icons; default fonts (Inter/Roboto/Arial).
- Multiple competing themes. One palette.

**Do**: one ground + one ember accent · mono as texture · 1px hairlines for
depth · ember focus ring · tabular nums · designed empty/loading/hover/focus
states · the rune grid for atmosphere · negative space.

---

## 8. Agent guide

When building/altering Glyphforge UI: pull tokens from §2–4, follow §5 component
rules, obey §7. If a choice isn't covered, prefer the more **restrained,
hairline, ember-sparing** option. Render candidates into `preview.html` and
eyeball before wiring into `App.jsx` / `App.css`. Migrate `src/index.css`
`:root` to the §2 tokens; delete the `[data-theme="original"]` legacy block.
