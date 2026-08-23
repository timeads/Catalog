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
{"kind": "record" or "book", "title": "...", "creator": "artist or author name", "year": "release/publication year if visible or well known, else empty string", "confidence": "high"/"medium"/"low"}
If you cannot read or recognize the item at all, respond {"kind": "", "title": "", "creator": "", "year": "", "confidence": "low"}.`;

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
        max_tokens: 512,
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
    confidence: out.confidence || 'low',
  };
}
