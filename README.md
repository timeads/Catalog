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
  item's cover. With a Claude API key in Settings, the photo is
  **identified automatically** — Claude reads the sleeve or jacket, the
  open databases confirm the match, and everything fills in: metadata,
  the tracklist, and the archive's front/back sleeve images for records.
  Each identification costs a fraction of a cent on your own key.
- **Search online by name** for anything that predates barcodes, and tap the
  match to prefill.
- **Type it in**: blank form, only a title required.
- **Photo galleries**: every item holds any number of photos — add several
  at once from the camera or files, remove any, and pick which one is the
  cover. **Find in the archives** pulls every image the open databases hold
  for the item: for records that's the Cover Art Archive set (front, back,
  labels, booklets), for books the Open Library edition covers.
- **Genre & summary, automatically**: every add path fills in the music
  genre / book categories and a summary — records get a sentence or two;
  books get a fuller "about": what the book is about plus notable context
  (awards, series, significance) and the page count where known. Sourced
  from MusicBrainz genres, Open Library / Google Books descriptions, and
  Claude (same API key as photo identification) for whatever's missing.
  All editable, searchable, on the item page, and in the CSV export.
- **Hear it**: every track row on a record's page has a play button — a
  30-second preview found via the iTunes Search API (previews are of the
  digital release; pre-digital rarities may have none).
- **Physical locations**: define your bookcases in Settings (name + number
  of shelves), then give every item a bookcase and shelf on its form. The
  location shows on the item page, is searchable ("living room" finds
  everything on that case), syncs between devices, and exports in the CSV.
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
- **Accounts & sync**: sign in on each device and the catalog stays
  matching everywhere; each person's collection is private — see below.
- **App lock** (optional): a per-device passphrase gates the app and
  encrypts the stored sign-in and Discogs / Claude keys (WebCrypto,
  PBKDF2 + AES-GCM). Unlock lasts for the browser session; a forgotten
  passphrase means resetting the device copy (the collection stays in the
  account and backups). A household can use one shared passphrase — set
  the same one on each device.
- **Backup & export**: one-tap JSON backup (covers included) and CSV export.
- **Works offline**: app shell cached by a service worker, catalog in
  IndexedDB. Only lookups and sync need a connection.

**On repo visibility:** this code repo can stay public — it contains no
secrets or data, and GitHub Pages on free accounts requires a public repo.
The Supabase URL and publishable key in `js/cloud.js` are public by design;
row-level security keeps every account's catalog private, and only approved
emails can store anything.

No build step — plain HTML/CSS/JS. Vendored dependencies:
[ZXing](https://github.com/zxing-js/library) for barcode decoding on
browsers without the native `BarcodeDetector` API, and
[supabase-js](https://github.com/supabase/supabase-js) for accounts and sync.

## Accounts & sync

Each person signs in with an email and password (**Settings → Account &
sync**). Their catalog, photos, bookcases, and optional Discogs / Claude
keys follow them to every device they sign in on. Accounts are private to
each other, and the app stays local-first: every device keeps a full copy
and works offline, syncing on open, a couple of seconds after every change,
and when it comes back online. Merges are per item (newest edit wins, also
enforced server-side) and deletions propagate.

**Approving people.** Anyone can create an account, but nothing syncs until
their email is on the allow-list. Add one in the Supabase dashboard's SQL
editor:

```sql
insert into public.allowed_emails (email) values ('friend@example.com');
```

**Shared devices.** If a different account signs in on a device that holds
someone else's catalog, the app asks before replacing it, so two people's
collections never mix. *Sign out and remove this device's copy* clears a
device completely.

### Backend setup (one time)

1. Create a Supabase project (free plan is plenty).
2. Apply `supabase/migrations/20261015120000_stacks_schema.sql` (SQL editor
   or `supabase db push`). It creates the tables, row-level security,
   the allow-list, and the private `covers` photo bucket.
3. Authentication → URL Configuration: set **Site URL** to the app's address
   (e.g. `https://timeads.github.io/Catalog/`) and add it to the redirect
   allow-list, so confirmation and password-reset emails return to the app.
4. Put the project URL and publishable key in `js/cloud.js`.
5. Add your email(s) to `public.allowed_emails`.

The **Keep Supabase awake** workflow touches the database every three days,
so the free project doesn't pause from inactivity.

**Coming from the GitHub-repo sync?** Sign in on the device that has your
full catalog first: on first sign-in it uploads everything, photos
included. Then sign in on your other devices. The old data repo can stay as
an archive.

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
js/sync.js            account sync (merge + tombstones + photos)
js/cloud.js           Supabase client, sign-in, session storage
supabase/migrations/  database schema + row-level security
vendor/zxing.min.js   vendored @zxing/library UMD bundle (v0.21.3)
vendor/supabase.js    vendored @supabase/supabase-js UMD bundle (v2.117.3)
sw.js                 offline cache
manifest.webmanifest  PWA install metadata
icons/                app icons + logo
PRODUCT.md            product truth for design tooling
DESIGN.md             the design system: tokens + rules (normative)
.claude/              vendored Impeccable design skill (/impeccable …)
```

## Design standards

The UI follows [Impeccable](https://github.com/pbakaus/impeccable), vendored
under `.claude/` so Claude Code sessions get its `/impeccable` commands and
design detector. `DESIGN.md` is the normative token source — new colors,
type sizes, or radii are added there first, then used in CSS.
