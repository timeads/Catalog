# Stacks — a record & book catalog

A personal catalog for a record and book collection. It runs in any modern
browser, installs to a phone's home screen as an app, and keeps everything
on your own device.

## What it does

- **Scan a barcode** with the phone camera (or type the number). ISBNs are
  looked up in Open Library (with Google Books as fallback); record UPCs are
  looked up in MusicBrainz, with covers from the Cover Art Archive.
- **Look it up by name** for anything that predates barcodes — search the
  same databases by title/artist/author and tap the match to prefill.
- **Type it in** for the truly obscure: only a title is required, and you can
  snap a photo of the cover with the camera.
- **Search & organize**: full-text search across every field, filters by
  kind, free-form shelves/tags (comma-separated on any item), and sorting by
  date added, title, creator, or year.
- **Backup & export**: one-tap JSON backup (includes cover photos, restorable
  on any device) and CSV export for spreadsheets.
- **Works offline**: the app shell is cached by a service worker and the
  catalog lives in IndexedDB. Only lookups need a connection.

No accounts, no server, no build step — plain HTML/CSS/JS. The only vendored
dependency is [ZXing](https://github.com/zxing-js/library) for barcode
decoding on browsers without the native `BarcodeDetector` API (iOS Safari,
Firefox).

## Getting it running

### Hosted (recommended — this is how the phone camera works)

The included GitHub Actions workflow deploys the site to GitHub Pages on
every push to `main`:

1. In the repo settings, go to **Settings → Pages** and set **Source** to
   **GitHub Actions** (the workflow also attempts to enable this itself).
2. Merge/push to `main`. The app appears at
   `https://<user>.github.io/<repo>/`.
3. Open that URL on your phone and choose **Add to Home Screen** — it
   installs as an app. Camera scanning requires HTTPS, which Pages provides.

### Local

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Camera access outside `localhost` requires HTTPS.

## Where the data lives

Everything is stored in the browser's IndexedDB on the device you use — the
phone and the desktop each have their own copy. To move or merge catalogs,
use **Backup → Download backup (JSON)** on one device and **Restore from
backup** on the other. Restoring merges by item id: existing items are
updated, new ones added, and nothing is deleted. Export a backup now and
then; it's the only copy.

## Project layout

```
index.html            app shell (all views)
css/styles.css        design system + views
js/app.js             routing, rendering, state
js/db.js              IndexedDB storage
js/lookup.js          Open Library / Google Books / MusicBrainz lookups
js/scanner.js         camera + BarcodeDetector, ZXing fallback
vendor/zxing.min.js   vendored @zxing/library UMD bundle (v0.21.3)
sw.js                 offline cache
manifest.webmanifest  PWA install metadata
icons/                app icons
```
