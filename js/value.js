// Item valuation helpers: prefilled market-search links for every item,
// and live Discogs marketplace prices for records (free personal token,
// pasted once in Settings — api.discogs.com allows browser requests).

const TOKEN_KEY = 'stacks-discogs-token';

export function getDiscogsToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setDiscogsToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function parseValue(raw) {
  const n = parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function fmtMoney(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: n % 1 ? 2 : 0,
  }).format(n);
}

/* ---------------- market links ---------------- */

// Where collectors actually check prices. Every link opens live results
// prefilled for this item; eBay is filtered to sold + completed listings.
export function marketLinks(item) {
  const q = encodeURIComponent([item.creator, item.title].filter(Boolean).join(' '));
  const links = [
    { label: 'eBay sold listings', url: `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1` },
  ];
  if (item.kind === 'record') {
    links.push(
      item.discogsId
        ? { label: 'Discogs sale history', url: `https://www.discogs.com/sell/history/${item.discogsId}` }
        : { label: 'Discogs', url: `https://www.discogs.com/search/?q=${q}&type=release` },
      { label: 'Popsike auction archive', url: `https://www.popsike.com/php/quicksearch.php?searchtext=${q}` },
    );
  } else {
    const isbn = (item.barcode || '').replace(/[^0-9Xx]/g, '');
    const title = encodeURIComponent(item.title || '');
    const author = encodeURIComponent(item.creator || '');
    links.push(
      { label: 'AbeBooks', url: isbn
        ? `https://www.abebooks.com/servlet/SearchResults?isbn=${isbn}`
        : `https://www.abebooks.com/servlet/SearchResults?tn=${title}&an=${author}` },
      { label: 'BookFinder', url: isbn
        ? `https://www.bookfinder.com/search/?isbn=${isbn}&mode=isbn&st=sr&ac=qr`
        : `https://www.bookfinder.com/search/?title=${title}&author=${author}&mode=advanced&st=sr&ac=qr` },
      { label: 'Biblio', url: isbn
        ? `https://www.biblio.com/search.php?keyisbn=${isbn}`
        : `https://www.biblio.com/search.php?title=${title}&author=${author}` },
    );
  }
  return links;
}

/* ---------------- Discogs live prices ---------------- */

async function discogsGet(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.discogs.com${path}${sep}token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/vnd.discogs.v2.plaintext+json' },
  });
  if (res.status === 401) throw new Error('Discogs rejected the token.');
  if (res.status === 429) throw new Error('Discogs rate limit — try again in a minute.');
  if (!res.ok) throw new Error(`Discogs error (${res.status}).`);
  return res.json();
}

async function findDiscogsRelease(item, token) {
  if (item.discogsId) return item.discogsId;
  const barcode = (item.barcode || '').replace(/[^0-9]/g, '');
  if (barcode) {
    const data = await discogsGet(`/database/search?barcode=${barcode}&type=release&per_page=3`, token);
    const hit = (data.results || [])[0];
    if (hit) return hit.id;
  }
  const q = [item.creator, item.title].filter(Boolean).join(' ');
  if (!q) return null;
  const data = await discogsGet(`/database/search?q=${encodeURIComponent(q)}&type=release&per_page=3`, token);
  const hit = (data.results || [])[0];
  return hit ? hit.id : null;
}

// Live marketplace stats for a record. Returns
// {releaseId, lowestPrice|null, numForSale, url} or null when unmatched.
export async function discogsStats(item, token) {
  const releaseId = await findDiscogsRelease(item, token);
  if (!releaseId) return null;
  const stats = await discogsGet(`/marketplace/stats/${releaseId}?curr_abbr=USD`, token);
  return {
    releaseId,
    lowestPrice: stats.lowest_price ? stats.lowest_price.value : null,
    numForSale: stats.num_for_sale || 0,
    url: `https://www.discogs.com/release/${releaseId}`,
  };
}
