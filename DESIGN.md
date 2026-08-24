---
name: Stacks
description: Warm stone shelving with one signal-orange spine — a quiet archive that gets out of the collection's way.
colors:
  bg: "#fafaf9"
  surface: "#ffffff"
  surface-2: "#f5f5f4"
  surface-3: "#eeedec"
  border: "#e7e5e4"
  border-strong: "#d6d3d1"
  ink: "#1c1917"
  ink-2: "#57534e"
  ink-3: "#79746e"
  accent: "#ea580c"
  accent-strong: "#c2410c"
  on-accent: "#ffffff"
  accent-soft: "#ffedd5"
  on-accent-soft: "#9a3412"
  danger: "#dc2626"
  ok: "#16a34a"
  camera-well: "#121110"
  dark-bg: "#0f0e0d"
  dark-surface: "#1a1917"
  dark-surface-2: "#232220"
  dark-surface-3: "#2c2a28"
  dark-border: "#2c2a28"
  dark-border-strong: "#3d3a37"
  dark-ink: "#f5f5f4"
  dark-ink-2: "#bab5b0"
  dark-ink-3: "#8d8880"
  dark-accent: "#f97316"
  dark-accent-strong: "#fb923c"
  dark-on-accent: "#1c1210"
  dark-accent-soft: "#3b1d0d"
  dark-on-accent-soft: "#fdba74"
  dark-danger: "#f87171"
  dark-ok: "#4ade80"
typography:
  micro:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
  label:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "0.78125rem"
    fontWeight: 500
  meta:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "0.84375rem"
    fontWeight: 400
  body:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  lead:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
  title:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
  heading:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
  display:
    fontFamily: "Hanken Grotesk, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
  data:
    fontFamily: "IBM Plex Mono, SFMono-Regular, Menlo, monospace"
    fontSize: "0.84375rem"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
  chip-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.on-accent-soft}"
    rounded: "{rounded.pill}"
---

## Overview

Stacks is an Operate surface: a tool for cataloging and finding records and
books. The design goal is a quiet, warm archive — stone neutrals like
gallery walls, one signal-orange accent doing all the pointing, and type
that stays out of the way. Familiar app-shell patterns on purpose; brand
lives in precise details (the logo mark, the orange, the mono data voice),
not in invented affordances.

## Colors

Warm stone neutrals (never pure gray or pure black — everything is tinted
toward the `#1c1917` brown-black family). One accent: signal orange
(`accent`), reserved for primary actions, active states, and the current
selection — never decoration. Dark scheme swaps to the `dark-*` set;
`accent` brightens one step for contrast on dark ground. `camera-well` is
intentionally dark in both schemes (camera and cover wells read as physical
recesses). Every ink-on-surface pair holds ≥4.5:1 in both schemes.

## Typography

One family: **Hanken Grotesk** — a warm humanist grotesk that carries
headings, body, labels, and buttons; hierarchy comes from the fixed rem
ramp (≈1.13 ratio) plus weight, never from a second display face.
**IBM Plex Mono** is reserved for genuine data: barcodes, track durations,
prices, timestamps — with `font-variant-numeric: tabular-nums` where
numbers align in columns. Decorative cover monograms (the placeholder
letter tiles) scale freely outside the ramp; they are lettering, not text.
Never introduce Inter/Roboto/system-default faces.

## Layout

Mobile: single column, bottom tab bar with a raised center add-hub, add
flows in a bottom sheet. Desktop (≥900px): fixed sidebar (232px) + content
column. Responsive behavior is structural (sidebar appears, grids gain
columns) — type stays fixed-size. Tight within groups, generous between
sections; more space above a heading than below it.

## Elevation & Depth

Two shadow steps only (`--shadow-1`, `--shadow-2`), both with offset and
soft blur, tinted from the ink family (never pure black). Dark scheme
deepens them. Tonal layering (`surface` → `surface-2` → `surface-3`)
carries most depth; shadows are for things that float (cards, sheet,
raised hub, overlays).

## Shapes

Radius scale: 4 / 6 / 10 / 14 / 20 px plus pill (999px) for chips and the
tab hub. Larger surfaces take larger radii. No sharp corners; no radius
outside the scale.

## Components

Every interactive control has default, hover, focus-visible (2px accent
outline, 2px offset), active, and disabled states. Chips are the shared
filter vocabulary (tags, locations, market links) — pill-shaped, active =
`accent-soft` fill with `on-accent-soft` text and a ✕ affordance.
Segmented controls (`.kind-filter`/`.seg-btn`) are the shared toggle
vocabulary. Empty states teach the next action and carry a real CTA.

## Do's and Don'ts

- Do keep the orange scarce: if everything points, nothing points.
- Do use the mono face only where the content is data.
- Don't nest cards in cards, or reach for a modal when inline works —
  the add sheet and mini-scanner are the only overlays.
- Don't introduce new literal colors, sizes, or radii in CSS: add a token
  here first, then use it.
- Don't animate page loads; motion only conveys state (150–250ms,
  ease-out).
