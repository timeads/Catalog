// External metadata lookups. All free, no-key, CORS-friendly APIs:
//   Books:   Open Library, with Google Books as fallback
//   Records: MusicBrainz + Cover Art Archive
// Every function resolves to normalized objects:
//   { kind, title, creator, year, format, publisher, genre, coverUrl, barcode }

function digitsOnly(s) {
  return (s || '').replace(/[^0-9Xx]/g, '');
}

export function looksLikeIsbn(code) {
  const d = digitsOnly(code);
  if (d.length === 10) return true;
  return d.length === 13 && (d.startsWith('978') || d.startsWith('979'));
}

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function yearOf(dateStr) {
  const m = /\d{4}/.exec(dateStr || '');
  return m ? m[0] : '';
}

/* ---------------- books ---------------- */

async function openLibraryByIsbn(isbn) {
  const data = await getJson(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`
  );
  const b = data && data[`ISBN:${isbn}`];
  if (!b) return null;
  return {
    kind: 'book',
    title: b.title || '',
    creator: (b.authors || []).map((a) => a.name).join(', '),
    year: yearOf(b.publish_date),
    format: '',
    publisher: (b.publishers || []).map((p) => p.name).join(', '),
    genre: (b.subjects || []).slice(0, 2).map((s) => s.name).join(', '),
    coverUrl: (b.cover && (b.cover.medium || b.cover.large)) || '',
    barcode: isbn,
    pages: b.number_of_pages ? String(b.number_of_pages) : '',
  };
}

async function googleBooks(query, barcode) {
  const data = await getJson(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`
  );
  const v = data && data.items && data.items[0] && data.items[0].volumeInfo;
  if (!v) return null;
  return {
    kind: 'book',
    title: v.title || '',
    creator: (v.authors || []).join(', '),
    year: yearOf(v.publishedDate),
    format: '',
    publisher: v.publisher || '',
    genre: (v.categories || []).slice(0, 2).join(', '),
    coverUrl: ((v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '')
      .replace('http://', 'https://'),
    barcode: barcode || '',
    pages: v.pageCount ? String(v.pageCount) : '',
    summary: v.description ? String(v.description).split('\n')[0].slice(0, 600) : '',
  };
}

export async function searchBooks(query) {
  const data = await getJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=12&fields=title,author_name,first_publish_year,cover_i,isbn,publisher,number_of_pages_median`
  );
  if (!data || !data.docs) return [];
  return data.docs.map((d) => ({
    kind: 'book',
    title: d.title || '',
    creator: (d.author_name || []).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    format: '',
    publisher: (d.publisher || [])[0] || '',
    genre: '',
    coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    barcode: '',
    pages: d.number_of_pages_median ? String(d.number_of_pages_median) : '',
  }));
}

/* ---------------- records ---------------- */

function fromMusicBrainzRelease(r, barcode) {
  const media = (r.media || [])[0] || {};
  return {
    kind: 'record',
    title: r.title || '',
    creator: (r['artist-credit'] || []).map((a) => a.name).join(' & '),
    year: yearOf(r.date),
    format: media.format || '',
    publisher: (((r['label-info'] || [])[0] || {}).label || {}).name || '',
    genre: '',
    coverUrl: r.id ? `https://coverartarchive.org/release/${r.id}/front-250` : '',
    barcode: barcode || r.barcode || '',
    mbid: r.id || '',
  };
}

// Track titles/durations and community genres for a MusicBrainz release.
// Returns {tracks: [{no, title, ms}]|null, genre: ''} or null.
export async function fetchReleaseDetails(mbid) {
  if (!mbid) return null;
  const data = await getJson(
    `https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings+genres&fmt=json`
  );
  if (!data) return null;
  const tracks = (data.media || []).flatMap((m) => (m.tracks || []).map((t) => ({
    no: t.number || String(t.position || ''),
    title: t.title || '',
    ms: t.length || 0,
  })));
  const genre = (data.genres || [])
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 2)
    .map((g) => (g.name || '').replace(/\b\w/g, (c) => c.toUpperCase()))
    .filter(Boolean)
    .join(', ');
  return { tracks: tracks.length ? tracks : null, genre };
}

// The Open Library work description for a book — often a real blurb.
export async function fetchBookDescription(isbn) {
  const edition = await getJson(`https://openlibrary.org/isbn/${isbn}.json`);
  const workKey = edition && edition.works && edition.works[0] && edition.works[0].key;
  if (!workKey) return '';
  const work = await getJson(`https://openlibrary.org${workKey}.json`);
  let d = work && work.description;
  if (d && typeof d === 'object') d = d.value;
  if (!d) return '';
  d = String(d).split('\n')[0].trim();
  return d.length > 600 ? `${d.slice(0, 597)}…` : d;
}

async function musicBrainzByBarcode(code) {
  // UPC-A is a 12-digit code that scanners often report as 13-digit EAN with a
  // leading zero (and vice versa) — try the variants too.
  const variants = [code];
  if (code.length === 13 && code.startsWith('0')) variants.push(code.slice(1));
  if (code.length === 12) variants.push('0' + code);
  for (const v of variants) {
    const data = await getJson(
      `https://musicbrainz.org/ws/2/release/?query=barcode:${v}&fmt=json&limit=3`
    );
    const r = data && data.releases && data.releases[0];
    if (r) return fromMusicBrainzRelease(r, code);
  }
  return null;
}

export async function searchRecords(query) {
  const q = encodeURIComponent(query);
  const data = await getJson(
    `https://musicbrainz.org/ws/2/release/?query=${q}&fmt=json&limit=12`
  );
  if (!data || !data.releases) return [];
  const seen = new Set();
  const out = [];
  for (const r of data.releases) {
    const item = fromMusicBrainzRelease(r, '');
    const key = `${item.title}|${item.creator}|${item.year}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/* ---------------- archive photo finder ---------------- */

// Every image the open archives hold for this item:
//   Records: Cover Art Archive — front, back, labels, booklets…
//   Books:   Open Library — the edition's cover set.
// Returns [{url, thumb, label}].
export async function findArchivePhotos(item) {
  if (item.kind === 'record') {
    let mbid = item.mbid;
    if (!mbid && item.barcode) {
      const release = await musicBrainzByBarcode(item.barcode.replace(/[^0-9]/g, ''));
      mbid = release && release.mbid;
    }
    if (!mbid) return [];
    const data = await getJson(`https://coverartarchive.org/release/${mbid}`);
    if (!data || !data.images) return [];
    return data.images.map((img) => {
      const t = img.thumbnails || {};
      const full = (t['500'] || t.large || img.image || '').replace('http://', 'https://');
      return {
        url: full,
        thumb: (t['250'] || t.small || full).replace('http://', 'https://'),
        label: (img.types || []).join(' · ') || (img.comment || 'Image'),
      };
    }).filter((p) => p.url);
  }

  const isbn = (item.barcode || '').replace(/[^0-9Xx]/g, '');
  if (!isbn) return [];
  const data = await getJson(`https://openlibrary.org/isbn/${isbn}.json`);
  const ids = ((data && data.covers) || []).filter((id) => id > 0);
  return ids.map((id, i) => ({
    url: `https://covers.openlibrary.org/b/id/${id}-L.jpg`,
    thumb: `https://covers.openlibrary.org/b/id/${id}-M.jpg`,
    label: i === 0 ? 'Cover' : `Cover ${i + 1}`,
  }));
}

/* ---------------- barcode entry point ---------------- */

export async function lookupBarcode(rawCode) {
  const code = digitsOnly(rawCode);
  if (!code) return null;
  if (looksLikeIsbn(code)) {
    const book = (await openLibraryByIsbn(code)) || (await googleBooks(`isbn:${code}`, code));
    if (book && !book.summary) book.summary = await fetchBookDescription(code).catch(() => '');
    return book;
  }
  // Not an ISBN: almost certainly a record UPC/EAN. Fall back to Google Books
  // in case it's a barcoded book without a 978 prefix.
  const release = await musicBrainzByBarcode(code);
  if (release) {
    const details = await fetchReleaseDetails(release.mbid);
    release.tracks = (details && details.tracks) || [];
    if (details && details.genre && !release.genre) release.genre = details.genre;
    return release;
  }
  return googleBooks(code, code);
}
