// IndexedDB storage for catalog items. Covers are stored as Blobs on the
// item record itself, so a single object store holds everything.

const DB_NAME = 'stacks-catalog';
const DB_VERSION = 1;
const STORE = 'items';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function getAllItems() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export function putItem(item) {
  return tx('readwrite', (store) => store.put(item));
}

export function deleteItem(id) {
  return tx('readwrite', (store) => store.delete(id));
}

export function newItem(kind) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind, // 'record' | 'book'
    title: '',
    creator: '',
    year: '',
    format: '',
    publisher: '',
    genre: '',
    barcode: '',
    condition: '',
    tags: [],
    notes: '',
    tracks: [], // records: [{no, title, ms}] from MusicBrainz
    mbid: '', // MusicBrainz release id, when known
    discogsId: '', // Discogs release id, once matched
    value: '', // estimated value, free-form number
    valueDate: '', // when the estimate was last set
    // photos[0] is the default/cover. Each: {id, blob, url, file, label}
    // where blob is device-local, url is a remote image, file is the
    // sync-repo path once uploaded, label e.g. 'Back'.
    photos: [],
    // Legacy mirrors of photos[0], kept so older clients and old sync
    // data keep showing a cover.
    coverUrl: '',
    coverBlob: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function newPhoto(fields = {}) {
  return { id: crypto.randomUUID(), blob: null, url: '', file: '', label: '', ...fields };
}

// Upgrade items saved before the photo gallery existed (single
// coverBlob/coverUrl, optionally a covers/<id>.jpg file in the sync repo).
// Returns true when the item was changed.
export function migrateItem(item) {
  let changed = false;
  if (!Array.isArray(item.photos)) { item.photos = []; changed = true; }
  if (!item.photos.length && (item.coverBlob || item.coverUrl || item.hasCoverFile)) {
    item.photos.push(newPhoto({
      blob: item.coverBlob || null,
      url: item.coverUrl || '',
      file: item.hasCoverFile ? `covers/${item.id}.jpg` : '',
    }));
    changed = true;
  }
  // Keep the legacy mirror fields following the default photo.
  const p = item.photos[0] || null;
  const mirrorBlob = (p && p.blob) || null;
  const mirrorUrl = (p && p.url) || '';
  if (item.coverBlob !== mirrorBlob || item.coverUrl !== mirrorUrl) {
    item.coverBlob = mirrorBlob;
    item.coverUrl = mirrorUrl;
    changed = true;
  }
  return changed;
}

// Ask the browser to protect IndexedDB from storage-pressure eviction.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
