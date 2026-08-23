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
  };
}

export async function searchBooks(query) {
  const data = await getJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=12&fields=title,author_name,first_publish_year,cover_i,isbn,publisher`
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

// Track titles and durations for a MusicBrainz release.
// Returns [{no, title, ms}] or null.
export async function fetchTracks(mbid) {
  if (!mbid) return null;
  const data = await getJson(
    `https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings&fmt=json`
  );
  if (!data || !data.media) return null;
  const tracks = data.media.flatMap((m) => (m.tracks || []).map((t) => ({
    no: t.number || String(t.position || ''),
    title: t.title || '',
    ms: t.length || 0,
  })));
  return tracks.length ? tracks : null;
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

/* ---------------- barcode entry point ---------------- */

export async function lookupBarcode(rawCode) {
  const code = digitsOnly(rawCode);
  if (!code) return null;
  if (looksLikeIsbn(code)) {
    return (await openLibraryByIsbn(code)) || (await googleBooks(`isbn:${code}`, code));
  }
  // Not an ISBN: almost certainly a record UPC/EAN. Fall back to Google Books
  // in case it's a barcoded book without a 978 prefix.
  const release = await musicBrainzByBarcode(code);
  if (release) {
    release.tracks = (await fetchTracks(release.mbid)) || [];
    return release;
  }
  return googleBooks(code, code);
}
