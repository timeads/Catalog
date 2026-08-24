// Physical locations: user-defined bookcases (name + shelf count), managed
// in Settings. Items reference a bookcase id + shelf number. The list syncs
// through the catalog payload as one bundle, newest edit wins.

const KEY = 'stacks-bookcases';

function readBundle() {
  try {
    const b = JSON.parse(localStorage.getItem(KEY));
    if (b && Array.isArray(b.list)) return b;
  } catch {}
  return { updatedAt: '', list: [] };
}

export function getBookcases() {
  return readBundle().list;
}

export function getBookcasesBundle() {
  return readBundle();
}

// Adopt a bundle from sync/backup when it's newer than what we have.
// Returns true when it replaced the local list.
export function adoptBookcasesBundle(bundle) {
  if (!bundle || !Array.isArray(bundle.list)) return false;
  if ((bundle.updatedAt || '') <= (readBundle().updatedAt || '')) return false;
  try { localStorage.setItem(KEY, JSON.stringify(bundle)); } catch {}
  return true;
}

export function saveBookcases(list) {
  const bundle = { updatedAt: new Date().toISOString(), list };
  try { localStorage.setItem(KEY, JSON.stringify(bundle)); } catch {}
  return bundle;
}

export function newBookcase(name, shelves) {
  return {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    shelves: Math.max(1, Math.min(50, parseInt(shelves, 10) || 1)),
  };
}

export function locationLabel(item, bookcases = getBookcases()) {
  if (!item.bookcaseId) return '';
  const bc = bookcases.find((b) => b.id === item.bookcaseId);
  if (!bc) return item.shelf ? `Shelf ${item.shelf}` : '';
  return item.shelf ? `${bc.name} · Shelf ${item.shelf}` : bc.name;
}
