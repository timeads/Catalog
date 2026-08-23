import { getAllItems, putItem, deleteItem, newItem } from './db.js';
import { lookupBarcode, searchBooks, searchRecords, fetchTracks } from './lookup.js';
import { startScanner } from './scanner.js';
import { getSyncConfig, setSyncConfig, lastSyncedAt, recordTombstone, syncNow } from './sync.js';

/* ---------------- state ---------------- */

let items = [];
let filterKind = 'all';
let filterTag = null;
let searchQuery = '';
let sortBy = 'added';
let searchKind = 'record'; // online-search toggle
let draft = null; // item being created/edited in the form
let stopScan = null; // active scanner's stop()
let currentView = 'home';
const coverUrls = new Map(); // item id -> object URL for its cover blob

let viewMode = 'grid'; // library layout: 'grid' | 'list'
try { viewMode = localStorage.getItem('stacks-view') === 'list' ? 'list' : 'grid'; } catch {}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const FORMAT_OPTIONS = {
  record: ['LP', '2×LP', 'EP', '7" single', '10"', '12" single', '78 rpm', 'Box set', 'Cassette', 'CD'],
  book: ['Hardcover', 'Paperback', 'Trade paperback', 'Mass market', 'Oversize', 'Boxed set', 'Zine', 'Signed'],
};

// Placeholder cover tones, [background, initial] pairs.
const PLACEHOLDER_TONES = [
  ['#292524', '#e7e5e4'],
  ['#7c2d12', '#fed7aa'],
  ['#44403c', '#e7e5e4'],
  ['#854d0e', '#fef3c7'],
  ['#57534e', '#f5f5f4'],
  ['#431407', '#fdba74'],
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function placeholderTone(item) {
  let h = 0;
  const s = (item.creator || item.title || '').toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PLACEHOLDER_TONES[h % PLACEHOLDER_TONES.length];
}

function coverSrc(item) {
  if (item.coverBlob) {
    if (!coverUrls.has(item.id)) coverUrls.set(item.id, URL.createObjectURL(item.coverBlob));
    return coverUrls.get(item.id);
  }
  return item.coverUrl || '';
}

function coverHtml(item, cls = 'cover') {
  const src = coverSrc(item);
  if (!src) return placeholderHtml(item);
  // If the remote cover 404s (common for Cover Art Archive), swap in the placeholder.
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy"
    onerror="this.hidden=true;this.nextElementSibling.hidden=false">${placeholderHtml(item, true)}`;
}

function placeholderHtml(item, hidden = false) {
  const initial = (item.title || '?').trim().charAt(0).toUpperCase();
  const [bg, ink] = placeholderTone(item);
  return `<div class="cover-placeholder"${hidden ? ' hidden' : ''} style="--ph-bg:${bg};--ph-ink:${ink}">${esc(initial)}</div>`;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ---------------- routing ---------------- */

const views = {
  home: $('#view-home'),
  library: $('#view-library'),
  scan: $('#view-scan'),
  lookup: $('#view-lookup'),
  form: $('#view-form'),
  detail: $('#view-detail'),
  settings: $('#view-settings'),
};

const ROUTE_ALIASES = { collection: 'library', backup: 'settings', search: 'lookup', add: 'sheet' };

function route() {
  const hash = location.hash || '#/';
  let [, path, arg] = hash.match(/^#\/([a-z]*)\/?(.*)$/) || [null, '', ''];
  if (ROUTE_ALIASES[path] === 'sheet') { location.hash = '#/'; openSheet(); return; }
  path = ROUTE_ALIASES[path] || path;

  if (stopScan) { stopScan(); stopScan = null; }
  closeSheet();
  Object.values(views).forEach((v) => { v.hidden = true; });

  let view = 'home';
  if (path === 'library') view = 'library';
  else if (path === 'scan') view = 'scan';
  else if (path === 'lookup') view = 'lookup';
  else if (path === 'new' || path === 'edit') view = 'form';
  else if (path === 'item') view = 'detail';
  else if (path === 'settings') view = 'settings';

  if (view === 'form') {
    if (path === 'edit') {
      const item = items.find((i) => i.id === arg);
      if (!item) { location.hash = '#/'; return; }
      draft = structuredClone(item);
    } else if (!draft) {
      draft = newItem('record');
    }
    renderForm();
  }
  if (view === 'detail') {
    const item = items.find((i) => i.id === arg);
    if (!item) { location.hash = '#/'; return; }
    renderDetail(item);
  }
  if (view === 'home') renderHome();
  if (view === 'library') {
    if (arg === 'book' || arg === 'record') {
      filterKind = arg;
      $$('.kind-chip[data-kind]').forEach((x) => x.classList.toggle('is-active', x.dataset.kind === arg));
    }
    renderLibrary();
  }
  if (view === 'scan') beginScan();
  if (view === 'settings') renderSettings();
  if (view !== 'form' && view !== 'scan') draft = null;

  currentView = view;
  views[view].hidden = false;
  const tab =
    view === 'home' ? 'home'
    : view === 'library' || view === 'detail' ? 'library'
    : view === 'scan' ? 'scan'
    : view === 'settings' ? 'settings' : '';
  $$('[data-tab]').forEach((a) => a.classList.toggle('is-active', a.dataset.tab === tab));
  window.scrollTo(0, 0);
}

// Re-render whatever is on screen (after sync pulls in changes).
function rerender() {
  updateNavCount();
  if (currentView === 'home') renderHome();
  if (currentView === 'library') renderLibrary();
  if (currentView === 'settings') renderSettings();
  if (currentView === 'detail') {
    const id = (location.hash.match(/^#\/item\/(.*)$/) || [])[1];
    const item = items.find((i) => i.id === id);
    if (item) renderDetail(item); else location.hash = '#/';
  }
}

function updateNavCount() {
  const el = $('#nav-count');
  if (el) el.textContent = items.length || '';
}

/* ---------------- add sheet ---------------- */

function openSheet() {
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  requestAnimationFrame(() => {
    $('#sheet').classList.add('is-open');
    $('#sheet-backdrop').classList.add('is-open');
  });
}

function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  sheet.classList.remove('is-open');
  $('#sheet-backdrop').classList.remove('is-open');
  setTimeout(() => { sheet.hidden = true; $('#sheet-backdrop').hidden = true; }, 230);
}

/* ---------------- home ---------------- */

function renderHome() {
  const records = items.filter((i) => i.kind === 'record').length;
  $('#stat-records').textContent = records;
  $('#stat-books').textContent = items.length - records;
  $('#stat-shelves').textContent = [...new Set(items.flatMap((i) => i.tags || []))].length;

  const recent = [...items]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 12);
  const rail = $('#recent-rail');
  const empty = items.length === 0;
  $('#home-empty').hidden = !empty;
  rail.hidden = empty;
  $('#view-home .section-head').hidden = empty;
  rail.innerHTML = recent.map((it) => `
    <a class="rail-card" href="#/item/${it.id}">
      <span class="cover-wrap">
        ${it.tags[0] ? `<span class="cover-tag">${esc(it.tags[0])}</span>` : ''}
        ${coverHtml(it)}
      </span>
      <p class="card-title">${esc(it.title)}</p>
      <p class="card-creator">${esc(it.creator)}</p>
    </a>`).join('');
}

/* ---------------- library ---------------- */

// Case- and accent-insensitive ("Café" matches "cafe").
function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function visibleItems() {
  const terms = fold(searchQuery).split(/\s+/).filter(Boolean);
  const list = items.filter((it) => {
    if (filterKind !== 'all' && it.kind !== filterKind) return false;
    if (filterTag && !it.tags.includes(filterTag)) return false;
    if (terms.length) {
      const hay = fold([it.title, it.creator, it.publisher, it.genre, it.year,
        it.format, it.notes, it.barcode, ...(it.tags || [])].join(' '));
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const by = {
    added: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    title: (a, b) => a.title.localeCompare(b.title),
    creator: (a, b) => (a.creator || '~').localeCompare(b.creator || '~') || a.title.localeCompare(b.title),
    year: (a, b) => (a.year || '9999').localeCompare(b.year || '9999'),
  };
  return list.sort(by[sortBy] || by.added);
}

function cardHtml(it) {
  return `
    <a class="item-card" href="#/item/${it.id}">
      <span class="cover-wrap">${coverHtml(it)}</span>
      <p class="card-title">${esc(it.title)}</p>
      <p class="card-creator">${esc(it.creator)}</p>
      <p class="card-meta">${esc([it.year, it.format].filter(Boolean).join(' · ')) || esc(it.kind)}</p>
    </a>`;
}

function rowHtml(it) {
  return `
    <a class="item-row" href="#/item/${it.id}">
      <span class="row-cover">${coverHtml(it)}</span>
      <span class="row-main">
        <p class="row-title">${esc(it.title)}</p>
        <p class="row-creator">${esc(it.creator)}</p>
      </span>
      <span class="row-meta">${esc(it.year || '')}</span>
    </a>`;
}

function renderLibrary() {
  const list = visibleItems();
  const grid = $('#library-grid');
  const records = items.filter((i) => i.kind === 'record').length;
  const books = items.length - records;
  const filtered = !!(filterTag || filterKind !== 'all' || searchQuery);

  $('#library-empty').hidden = items.length > 0;
  $('#library-noresults').hidden = !(items.length > 0 && list.length === 0);
  $('.library-tools').hidden = items.length === 0;
  $('#library-count').textContent = items.length
    ? `${list.length} of ${items.length} · ${records} records · ${books} books`
    : '';

  const tags = [...new Set(items.flatMap((i) => i.tags || []))].sort();
  const tagRow = $('#tag-row');
  tagRow.hidden = tags.length === 0;
  tagRow.innerHTML = tags.map((t) =>
    `<button class="chip${t === filterTag ? ' is-active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`
  ).join('');

  $('#clear-filters').hidden = !filtered;
  $('#view-grid-btn').classList.toggle('is-active', viewMode === 'grid');
  $('#view-list-btn').classList.toggle('is-active', viewMode === 'list');

  grid.classList.toggle('is-list', viewMode === 'list');
  grid.innerHTML = list.map(viewMode === 'list' ? rowHtml : cardHtml).join('');
}

/* ---------------- scanning ---------------- */

async function beginScan() {
  const status = $('#scan-status');
  status.textContent = 'Starting camera…';
  try {
    stopScan = await startScanner($('#scan-video'), onBarcode);
    status.textContent = 'Line the barcode up in the frame.';
  } catch (err) {
    status.textContent = err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied — type the number below instead.'
      : (err.message || 'The camera is unavailable — type the number below instead.');
  }
}

async function onBarcode(code) {
  const status = $('#scan-status');
  status.textContent = `Found ${code} — looking it up…`;
  if (navigator.vibrate) navigator.vibrate(60);
  const found = await lookupBarcode(code);
  if (found) {
    openDraftFrom(found);
  } else {
    draft = newItem('record');
    draft.barcode = code.replace(/[^0-9Xx]/g, '');
    toast('No match in the databases — fill in the details yourself.');
    location.hash = '#/new';
  }
}

function openDraftFrom(found) {
  draft = Object.assign(newItem(found.kind), found);
  // A record picked from name-search doesn't have its tracklist yet.
  if (found.kind === 'record' && found.mbid && !(found.tracks || []).length) {
    const target = draft;
    fetchTracks(found.mbid).then((tracks) => {
      if (tracks && (draft === target || items.some((i) => i.id === target.id))) {
        target.tracks = tracks;
        if (items.some((i) => i.id === target.id)) putItem(target);
      }
    });
  }
  toast(`Found “${found.title}” — check the details, then save.`);
  location.hash = '#/new';
}

/* ---------------- online search ---------------- */

async function runOnlineSearch(ev) {
  ev.preventDefault();
  const q = $('#online-query').value.trim();
  if (!q) return;
  const status = $('#online-status');
  const listEl = $('#online-results');
  status.textContent = 'Searching…';
  listEl.innerHTML = '';
  const results = searchKind === 'book' ? await searchBooks(q) : await searchRecords(q);
  status.textContent = results.length
    ? `${results.length} matches — tap one to use it.`
    : 'No matches found. Try fewer words, or type it in yourself.';
  listEl.innerHTML = results.map((r, i) => `
    <li><button type="button" class="result-item" data-idx="${i}">
      ${coverHtml(r)}
      <span>
        <span class="result-title">${esc(r.title)}</span>
        <span class="result-sub">${esc([r.creator, r.year, r.format || r.publisher].filter(Boolean).join(' · '))}</span>
      </span>
    </button></li>`).join('');
  $$('#online-results .result-item').forEach((btn) => {
    btn.addEventListener('click', () => openDraftFrom(results[Number(btn.dataset.idx)]));
  });
}

/* ---------------- item form ---------------- */

function setFormKind(kind) {
  draft.kind = kind;
  $$('[data-formkind]').forEach((b) => b.classList.toggle('is-active', b.dataset.formkind === kind));
  $('#creator-label').textContent = kind === 'book' ? 'Author' : 'Artist';
  $('#publisher-label').textContent = kind === 'book' ? 'Publisher' : 'Label';
  $('#format-options').innerHTML = FORMAT_OPTIONS[kind]
    .map((f) => `<option value="${esc(f)}"></option>`).join('');
}

function renderForm() {
  const form = $('#item-form');
  const isEdit = items.some((i) => i.id === draft.id);
  $('#form-title').textContent = isEdit ? 'Edit item'
    : draft.title ? 'Check & save' : 'New item';
  setFormKind(draft.kind);
  for (const name of ['title', 'creator', 'year', 'format', 'publisher', 'genre', 'barcode', 'condition', 'notes']) {
    form.elements[name].value = draft[name] || '';
  }
  form.elements.tags.value = (draft.tags || []).join(', ');
  renderFormCover();
  if (!isEdit && !draft.title) form.elements.title.focus();
}

function renderFormCover() {
  $('#form-cover').innerHTML = coverHtml(draft);
  $('#cover-clear').hidden = !draft.coverBlob && !draft.coverUrl;
}

// Downscale a photo to a small JPEG blob so sync and backups stay light.
async function shrinkImage(file, maxSide = 900) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

async function fileToCover(file) {
  try {
    return await shrinkImage(file);
  } catch {
    return file; // keep the original if decoding fails
  }
}

async function onCoverPicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  draft.coverBlob = await fileToCover(file);
  draft.coverUrl = '';
  coverUrls.delete(draft.id);
  renderFormCover();
}

// "Take a photo" in the add sheet: the shutter IS the entry point — the
// photo becomes the new item's cover, then the form opens for details.
async function onPhotoPicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  closeSheet();
  draft = newItem('record');
  draft.coverBlob = await fileToCover(file);
  toast('Cover captured — now fill in the details.');
  location.hash = '#/new';
  if (views.form && !views.form.hidden) renderFormCover();
}

async function saveForm(ev) {
  ev.preventDefault();
  const form = $('#item-form');
  const title = form.elements.title.value.trim();
  if (!title) {
    form.elements.title.focus();
    toast('A title is all it needs — add one to save.');
    return;
  }
  for (const name of ['creator', 'year', 'format', 'publisher', 'genre', 'barcode', 'condition', 'notes']) {
    draft[name] = form.elements[name].value.trim();
  }
  draft.title = title;
  draft.tags = form.elements.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  draft.updatedAt = new Date().toISOString();
  await putItem(draft);
  const idx = items.findIndex((i) => i.id === draft.id);
  if (idx >= 0) items[idx] = draft; else items.push(draft);
  coverUrls.delete(draft.id);
  const saved = draft;
  draft = null;
  updateNavCount();
  toast(`“${saved.title}” is on the shelf.`);
  location.hash = `#/item/${saved.id}`;
  cacheRemoteCover(saved);
  scheduleSync();
}

// Pull a looked-up cover into the catalog itself, so the image survives
// offline, syncs, and travels with backups. Best effort — some cover hosts
// don't allow cross-origin reads, and the URL keeps working regardless.
async function cacheRemoteCover(item) {
  if (item.coverBlob || !item.coverUrl) return;
  try {
    const res = await fetch(item.coverUrl);
    if (!res.ok) return;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || !blob.size) return;
    const current = items.find((i) => i.id === item.id);
    if (!current || current.coverBlob || current.coverUrl !== item.coverUrl) return;
    current.coverBlob = blob;
    coverUrls.delete(current.id);
    await putItem(current);
    scheduleSync();
  } catch {
    // keep the remote URL only
  }
}

/* ---------------- detail ---------------- */

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderDetail(item) {
  const meta = [item.year, item.genre, item.format, item.condition].filter(Boolean);
  const rows = [
    [item.kind === 'book' ? 'Publisher' : 'Label', item.publisher],
    ['Barcode', item.barcode, 'mono'],
    ['Added', new Date(item.createdAt).toLocaleDateString()],
    ['Notes', item.notes],
  ].filter(([, v]) => v);

  const tracks = item.tracks || [];
  const totalMs = tracks.reduce((sum, t) => sum + (t.ms || 0), 0);
  const tracklist = tracks.length ? `
    <div class="detail-section-head">
      <h2>Tracklist</h2>
      ${totalMs ? `<span class="total-time">${fmtMs(totalMs)} total</span>` : ''}
    </div>
    <ol class="tracklist">
      ${tracks.map((t) => `<li>
        <span class="track-no">${esc(t.no)}</span>
        <span class="track-title">${esc(t.title)}</span>
        <span class="track-time">${t.ms ? fmtMs(t.ms) : ''}</span>
      </li>`).join('')}
    </ol>` : '';

  $('#detail-card').innerHTML = `
    <div class="detail-top">
      <div class="detail-cover">${coverHtml(item)}</div>
      <div>
        <span class="kind-badge">${item.kind}</span>
        <h1>${esc(item.title)}</h1>
        <p class="detail-creator">${esc(item.creator)}</p>
        ${meta.length ? `<div class="detail-meta">
          ${meta.map((m) => `<span class="meta-chip">${esc(m)}</span>`).join('')}</div>` : ''}
        <div class="detail-actions">
          <a class="btn btn-accent" href="#/edit/${item.id}">Edit</a>
          <button id="detail-delete" class="btn btn-danger" type="button">Remove</button>
        </div>
      </div>
    </div>
    ${tracklist}
    <dl class="detail-fields">
      ${rows.map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd></div>`).join('')}
      ${item.tags.length ? `<div><dt>Shelves</dt><dd class="tag-list">
        ${item.tags.map((t) => `<span class="meta-chip">${esc(t)}</span>`).join('')}</dd></div>` : ''}
    </dl>`;
  $('#detail-delete').onclick = async () => {
    if (!confirm(`Remove “${item.title}” from the catalog?`)) return;
    await deleteItem(item.id);
    recordTombstone(item.id);
    items = items.filter((i) => i.id !== item.id);
    coverUrls.delete(item.id);
    updateNavCount();
    toast('Removed.');
    location.hash = '#/library';
    scheduleSync();
  };
}

/* ---------------- sync ---------------- */

let syncUiState = { status: getSyncConfig() ? 'idle' : 'off', text: '' };
let syncDebounce = null;

function fmtSyncTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString();
}

function renderSyncIndicators() {
  const cfg = getSyncConfig();
  const last = lastSyncedAt();
  let dot = 'off';
  let text = 'Sync off';
  if (cfg) {
    if (syncUiState.status === 'syncing') { dot = ''; text = syncUiState.text || 'Syncing…'; }
    else if (syncUiState.status === 'error') { dot = 'err'; text = 'Sync issue'; }
    else { dot = ''; text = last ? `Synced ${fmtSyncTime(last)}` : 'Ready to sync'; }
  }
  const html = `<span class="sync-dot ${dot}"></span>${esc(text)}`;
  $('#top-sync').innerHTML = cfg ? html : '';
  const side = $('#side-sync');
  side.hidden = false;
  side.innerHTML = cfg ? html : `<span class="sync-dot off"></span>Sync off — <a href="#/settings">set up</a>`;
}

function scheduleSync() {
  if (!getSyncConfig()) return;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => runSync('auto'), 2500);
}

async function runSync(reason) {
  if (!getSyncConfig()) return;
  syncUiState = { status: 'syncing', text: 'Syncing…' };
  renderSyncIndicators();
  try {
    const result = await syncNow((text) => {
      syncUiState = { status: 'syncing', text };
      renderSyncIndicators();
    });
    syncUiState = { status: 'idle', text: '' };
    if (result && result.applied) {
      items = await getAllItems();
      coverUrls.clear();
      rerender();
    }
    renderSyncIndicators();
    if (currentView === 'settings') renderSettings();
    if (reason === 'manual') toast('Synced.');
  } catch (err) {
    syncUiState = { status: 'error', text: err.message || 'Sync failed' };
    renderSyncIndicators();
    if (currentView === 'settings') renderSettings();
    if (reason === 'manual') toast(err.message || 'Sync failed.');
  }
}

/* ---------------- settings ---------------- */

function renderSettings() {
  const cfg = getSyncConfig();
  const panel = $('#sync-panel');
  if (cfg) {
    const last = lastSyncedAt();
    panel.innerHTML = `
      <div class="sync-status-row">
        <span class="sync-repo">${esc(cfg.repo)}</span>
        <span class="sync-note">${syncUiState.status === 'error' ? esc(syncUiState.text)
          : syncUiState.status === 'syncing' ? 'Syncing…'
          : last ? `Last synced ${esc(fmtSyncTime(last))}` : 'Not synced yet'}</span>
      </div>
      <p class="sync-note">Syncs automatically when the app opens, after every change, and when you come back online. Set up the same repo and token on your other devices and they'll stay matching.</p>
      <div class="form-actions">
        <button id="sync-now" class="btn btn-accent" type="button">Sync now</button>
        <button id="sync-disconnect" class="btn btn-danger" type="button">Disconnect</button>
      </div>`;
    $('#sync-now').addEventListener('click', () => runSync('manual'));
    $('#sync-disconnect').addEventListener('click', () => {
      if (!confirm('Stop syncing on this device? Your catalog stays here and in the repo.')) return;
      setSyncConfig(null);
      syncUiState = { status: 'off', text: '' };
      renderSettings();
      renderSyncIndicators();
    });
  } else {
    panel.innerHTML = `
      <p class="aside-note">Your catalog syncs through a private GitHub repository you own — free, and the data stays yours. One-time setup on each device:</p>
      <ol class="setup-steps">
        <li>Create a <strong>private repo</strong> on GitHub, e.g. <code>stacks-data</code> (empty is fine).</li>
        <li>Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained access token</a>: choose <em>Only select repositories</em> → that repo, and under Repository permissions set <strong>Contents</strong> to <strong>Read and write</strong>.</li>
        <li>Paste both below. On your other device, install the app and paste the same two values.</li>
      </ol>
      <label class="field">
        <span class="field-label">Repository <em>owner/name</em></span>
        <input id="sync-repo-input" type="text" autocomplete="off" placeholder="yourname/stacks-data">
      </label>
      <label class="field">
        <span class="field-label">Access token</span>
        <input id="sync-token-input" type="password" autocomplete="off" placeholder="github_pat_…">
      </label>
      <div class="form-actions">
        <button id="sync-connect" class="btn btn-accent" type="button">Connect &amp; sync</button>
      </div>
      <p class="sync-note">The token is stored only in this browser and sent only to api.github.com.</p>`;
    $('#sync-connect').addEventListener('click', async () => {
      const repo = $('#sync-repo-input').value.trim().replace(/^https:\/\/github\.com\//, '');
      const token = $('#sync-token-input').value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Repository should look like owner/name.'); return; }
      if (!token) { toast('Paste the access token.'); return; }
      setSyncConfig({ repo, token });
      renderSettings();
      renderSyncIndicators();
      await runSync('manual');
    });
  }

  const records = items.filter((i) => i.kind === 'record').length;
  $('#backup-stats').innerHTML = `
    <span>${records} records</span><span>${items.length - records} books</span>
    <span>${[...new Set(items.flatMap((i) => i.tags))].length} shelves</span>`;
}

/* ---------------- backup ---------------- */

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function exportJson() {
  const out = [];
  for (const it of items) {
    const { coverBlob, ...rest } = it;
    out.push({ ...rest, coverData: coverBlob ? await blobToDataUrl(coverBlob) : null });
  }
  const payload = { app: 'stacks', version: 1, exportedAt: new Date().toISOString(), items: out };
  const stamp = new Date().toISOString().slice(0, 10);
  download(`stacks-backup-${stamp}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  toast(`Backed up ${out.length} items.`);
}

function exportCsv() {
  const cols = ['kind', 'title', 'creator', 'year', 'format', 'publisher', 'genre', 'condition', 'barcode', 'tags', 'notes', 'createdAt'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const it of items) {
    lines.push(cols.map((c) => cell(c === 'tags' ? it.tags.join('; ') : it[c])).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  download(`stacks-catalog-${stamp}.csv`, new Blob([lines.join('\r\n')], { type: 'text/csv' }));
}

async function importJson(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !Array.isArray(payload.items)) throw new Error('bad file');
    let added = 0;
    let updated = 0;
    for (const raw of payload.items) {
      if (!raw.id || !raw.title) continue;
      const { coverData, ...rest } = raw;
      const item = Object.assign(newItem(rest.kind === 'book' ? 'book' : 'record'), rest);
      item.tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
      item.tracks = Array.isArray(item.tracks) ? item.tracks : [];
      if (coverData && coverData.startsWith('data:')) {
        item.coverBlob = await (await fetch(coverData)).blob();
      }
      const existing = items.findIndex((i) => i.id === item.id);
      if (existing >= 0) { items[existing] = item; updated++; } else { items.push(item); added++; }
      coverUrls.delete(item.id);
      await putItem(item);
    }
    updateNavCount();
    toast(`Restored ${added} new item${added === 1 ? '' : 's'}${updated ? `, updated ${updated}` : ''}.`);
    renderSettings();
    scheduleSync();
  } catch {
    toast("That file doesn't look like a Stacks backup.");
  }
}

/* ---------------- wire up ---------------- */

function bindEvents() {
  window.addEventListener('hashchange', route);

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-sheet]')) { openSheet(); return; }
    if (e.target.closest('[data-close-sheet]')) closeSheet();
  });
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  $('#search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderLibrary();
  });
  $('#sort-select').addEventListener('change', (e) => {
    sortBy = e.target.value;
    renderLibrary();
  });
  $$('.kind-chip[data-kind]').forEach((b) => b.addEventListener('click', () => {
    filterKind = b.dataset.kind;
    $$('.kind-chip[data-kind]').forEach((x) => x.classList.toggle('is-active', x === b));
    renderLibrary();
  }));
  $('#tag-row').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tag]');
    if (!btn) return;
    filterTag = filterTag === btn.dataset.tag ? null : btn.dataset.tag;
    renderLibrary();
  });
  $('#clear-filters').addEventListener('click', () => {
    filterKind = 'all';
    filterTag = null;
    searchQuery = '';
    $('#search-input').value = '';
    $$('.kind-chip[data-kind]').forEach((x) => x.classList.toggle('is-active', x.dataset.kind === 'all'));
    renderLibrary();
  });
  $('#view-grid-btn').addEventListener('click', () => setViewMode('grid'));
  $('#view-list-btn').addEventListener('click', () => setViewMode('list'));

  $('#scan-manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#scan-code').value.trim();
    if (code) onBarcode(code);
  });

  $('#online-form').addEventListener('submit', runOnlineSearch);
  $$('[data-searchkind]').forEach((b) => b.addEventListener('click', () => {
    searchKind = b.dataset.searchkind;
    $$('[data-searchkind]').forEach((x) => x.classList.toggle('is-active', x === b));
  }));

  $$('[data-formkind]').forEach((b) => b.addEventListener('click', () => setFormKind(b.dataset.formkind)));
  $('#item-form').addEventListener('submit', saveForm);
  $('#form-cancel').addEventListener('click', () => { draft = null; history.back(); });
  $('#cover-file').addEventListener('change', onCoverPicked);
  $('#photo-file').addEventListener('change', onPhotoPicked);
  $('#cover-clear').addEventListener('click', () => {
    draft.coverBlob = null;
    draft.coverUrl = '';
    coverUrls.delete(draft.id);
    renderFormCover();
  });
  $('#detail-back').addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/library';
  });

  $('#export-json').addEventListener('click', exportJson);
  $('#export-csv').addEventListener('click', exportCsv);
  $('#import-file').addEventListener('change', importJson);

  window.addEventListener('online', () => runSync('auto'));
}

function setViewMode(mode) {
  viewMode = mode;
  try { localStorage.setItem('stacks-view', mode); } catch {}
  renderLibrary();
}

async function main() {
  items = await getAllItems();
  bindEvents();
  updateNavCount();
  renderSyncIndicators();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (getSyncConfig() && navigator.onLine !== false) runSync('startup');
}

main();
