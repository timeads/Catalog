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
    coverUrl: '',
    coverBlob: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Ask the browser to protect IndexedDB from storage-pressure eviction.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
