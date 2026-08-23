# Stacks — a record & book catalog

A personal catalog for a record and book collection. It runs in any modern
browser, installs to a phone's home screen as an app, keeps everything on
your own devices, and syncs between them through a private GitHub repo you
own.

## What it does

- **Scan a barcode** with the phone camera (or type the number). ISBNs are
  looked up in Open Library (with Google Books as fallback); record UPCs are
  looked up in MusicBrainz — including the **tracklist** with durations —
  with covers from the Cover Art Archive.
- **Take a photo**: photograph the cover of your copy and it becomes a new
  item's cover; fill in the details after.
- **Search online by name** for anything that predates barcodes, and tap the
  match to prefill.
- **Type it in**: blank form, only a title required.
- **Photo galleries**: every item holds any number of photos — add several
  at once from the camera or files, remove any, and pick which one is the
  cover. **Find in the archives** pulls every image the open databases hold
  for the item: for records that's the Cover Art Archive set (front, back,
  labels, booklets), for books the Open Library edition covers.
- **Search & organize**: instant accent-insensitive full-text search across
  every field, kind filters, free-form shelves/tags, grid or list layouts,
  and sorting.
- **Values for the rare stuff**: each item page has a Value section with
  one-tap market lookups — eBay sold listings for everything; Discogs and
  the Popsike auction archive for records; AbeBooks, BookFinder, and
  Biblio for books. Add a free Discogs token in Settings and record pages
  show the live lowest asking price and copies-for-sale count. Store an
  estimated value per item and the Home screen totals the collection
  (values also export in the CSV — handy for insurance).
- **Sync between devices** (optional): phone and desktop stay matching
  through a private GitHub repository — see below.
- **App lock** (optional): a per-device passphrase gates the app and
  encrypts the stored sync/Discogs tokens (WebCrypto, PBKDF2 + AES-GCM).
  Unlock lasts for the browser session; a forgotten passphrase means
  resetting the device copy (the collection stays in the sync repo and
  backups). Each user sets their own passphrase on their own device.
- **Backup & export**: one-tap JSON backup (covers included) and CSV export.
- **Works offline**: app shell cached by a service worker, catalog in
  IndexedDB. Only lookups and sync need a connection.

**On repo visibility:** this code repo can stay public — it contains no
secrets or data, and GitHub Pages on free accounts requires a public repo.
The privacy boundary is the *data* repo used for sync: keep that one
private. The app URL itself serves an empty app to strangers; each
visitor's browser has its own storage.

No accounts, no server, no build step — plain HTML/CSS/JS. The only vendored
dependency is [ZXing](https://github.com/zxing-js/library) for barcode
decoding on browsers without the native `BarcodeDetector` API.

## Sync setup (once per device)

1. Create a **private repo** on GitHub (e.g. `stacks-data`); empty is fine.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   *Only select repositories* → that repo, and under Repository permissions
   set **Contents → Read and write**.
3. In the app: **Settings → Sync between devices**, paste the repo
   (`owner/name`) and the token, hit **Connect & sync**. Repeat on the
   other device with the same two values.

The app then syncs automatically on open, a couple of seconds after every
change, and when the browser comes back online. Merges are per-item (newest
edit wins) and deletions propagate. The repo ends up holding `catalog.json`
plus `covers/*.jpg`, so it doubles as another backup. The token is stored
only in the browser's local storage and sent only to `api.github.com`.

## Getting it running

### Hosted (recommended — this is how the phone camera works)

The included GitHub Actions workflow deploys the site to GitHub Pages on
every push to `main` (and can be run manually from the Actions tab for
other branches):

1. In the repo settings, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
2. Push (or run the workflow). The app appears at
   `https://<user>.github.io/<repo>/`.
3. Open it on your phone and choose **Add to Home Screen**.

### Local

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Camera access outside `localhost` requires HTTPS.

## Project layout

```
index.html            app shell (all views + add sheet)
css/styles.css        design system + views
js/app.js             routing, rendering, state
js/db.js              IndexedDB storage
js/lookup.js          Open Library / Google Books / MusicBrainz lookups
js/scanner.js         camera + BarcodeDetector, ZXing fallback
js/sync.js            GitHub-repo sync (merge + tombstones + covers)
vendor/zxing.min.js   vendored @zxing/library UMD bundle (v0.21.3)
sw.js                 offline cache
manifest.webmanifest  PWA install metadata
icons/                app icons + logo
docs/DESIGN.md        earlier design-system spec (superseded by current UI)
```
