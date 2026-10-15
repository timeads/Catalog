// Automatic sync through the person's own account (Supabase).
// Local-first: every device keeps the full catalog in IndexedDB and works
// offline; sync pulls what changed elsewhere, then pushes what changed here.
// Merge is per-item newest-edit-wins on updatedAt (also enforced
// server-side), deletions travel as tombstones, and photos live in private
// storage under "<user id>/<item id>/<photo id>.jpg".

import { getAllItems, putItem, deleteItem, migrateItem } from './db.js';
import { getBookcasesBundle, adoptBookcasesBundle } from './locations.js';
import { getDiscogsToken, setDiscogsToken } from './value.js';
import { getVisionKey, setVisionKey } from './identify.js';
import { cloud, currentUser } from './cloud.js';

const TOMB_KEY = 'stacks-tombstones'; // {itemId: deletedAtISO} local deletions not yet pushed
const LAST_KEY = 'stacks-sync-last'; // when this device last synced (for display)
const CURSOR_KEY = 'stacks-cloud-cursor'; // newest server synced_at seen
const PUSHED_KEY = 'stacks-cloud-pushed'; // {itemId: updatedAt} last version pushed or pulled
const PHOTOS_KEY = 'stacks-cloud-photos'; // {path: 1} photos known to be in storage
const OWNER_KEY = 'stacks-owner'; // account the local catalog belongs to
const BUCKET = 'covers';
const PULL_OVERLAP_MS = 10 * 60 * 1000; // re-read a little behind the cursor
const PAGE = 1000;
const PUSH_CHUNK = 200;

// Keys the GitHub-repo sync used; cleared once accounts take over.
const LEGACY_KEYS = ['stacks-sync-config', 'stacks-sync-covers'];

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

export function lastSyncedAt() {
  return localStorage.getItem(LAST_KEY) || '';
}

// Call when an item is deleted locally, so the deletion syncs outward.
export function recordTombstone(id) {
  const t = readJson(TOMB_KEY, {});
  t[id] = new Date().toISOString();
  writeJson(TOMB_KEY, t);
}

/* ---------------- which account this device's catalog belongs to ---------------- */

export function getDeviceOwner() {
  return localStorage.getItem(OWNER_KEY) || '';
}

export function setDeviceOwner(userId) {
  try { localStorage.setItem(OWNER_KEY, userId); } catch {}
}

// Forget everything sync knows about the server — for switching accounts or
// after the local catalog was wiped, so the next sync starts clean.
export function resetSyncState() {
  for (const k of [CURSOR_KEY, PUSHED_KEY, PHOTOS_KEY, LAST_KEY, TOMB_KEY, OWNER_KEY, ...LEGACY_KEYS]) {
    try { localStorage.removeItem(k); } catch {}
  }
}

/* ---------------- token sync ---------------- */

// The Discogs token and Claude key follow the person between devices via
// their private user_state row. Per-token newest-change-wins; explicit
// removals propagate too.

const TOKEN_META_KEY = 'stacks-token-meta'; // {discogs: changedAtISO, vision: changedAtISO}
const TOKEN_EPOCH = '2000-01-01T00:00:00.000Z'; // "existed before token sync did"

const TOKEN_ACCESS = {
  discogs: { get: getDiscogsToken, set: setDiscogsToken },
  vision: { get: getVisionKey, set: setVisionKey },
};

// Call when the user saves or removes a token, so their change wins merges.
export function markTokenUpdated(name) {
  const meta = readJson(TOKEN_META_KEY, {});
  meta[name] = new Date().toISOString();
  writeJson(TOKEN_META_KEY, meta);
}

function tokensBundle() {
  const meta = readJson(TOKEN_META_KEY, {});
  const out = {};
  let metaDirty = false;
  for (const [name, { get }] of Object.entries(TOKEN_ACCESS)) {
    const v = get() || '';
    if (v && !meta[name]) { meta[name] = TOKEN_EPOCH; metaDirty = true; }
    out[name] = { v, ts: meta[name] || '' };
  }
  if (metaDirty) writeJson(TOKEN_META_KEY, meta);
  return out;
}

function adoptTokensBundle(remote) {
  if (!remote) return false;
  const meta = readJson(TOKEN_META_KEY, {});
  let changed = false;
  for (const [name, { set }] of Object.entries(TOKEN_ACCESS)) {
    const r = remote[name];
    if (!r || !r.ts || r.ts <= (meta[name] || '')) continue;
    set(r.v || '');
    meta[name] = r.ts;
    changed = true;
  }
  if (changed) writeJson(TOKEN_META_KEY, meta);
  return changed;
}

/* ---------------- item shape on the wire ---------------- */

function photoPath(itemId, photo) {
  return `${itemId}/${photo.id}.jpg`;
}

// Strip image bytes; mark which photos have a stored file.
function serialize(item) {
  const { coverBlob, ...rest } = item;
  return {
    ...rest,
    photos: (item.photos || []).map(({ blob, ...p }) => ({
      ...p,
      file: blob || p.file ? photoPath(item.id, p) : undefined,
    })),
    hasCoverFile: !!coverBlob || !!item.hasCoverFile,
  };
}

// The winner of a merge may be the remote copy, which carries no image
// bytes — graft the blobs this device already has back in by photo id.
function graftPhotoBlobs(winner, local) {
  const localBlobs = new Map(((local && local.photos) || []).map((p) => [p.id, p.blob]));
  winner.photos = (winner.photos || []).map((p) => ({
    ...p,
    blob: p.blob || localBlobs.get(p.id) || null,
  }));
  return winner;
}

function cloudError(error, what) {
  const m = String((error && error.message) || '');
  if (/row-level security|permission denied/i.test(m)) {
    return new Error('This account isn’t approved for Stacks yet. Ask the app’s owner to add your email.');
  }
  if (/jwt|token/i.test(m)) return new Error('Your sign-in expired. Sign in again.');
  if (/fetch|network|failed to fetch/i.test(m)) return new Error('Couldn’t reach the server. Check your connection.');
  return new Error(m ? `${what}: ${m}` : `${what} failed.`);
}

/* ---------------- sync ---------------- */

let syncing = false;
let queued = false;

// Returns {applied, pushed, tokensAdopted} or throws with a user-readable
// message. onProgress(text) is optional.
export async function syncNow(onProgress = () => {}) {
  const sb = cloud();
  if (!sb) throw new Error('Accounts aren’t set up in this version of the app.');
  const user = await currentUser();
  if (!user) throw new Error('Sign in to sync.');
  if (syncing) { queued = true; return { skipped: true }; }
  syncing = true;
  try {
    onProgress('Syncing…');
    for (const k of LEGACY_KEYS) { try { localStorage.removeItem(k); } catch {} }

    const allowed = await sb.rpc('is_allowed');
    if (allowed.error) throw cloudError(allowed.error, 'Sync');
    if (!allowed.data) {
      throw new Error('This account isn’t approved for Stacks yet. Ask the app’s owner to add your email.');
    }

    const uid = user.id;
    const pushed = readJson(PUSHED_KEY, {});
    const tombs = readJson(TOMB_KEY, {});
    const localItems = await getAllItems();
    const localMap = new Map(localItems.map((i) => [i.id, i]));
    let applied = 0;

    // 1. Pull rows changed since the cursor (a little behind it, to be safe).
    const cursor = localStorage.getItem(CURSOR_KEY) || '';
    const since = cursor ? new Date(ms(cursor) - PULL_OVERLAP_MS).toISOString() : '';
    let newest = cursor;
    for (let from = 0; ; from += PAGE) {
      let q = sb.from('items')
        .select('id,data,deleted,updated_at,synced_at')
        .order('synced_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (since) q = q.gt('synced_at', since);
      const { data: rows, error } = await q;
      if (error) throw cloudError(error, 'Downloading the catalog');
      for (const row of rows) {
        if (ms(row.synced_at) > ms(newest)) newest = row.synced_at;
        const l = localMap.get(row.id);
        const remoteTs = ms(row.updated_at);
        if (row.deleted) {
          if (l && ms(l.updatedAt) <= remoteTs) {
            await deleteItem(row.id);
            localMap.delete(row.id);
            applied++;
          }
          delete pushed[row.id];
          continue;
        }
        if (tombs[row.id] && ms(tombs[row.id]) >= remoteTs) continue; // deleted here, more recently
        if (!l || remoteTs > ms(l.updatedAt)) {
          const stored = graftPhotoBlobs({ ...row.data }, l);
          migrateItem(stored);
          await putItem(stored);
          localMap.set(stored.id, stored);
          pushed[stored.id] = stored.updatedAt;
          applied++;
        } else if (remoteTs === ms(l.updatedAt)) {
          pushed[l.id] = l.updatedAt;
        }
      }
      if (rows.length < PAGE) break;
    }

    // 2. Push local edits the server hasn't seen, plus local deletions.
    const rows = [];
    for (const item of localMap.values()) {
      if (pushed[item.id] === item.updatedAt) continue;
      rows.push({
        user_id: uid,
        id: item.id,
        data: serialize(item),
        deleted: false,
        updated_at: item.updatedAt || new Date().toISOString(),
      });
    }
    for (const [id, ts] of Object.entries(tombs)) {
      if (localMap.has(id)) continue; // re-created since
      rows.push({ user_id: uid, id, data: {}, deleted: true, updated_at: ts });
    }
    let pushedCount = 0;
    if (rows.length) onProgress('Uploading catalog…');
    for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
      const chunk = rows.slice(i, i + PUSH_CHUNK);
      const { error } = await sb.from('items').upsert(chunk, { onConflict: 'user_id,id' });
      if (error) throw cloudError(error, 'Uploading the catalog');
      for (const r of chunk) {
        if (r.deleted) delete tombs[r.id];
        else pushed[r.id] = r.updated_at;
      }
      pushedCount += chunk.length;
    }
    writeJson(PUSHED_KEY, pushed);
    writeJson(TOMB_KEY, tombs);

    // 3. Bookcases and tokens: adopt newer remote changes, then store ours.
    const state = await sb.from('user_state').select('bookcases,tokens').maybeSingle();
    if (state.error) throw cloudError(state.error, 'Syncing settings');
    const remoteState = state.data || null;
    if (remoteState && adoptBookcasesBundle(remoteState.bookcases)) applied++;
    const tokensAdopted = remoteState ? adoptTokensBundle(remoteState.tokens) : false;
    if (tokensAdopted) applied++;
    const mine = { bookcases: getBookcasesBundle(), tokens: tokensBundle() };
    const same = remoteState
      && JSON.stringify(remoteState.bookcases) === JSON.stringify(mine.bookcases)
      && JSON.stringify(remoteState.tokens) === JSON.stringify(mine.tokens);
    if (!same) {
      const { error } = await sb.from('user_state').upsert({
        user_id: uid, ...mine, updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (error) throw cloudError(error, 'Syncing settings');
    }

    // 4. Photos: upload new ones, download missing ones.
    applied += await syncPhotos(sb, uid, localMap, onProgress);

    if (newest) localStorage.setItem(CURSOR_KEY, newest);
    localStorage.setItem(LAST_KEY, new Date().toISOString());
    setDeviceOwner(uid);
    return { applied, pushed: pushedCount > 0, tokensAdopted };
  } finally {
    syncing = false;
    if (queued) { queued = false; syncNow(onProgress).catch(() => {}); }
  }
}

async function syncPhotos(sb, uid, localMap, onProgress) {
  const known = readJson(PHOTOS_KEY, {});
  const store = sb.storage.from(BUCKET);
  let pulls = 0;
  try {
    for (const item of localMap.values()) {
      let dirty = false;
      for (const photo of item.photos || []) {
        const path = photoPath(item.id, photo);
        if (photo.blob) {
          if (known[path]) continue;
          onProgress('Uploading photos…');
          const { error } = await store.upload(`${uid}/${path}`, photo.blob, {
            upsert: true,
            contentType: photo.blob.type || 'image/jpeg',
          });
          if (error) throw cloudError(error, 'Uploading photos');
          known[path] = 1;
        } else if (photo.file) {
          onProgress('Downloading photos…');
          const { data, error } = await store.download(`${uid}/${path}`);
          if (error || !data || !data.size) continue; // not uploaded yet by its device
          photo.blob = data;
          known[path] = 1;
          dirty = true;
        }
      }
      if (dirty) {
        migrateItem(item); // refresh the legacy cover mirror
        await putItem(item);
        pulls++;
      }
    }
  } finally {
    writeJson(PHOTOS_KEY, known);
  }
  return pulls;
}
