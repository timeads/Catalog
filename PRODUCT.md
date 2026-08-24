# Stacks — product truth

## What it is

A personal catalog for one household's record and book collection. It runs
as a no-build PWA (GitHub Pages), stores everything locally (IndexedDB),
and syncs between the owner's devices through a private GitHub repo.

## Who uses it

One or two people — the collection's owners — on two surfaces:

- **Phone** (primary capture device): standing at a shelf or in a record
  store, scanning barcodes, photographing covers, checking whether a copy
  is already owned. One-handed use; camera-centric.
- **Desktop** (primary browsing device): searching, organizing, editing
  details, checking market values, exporting.

## What success looks like

Adding an item takes seconds (scan/photo → everything fills itself in),
and finding an item — or where it physically sits — takes one search. The
tool disappears into the task. This is an Operate surface throughout;
there is no marketing page.

## Voice

Plain, warm, and direct. Controls name their action; errors name the
problem and the recovery. No jargon, no exclamation marks.

## Constraints

- No backend, no build step: vanilla HTML/CSS/JS, service worker, all
  third-party access via public CORS APIs or user-pasted tokens.
- Works offline; everything user-generated lives on-device and in the
  private sync repo.
- Both color schemes ship (System/Light/Dark per device); every surface
  must hold up in each.
- Lighthouse-class frugality: Google Fonts is the only external asset host.
