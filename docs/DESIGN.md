---
name: Archival Modern
colors:
  surface: '#fcf9f5'
  surface-dim: '#dcdad6'
  surface-bright: '#fcf9f5'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3ef'
  surface-container: '#f0ede9'
  surface-container-high: '#eae8e4'
  surface-container-highest: '#e5e2de'
  on-surface: '#1c1c1a'
  on-surface-variant: '#474741'
  inverse-surface: '#31302e'
  inverse-on-surface: '#f3f0ec'
  outline: '#777770'
  outline-variant: '#c8c7bf'
  surface-tint: '#5f5e5b'
  primary: '#181916'
  on-primary: '#ffffff'
  primary-container: '#2d2d2a'
  on-primary-container: '#969490'
  inverse-primary: '#c8c6c2'
  secondary: '#775a19'
  on-secondary: '#ffffff'
  secondary-container: '#fed488'
  on-secondary-container: '#785a1a'
  tertiary: '#181816'
  on-tertiary: '#ffffff'
  tertiary-container: '#2d2d2a'
  on-tertiary-container: '#969490'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e5e2dd'
  primary-fixed-dim: '#c8c6c2'
  on-primary-fixed: '#1c1c19'
  on-primary-fixed-variant: '#474743'
  secondary-fixed: '#ffdea5'
  secondary-fixed-dim: '#e9c176'
  on-secondary-fixed: '#261900'
  on-secondary-fixed-variant: '#5d4201'
  tertiary-fixed: '#e5e2dd'
  tertiary-fixed-dim: '#c9c6c2'
  on-tertiary-fixed: '#1c1c19'
  on-tertiary-fixed-variant: '#474743'
  background: '#fcf9f5'
  on-background: '#1c1c1a'
  surface-variant: '#e5e2de'
typography:
  display-lg:
    fontFamily: Playfair Display
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Playfair Display
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-lg-mobile:
    fontFamily: Playfair Display
    fontSize: 28px
    fontWeight: '600'
    lineHeight: '1.2'
  title-md:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.5'
    letterSpacing: 0.01em
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1280px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style
The design system embodies the "Library" aesthetic, blending the intellectual rigor of a physical archive with the frictionless utility of modern software. It targets collectors, bibliophiles, and audiophiles who value tactile quality and organized serenity. 

The visual style is a hybrid of **Minimalism** and **Modern-Corporate**, leaning heavily into "Quiet Luxury." It prioritizes high-quality imagery of book spines and vinyl sleeves, treated as artifacts within a curated space. The emotional response should be one of calm, focus, and timelessness. 
- **Light Mode:** Evokes a sun-drenched reading room with warm parchment tones.
- **Dark Mode:** Mimics a cozy evening study with deep charcoals and soft lamplight highlights.

## Colors
The palette is rooted in warm neutrals to provide a sophisticated backdrop for colorful media covers.

- **Primary (#2D2D2A):** A deep charcoal used for core text and primary structural elements. In dark mode, this transitions to a soft off-white for legibility.
- **Secondary (#C5A059):** A muted gold/brass tone used sparingly for "curated" accents, active states, and special callouts.
- **Tertiary (#F5F2ED):** A "Parchment" shade used for card backgrounds and container surfaces to differentiate from the base canvas.
- **Neutral (#706F6C):** A warm grey for secondary text, borders, and metadata.

**Dark Mode Transition:**
The canvas shifts to **#1A1A19**, with surfaces using a slightly lighter **#242423**. Text scales down to high-quality greys to reduce eye strain, maintaining the "evening study" atmosphere.

## Typography
This design system employs a high-contrast typographic pairing to signal both authority and accessibility.

- **Headlines:** Use **Playfair Display**. It provides the "literary" soul of the app. Headlines should utilize "Optical Sizing" where possible to maintain elegance at large scales.
- **UI & Body:** Use **Inter**. Its systematic, neutral nature ensures that complex catalog data (ISBNs, tracklists, publication dates) remains highly legible and organized.
- **Labels:** Small labels use Inter with increased letter spacing and uppercase styling to mimic library archival tags or cataloging systems.

## Layout & Spacing
The layout follows a **Fixed Grid** philosophy on desktop to maintain a sense of a physical "book" or "sleeve," while transitioning to a fluid model on mobile.

- **Grid:** A 12-column grid with generous 24px gutters. Content should feel "aired out" with significant whitespace (margins) to prevent the catalog from feeling cluttered.
- **Rhythm:** All spacing is derived from an 8px base unit. 
- **Adaptation:** On mobile, margins reduce to 16px. Card-based layouts reflow from a 4-column grid on desktop to a single or dual-column list on mobile, prioritizing cover art visibility.

## Elevation & Depth
Depth is conveyed through **Tonal Layers** and **Ambient Shadows**. 

- **Surface Strategy:** The main background is the lowest layer. Cards and containers use a slightly different neutral (Tertiary) to "lift" off the page without requiring heavy borders.
- **Shadows:** Use extremely soft, diffused shadows with a slight warm tint (`rgba(45, 45, 42, 0.08)`). Shadows should appear as if a book is resting on a table, rather than floating in space. 
- **Interactions:** On hover, elements should exhibit a subtle "lift" (increased shadow spread and slight Y-axis offset) to mimic the act of reaching for a volume on a shelf.

## Shapes
The shape language is **Soft (Level 1)**. This subtle rounding (4px - 12px) mimics the slightly worn edges of a hardcover book or a vinyl jacket.

- **Default (rounded):** 0.25rem (4px) for small UI elements like input fields and tags.
- **Large (rounded-lg):** 0.5rem (8px) for primary media cards and modals.
- **Extra Large (rounded-xl):** 0.75rem (12px) for major container sections.

Avoid pill-shapes or hyper-rounded corners, as they conflict with the "structured archive" aesthetic.

## Components
- **Buttons:** Primary buttons are solid Charcoal with White text. Secondary buttons use a fine 1px border in Neutral with no fill. Text is always Inter Medium.
- **Media Cards:** The centerpiece component. Features a subtle 1px inner border to define the cover art. Metadata (Title/Artist) is placed below the image using `title-md` and `label-sm`.
- **Input Fields:** Minimalist design with a bottom-border only or a very light Tertiary fill. Focus states use the Secondary (Brass) color for the cursor and border.
- **Chips/Tags:** Used for genres or years. These utilize the `label-sm` style with a light parchment fill and no border, appearing like small sticky notes or index tabs.
- **Lists:** High-density data lists use alternating tonal rows (Tertiary vs. Canvas) for readability, with monospaced numbers for tracklists or archival codes.
- **Imagery:** All book/record images should have a subtle "inner glow" or "sheen" overlay to simulate physical material texture.