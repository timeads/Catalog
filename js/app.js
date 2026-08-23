import { getAllItems, putItem, deleteItem, newItem } from './db.js';
import { lookupBarcode, searchBooks, searchRecords } from './lookup.js';
import { startScanner } from './scanner.js';

/* ---------------- state ---------------- */

let items = [];
let filterKind = 'all';
let filterTag = null;
let searchQuery = '';
let sortBy = 'added';
let searchKind = 'record'; // online-search toggle
let draft = null; // item being created/edited in the form
let stopScan = null; // active scanner's stop()
const coverUrls = new Map(); // item id -> object URL for its cover blob

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const FORMAT_OPTIONS = {
  record: ['LP', '2×LP', 'EP', '7" single', '10"', '12" single', '78 rpm', 'Box set', 'Cassette', 'CD'],
  book: ['Hardcover', 'Paperback', 'Trade paperback', 'Mass market', 'Oversize', 'Boxed set', 'Zine', 'Signed'],
};

// Placeholder cover tones: muted, archival — like cloth bindings and
// paper record sleeves. [background, initial] pairs.
const PLACEHOLDER_TONES = [
  ['#2d2d2a', '#e5e2dd'],
  ['#775a19', '#ffdea5'],
  ['#474741', '#e5e2de'],
  ['#8c7a5b', '#fcf9f5'],
  ['#5c5c56', '#f3f0ec'],
  ['#3d3a33', '#e9c176'],
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
  library: $('#view-library'),
  add: $('#view-add'),
  scan: $('#view-scan'),
  search: $('#view-search'),
  form: $('#view-form'),
  detail: $('#view-detail'),
  backup: $('#view-backup'),
};

function route() {
  const hash = location.hash || '#/';
  const [, path, arg] = hash.match(/^#\/([a-z]*)\/?(.*)$/) || [null, '', ''];

  if (stopScan) { stopScan(); stopScan = null; }
  Object.values(views).forEach((v) => { v.hidden = true; });

  let view = 'library';
  if (path === 'add') view = 'add';
  else if (path === 'scan') view = 'scan';
  else if (path === 'search') view = 'search';
  else if (path === 'new') view = 'form';
  else if (path === 'edit') view = 'form';
  else if (path === 'item') view = 'detail';
  else if (path === 'backup') view = 'backup';

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
  if (view === 'library') renderLibrary();
  if (view === 'scan') beginScan();
  if (view === 'backup') renderBackup();
  if (view !== 'form' && view !== 'scan') draft = null;

  views[view].hidden = false;
  const tab = view === 'library' || view === 'detail' ? 'library'
    : view === 'backup' ? 'backup' : 'add';
  $$('.tabbar a').forEach((a) => a.classList.toggle('is-active', a.dataset.tab === tab));
  window.scrollTo(0, 0);
}

/* ---------------- library ---------------- */

function visibleItems() {
  const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  let list = items.filter((it) => {
    if (filterKind !== 'all' && it.kind !== filterKind) return false;
    if (filterTag && !it.tags.includes(filterTag)) return false;
    if (terms.length) {
      const hay = [it.title, it.creator, it.publisher, it.genre, it.year,
        it.format, it.notes, it.barcode, ...(it.tags || [])].join(' ').toLowerCase();
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

function renderLibrary() {
  const list = visibleItems();
  const grid = $('#library-grid');
  const records = items.filter((i) => i.kind === 'record').length;
  const books = items.length - records;

  $('#library-empty').hidden = items.length > 0;
  $('.library-tools').hidden = items.length === 0;
  $('#library-count').textContent = items.length
    ? `${list.length} of ${items.length} — ${records} records · ${books} books`
    : '';

  const tags = [...new Set(items.flatMap((i) => i.tags || []))].sort();
  const tagRow = $('#tag-row');
  tagRow.hidden = tags.length === 0;
  tagRow.innerHTML = tags.map((t) =>
    `<button class="chip${t === filterTag ? ' is-active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`
  ).join('');

  grid.innerHTML = list.map((it) => `
    <a class="item-card" href="#/item/${it.id}">
      <span class="cover-wrap">${coverHtml(it)}</span>
      <span class="card-text">
        <h2 class="card-title">${esc(it.title)}</h2>
        <p class="card-creator">${esc(it.creator)}</p>
        <p class="card-meta">${esc([it.year, it.format].filter(Boolean).join(' · ')) || esc(it.kind)}</p>
      </span>
    </a>`).join('');
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
    : draft.title ? 'Check & save' : 'Type it in';
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

// Downscale a photo to a small JPEG blob so backups stay portable.
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

async function onCoverPicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    draft.coverBlob = await shrinkImage(file);
  } catch {
    draft.coverBlob = file; // keep the original if decoding fails
  }
  draft.coverUrl = '';
  coverUrls.delete(draft.id);
  renderFormCover();
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
  toast(`“${saved.title}” is on the shelf.`);
  location.hash = '#/';
}

/* ---------------- detail ---------------- */

function renderDetail(item) {
  const meta = [item.year, item.genre, item.format].filter(Boolean);
  const rows = [
    [item.kind === 'book' ? 'Publisher' : 'Label', item.publisher],
    ['Condition', item.condition],
    ['Barcode', item.barcode, 'mono'],
    ['Added', new Date(item.createdAt).toLocaleDateString()],
    ['Notes', item.notes],
  ].filter(([, v]) => v);

  $('#detail-card').innerHTML = `
    <div class="detail-cover">${coverHtml(item)}</div>
    <span class="kind-badge archival-label">${item.kind}</span>
    <h1>${esc(item.title)}</h1>
    <p class="detail-creator">${esc(item.creator)}</p>
    ${meta.length ? `<div class="detail-meta">
      ${meta.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>` : ''}
    <dl class="detail-fields">
      ${rows.map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd></div>`).join('')}
      ${item.tags.length ? `<div><dt>Shelves</dt><dd class="tag-list">
        ${item.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</dd></div>` : ''}
    </dl>`;
  $('#detail-edit').href = `#/edit/${item.id}`;
  $('#detail-delete').onclick = async () => {
    if (!confirm(`Remove “${item.title}” from the catalog?`)) return;
    await deleteItem(item.id);
    items = items.filter((i) => i.id !== item.id);
    coverUrls.delete(item.id);
    toast('Removed.');
    location.hash = '#/';
  };
}

/* ---------------- backup ---------------- */

function renderBackup() {
  const records = items.filter((i) => i.kind === 'record').length;
  $('#backup-stats').innerHTML = `
    <div><span class="stat-num">${records}</span><span class="stat-label">records</span></div>
    <div><span class="stat-num">${items.length - records}</span><span class="stat-label">books</span></div>
    <div><span class="stat-num">${[...new Set(items.flatMap((i) => i.tags))].length}</span><span class="stat-label">shelves</span></div>`;
}

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
      if (coverData && coverData.startsWith('data:')) {
        item.coverBlob = await (await fetch(coverData)).blob();
      }
      const existing = items.findIndex((i) => i.id === item.id);
      if (existing >= 0) { items[existing] = item; updated++; } else { items.push(item); added++; }
      coverUrls.delete(item.id);
      await putItem(item);
    }
    toast(`Restored ${added} new item${added === 1 ? '' : 's'}${updated ? `, updated ${updated}` : ''}.`);
    renderBackup();
  } catch {
    toast("That file doesn't look like a Stacks backup.");
  }
}

/* ---------------- wire up ---------------- */

function bindEvents() {
  window.addEventListener('hashchange', route);

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
  $('#cover-clear').addEventListener('click', () => {
    draft.coverBlob = null;
    draft.coverUrl = '';
    coverUrls.delete(draft.id);
    renderFormCover();
  });

  $('#export-json').addEventListener('click', exportJson);
  $('#export-csv').addEventListener('click', exportCsv);
  $('#import-file').addEventListener('change', importJson);
}

async function main() {
  items = await getAllItems();
  bindEvents();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
