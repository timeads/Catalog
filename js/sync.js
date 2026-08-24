// Automatic sync through a private GitHub repo the user owns.
// The repo holds catalog.json (all metadata + tombstones) and covers/<id>.jpg.
// Merge is per-item last-write-wins on updatedAt; deletions carry tombstones
// so they propagate instead of resurrecting. Tokens stay in this browser.

import { getAllItems, putItem, deleteItem, migrateItem } from './db.js';
import { getBookcasesBundle, adoptBookcasesBundle } from './locations.js';

const CFG_KEY = 'stacks-sync-config';
const COVERS_KEY = 'stacks-sync-covers'; // {itemId: {sha, ts}} pushed from this device
const TOMB_KEY = 'stacks-tombstones'; // {itemId: deletedAtISO} local deletions
const LAST_KEY = 'stacks-sync-last';
const DATA_PATH = 'catalog.json';
const TOMBSTONE_TTL_DAYS = 120;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// With the app lock on, the config lives encrypted in the lock bundle and
// is provided at runtime instead of read from storage.
let cfgOverride;

export function overrideSyncConfig(cfg) {
  cfgOverride = cfg;
}

export function removeStoredSyncConfig() {
  localStorage.removeItem(CFG_KEY);
}

export function getSyncConfig() {
  if (cfgOverride !== undefined) {
    return cfgOverride && cfgOverride.token && cfgOverride.repo ? cfgOverride : null;
  }
  const cfg = readJson(CFG_KEY, null);
  return cfg && cfg.token && cfg.repo ? cfg : null;
}

export function setSyncConfig(cfg) {
  if (cfgOverride !== undefined) cfgOverride = cfg || null;
  if (cfg) {
    writeJson(CFG_KEY, cfg);
  } else {
    for (const k of [CFG_KEY, COVERS_KEY, LAST_KEY]) localStorage.removeItem(k);
  }
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

/* ---------------- GitHub contents API ---------------- */

function fileUrl(cfg, path) {
  return `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
}

function headers(cfg, extra = {}) {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

function b64ToText(b64) {
  const bytes = Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function readRemoteCatalog(cfg) {
  const res = await fetch(fileUrl(cfg, DATA_PATH), { headers: headers(cfg) });
  if (res.status === 404) return { data: null, sha: null };
  if (res.status === 401 || res.status === 403) throw new Error('GitHub rejected the token — check its access to the repo.');
  if (!res.ok) throw new Error(`Could not read from GitHub (${res.status}).`);
  const body = await res.json();
  return { data: JSON.parse(b64ToText(body.content || '')), sha: body.sha };
}

async function writeFile(cfg, path, base64, sha, message) {
  const res = await fetch(fileUrl(cfg, path), {
    method: 'PUT',
    headers: headers(cfg),
    body: JSON.stringify({ message, content: base64, ...(sha ? { sha } : {}) }),
  });
  if (res.status === 409 || res.status === 422) return null; // caller retries with a fresh sha
  if (!res.ok) throw new Error(`Could not write to GitHub (${res.status}).`);
  return (await res.json()).content;
}

async function fetchRemoteSha(cfg, path) {
  const res = await fetch(fileUrl(cfg, path), { headers: headers(cfg) });
  if (!res.ok) return null;
  return (await res.json()).sha || null;
}

async function readFileBlob(cfg, path) {
  const res = await fetch(fileUrl(cfg, path), {
    headers: headers(cfg, { Accept: 'application/vnd.github.raw+json' }),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return blob.size ? blob : null;
}

/* ---------------- merge ---------------- */

function serialize(item) {
  const { coverBlob, ...rest } = item;
  return {
    ...rest,
    photos: (item.photos || []).map(({ blob, ...p }) => p),
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

function newerOf(a, b) {
  return (a.updatedAt || '') >= (b.updatedAt || '') ? a : b;
}

function pruneTombstones(tombs) {
  const cutoff = new Date(Date.now() - TOMBSTONE_TTL_DAYS * 864e5).toISOString();
  const out = {};
  for (const [id, ts] of Object.entries(tombs)) if (ts > cutoff) out[id] = ts;
  return out;
}

/* ---------------- sync ---------------- */

let syncing = false;
let queued = false;

// Returns {applied, pushed} or throws with a user-readable message.
// onProgress(text) is optional.
export async function syncNow(onProgress = () => {}) {
  const cfg = getSyncConfig();
  if (!cfg) throw new Error('Sync is not set up yet.');
  if (syncing) { queued = true; return { skipped: true }; }
  syncing = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      onProgress('Syncing…');
      const [{ data: remote, sha }, localItems] = await Promise.all([
        readRemoteCatalog(cfg),
        getAllItems(),
      ]);
      const remoteItems = new Map((remote?.items || []).map((i) => [i.id, i]));
      const remoteTombs = remote?.deleted || {};
      const localTombs = readJson(TOMB_KEY, {});
      const tombs = pruneTombstones({ ...remoteTombs, ...localTombs });
      const localMap = new Map(localItems.map((i) => [i.id, i]));

      // Winner per id across both sides, then let newer tombstones erase.
      const ids = new Set([...remoteItems.keys(), ...localMap.keys()]);
      const merged = new Map();
      for (const id of ids) {
        const l = localMap.get(id);
        const r = remoteItems.get(id);
        const winner = l && r ? newerOf(l, r) : (l || r);
        if (tombs[id] && tombs[id] > (winner.updatedAt || '')) continue;
        merged.set(id, winner);
      }

      // Apply remote wins locally (grafting this device's image bytes back
      // in), migrate old-shape items, and give every local-only photo its
      // repo path before the catalog is serialized.
      let applied = 0;
      for (const [id, winner] of merged) {
        const l = localMap.get(id);
        let stored = winner;
        let dirty = winner !== l;
        if (dirty) {
          stored = graftPhotoBlobs({ ...winner }, l);
          delete stored.coverData;
        }
        if (migrateItem(stored)) dirty = true;
        for (const p of stored.photos) {
          if (p.blob && !p.file) { p.file = `covers/${id}/${p.id}.jpg`; dirty = true; }
        }
        if (dirty) {
          await putItem(stored);
          merged.set(id, stored);
          if (winner !== l) applied++;
        }
        localMap.set(id, stored);
      }
      for (const item of localItems) {
        if (!merged.has(item.id)) { await deleteItem(item.id); applied++; }
      }

      // Bookcase list: one bundle, newest edit wins.
      if (adoptBookcasesBundle(remote?.bookcases)) applied++;

      // Push the merged catalog if it differs from what the remote had.
      const payload = {
        app: 'stacks',
        version: 1,
        updatedAt: new Date().toISOString(),
        items: [...merged.values()].map(serialize),
        deleted: tombs,
        bookcases: getBookcasesBundle(),
      };
      const remoteComparable = JSON.stringify({ items: (remote?.items || []), deleted: remoteTombs, bookcases: remote?.bookcases || { updatedAt: '', list: [] } });
      const mergedComparable = JSON.stringify({ items: payload.items, deleted: payload.deleted, bookcases: payload.bookcases });
      let pushed = false;
      if (remoteComparable !== mergedComparable) {
        onProgress('Uploading catalog…');
        const result = await writeFile(cfg, DATA_PATH, textToB64(JSON.stringify(payload)), sha,
          `Sync catalog (${payload.items.length} items)`);
        if (result === null) continue; // sha conflict: another device pushed — re-merge
        pushed = true;
      }

      applied += await syncCovers(cfg, merged, localMap, onProgress);

      writeJson(TOMB_KEY, tombs);
      localStorage.setItem(LAST_KEY, new Date().toISOString());
      return { applied, pushed };
    }
    throw new Error('Another device kept updating — try syncing again.');
  } finally {
    syncing = false;
    if (queued) { queued = false; syncNow(onProgress).catch(() => {}); }
  }
}

async function syncCovers(cfg, merged, localMap, onProgress) {
  const pushed = readJson(COVERS_KEY, {});
  let pulls = 0;
  for (const [id, item] of merged) {
    const local = localMap.get(id) || item;
    let pullDirty = false;
    for (const photo of local.photos || []) {
      if (!photo.file) continue;
      if (photo.blob) {
        const key = `${id}/${photo.id}`;
        const mark = pushed[key];
        if (mark && mark.ts >= (local.updatedAt || '')) continue;
        onProgress('Uploading photos…');
        let sha = (mark && mark.sha) || null;
        let result = await writeFile(cfg, photo.file, await blobToB64(photo.blob), sha, `Photo for ${local.title || id}`);
        if (result === null) {
          sha = await fetchRemoteSha(cfg, photo.file);
          result = await writeFile(cfg, photo.file, await blobToB64(photo.blob), sha, `Photo for ${local.title || id}`);
        }
        if (result) pushed[key] = { sha: result.sha, ts: local.updatedAt || new Date().toISOString() };
      } else {
        onProgress('Downloading photos…');
        const blob = await readFileBlob(cfg, photo.file);
        if (blob) { photo.blob = blob; pullDirty = true; }
      }
    }
    if (pullDirty) {
      migrateItem(local); // refresh the legacy cover mirror
      await putItem(local);
      pulls++;
    }
  }
  writeJson(COVERS_KEY, pushed);
  return pulls;
}
