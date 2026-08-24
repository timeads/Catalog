// Photo identification: send the cover photo to the Claude API (with the
// user's own key, pasted once in Settings) and get back what the item is.
// The key is stored like the other tokens — locally, and encrypted when
// the app lock is on.

const KEY_KEY = 'stacks-vision-key';

let keyOverride;

export function overrideVisionKey(key) {
  keyOverride = key;
}

export function removeStoredVisionKey() {
  try { localStorage.removeItem(KEY_KEY); } catch {}
}

export function getVisionKey() {
  if (keyOverride !== undefined) return keyOverride || '';
  try { return localStorage.getItem(KEY_KEY) || ''; } catch { return ''; }
}

export function setVisionKey(key) {
  if (keyOverride !== undefined) keyOverride = key || '';
  try {
    if (key) localStorage.setItem(KEY_KEY, key);
    else localStorage.removeItem(KEY_KEY);
  } catch {}
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const PROMPT = `This is a photo of a record sleeve or a book cover from a personal collection.
Identify it. Respond with ONLY a JSON object, no other text:
{"kind": "record" or "book", "title": "...", "creator": "artist or author name", "year": "release/publication year if visible or well known, else empty string", "genre": "1-3 comma-separated music genres or book categories, else empty string", "summary": "...", "confidence": "high"/"medium"/"low"}
For the summary, only if you recognize the specific item: for a record, one or two factual sentences about the release; for a book, 2-4 sentences on what the book is about, ending with one sentence of notable context (awards, series position, or why it matters). Empty string if unrecognized.
If you cannot read or recognize the item at all, respond {"kind": "", "title": "", "creator": "", "year": "", "genre": "", "summary": "", "confidence": "low"}.`;

// Returns {kind, title, creator, year, confidence} or throws with a
// user-readable message.
export async function identifyPhoto(blob, key) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 700,
        output_config: { effort: 'low' },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: blob.type || 'image/jpeg',
                data: await blobToB64(blob),
              },
            },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
  } catch {
    throw new Error("Couldn't reach the Claude API — check your connection.");
  }
  if (!res.ok) {
    // Show the API's own explanation — it names the real cause (no credit,
    // invalid key, model access…), which a bare status code hides.
    let apiMessage = '';
    try { apiMessage = (await res.json()).error.message || ''; } catch {}
    if (res.status === 401) throw new Error('Claude rejected the API key — check it in Settings.');
    if (res.status === 429) throw new Error('Claude rate limit — try again in a moment.');
    throw new Error(apiMessage ? `Claude API: ${apiMessage}` : `Identification failed (${res.status}).`);
  }
  const body = await res.json();
  if (body.stop_reason === 'refusal') throw new Error('Claude declined to analyze this photo.');
  const text = (body.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Couldn't read the identification result.");
  const out = JSON.parse(match[0]);
  return {
    kind: out.kind === 'book' ? 'book' : out.kind === 'record' ? 'record' : '',
    title: String(out.title || '').trim(),
    creator: String(out.creator || '').trim(),
    year: String(out.year || '').trim(),
    genre: String(out.genre || '').trim(),
    summary: String(out.summary || '').trim(),
    confidence: out.confidence || 'low',
  };
}

// Mood picks: given the user's own collection and a mood, choose and order
// a stack — a listening playlist for records, a reading stack for books.
// Only the catalog's text fields leave the device; costs a fraction of a
// cent per ask on the user's key.
export async function recommendPicks(collection, kind, mood, key) {
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const digest = collection.slice(0, 400).map((i) =>
    `${i.id} | ${clip(i.title, 70)} | ${clip(i.creator, 45)} | ${clip(i.year, 8)} | ${clip(i.genre, 45)} | ${clip((i.tags || []).join(', '), 45)} | ${clip(i.summary, 140)}`
  ).join('\n');
  const noun = kind === 'book' ? 'reading stack' : 'playlist';
  const ordering = kind === 'book'
    ? 'order picks from most to least fitting'
    : 'order picks as a listening arc (set the mood first, peak in the middle, land gently)';
  const prompt = `Choosing from someone's own ${kind} collection for a mood. Pick only from this list.
Mood: "${clip(mood, 200)}"
Collection (id | title | creator | year | genre | shelves | about):
${digest}

Respond with ONLY a JSON object, no other text:
{"title": "a short evocative name for this ${noun}", "note": "one sentence on the arc and why it fits the mood", "picks": [{"id": "...", "why": "one short concrete sentence for this pick"}]}
Rules: ids must come from the list verbatim; pick 5-8 (fewer when few genuinely fit); ${ordering}; if nothing fits, return an empty picks array with a kind note.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1000,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    throw new Error("Couldn't reach the Claude API — check your connection.");
  }
  if (!res.ok) {
    let apiMessage = '';
    try { apiMessage = (await res.json()).error.message || ''; } catch {}
    if (res.status === 401) throw new Error('Claude rejected the API key — check it in Settings.');
    if (res.status === 429) throw new Error('Claude rate limit — try again in a moment.');
    throw new Error(apiMessage ? `Claude API: ${apiMessage}` : `Couldn't build the ${noun} (${res.status}).`);
  }
  const body = await res.json();
  if (body.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Couldn't read the picks.");
  const out = JSON.parse(match[0]);
  const known = new Set(collection.map((i) => i.id));
  return {
    title: String(out.title || '').trim(),
    note: String(out.note || '').trim(),
    picks: (Array.isArray(out.picks) ? out.picks : [])
      .filter((p) => p && known.has(p.id))
      .map((p) => ({ id: p.id, why: String(p.why || '').trim() })),
  };
}

// Text-only enrichment for items added by scan, search, or typing:
// genre/categories plus a short factual summary. Returns {genre, summary};
// empty strings when the item isn't recognized.
export async function enrichItem(item, key) {
  const what = item.kind === 'book' ? 'book' : 'album/record';
  const summarySpec = item.kind === 'book'
    ? '2-4 sentences on what the book is about, ending with one sentence of notable context (awards, series position, or why it matters)'
    : 'one or two factual sentences about this specific release';
  const prompt = `Cataloging a personal collection. Item: ${what} "${item.title}" by ${item.creator || 'unknown'}${item.year ? ` (${item.year})` : ''}.
Respond with ONLY a JSON object, no other text:
{"genre": "1-3 comma-separated ${item.kind === 'book' ? 'book categories' : 'music genres'}", "summary": "${summarySpec}"}
If you don't recognize this specific ${what}, use empty strings — do not guess or invent details.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: item.kind === 'book' ? 700 : 400,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) return { genre: '', summary: '' };
  const body = await res.json();
  if (body.stop_reason === 'refusal') return { genre: '', summary: '' };
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { genre: '', summary: '' };
  try {
    const out = JSON.parse(match[0]);
    return { genre: String(out.genre || '').trim(), summary: String(out.summary || '').trim() };
  } catch {
    return { genre: '', summary: '' };
  }
}
