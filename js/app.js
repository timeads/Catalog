import { getAllItems, putItem, deleteItem, newItem, newPhoto, migrateItem } from './db.js';
import { lookupBarcode, searchBooks, searchRecords, fetchReleaseDetails, fetchBookDescription, findArchivePhotos } from './lookup.js';
import { getVisionKey, setVisionKey, identifyPhoto, enrichItem } from './identify.js';
import { startScanner } from './scanner.js';
import { getSyncConfig, setSyncConfig, lastSyncedAt, recordTombstone, syncNow } from './sync.js';
import { getDiscogsToken, setDiscogsToken, parseValue, fmtMoney, marketLinks, discogsStats } from './value.js';
import {
  isLockEnabled, unlock, enableLock, disableLock, changePassphrase,
  tryRestoreSession, resealIfLocked, resetDevice,
} from './lock.js';
import { getBookcases, saveBookcases, newBookcase, locationLabel, getBookcasesBundle, adoptBookcasesBundle } from './locations.js';

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
let detailSelectedPhoto = null; // photo id highlighted on the detail page
const photoUrls = new Map(); // photo id (or item id, legacy) -> object URL

let pendingReload = false; // a new app version is ready; apply when safe
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

function photoSrc(photo) {
  if (photo.blob) {
    if (!photoUrls.has(photo.id)) photoUrls.set(photo.id, URL.createObjectURL(photo.blob));
    return photoUrls.get(photo.id);
  }
  return photo.url || '';
}

function coverSrc(item) {
  const p = (item.photos || [])[0];
  if (p) return photoSrc(p);
  // Legacy items not yet migrated
  if (item.coverBlob) {
    if (!photoUrls.has(item.id)) photoUrls.set(item.id, URL.createObjectURL(item.coverBlob));
    return photoUrls.get(item.id);
  }
  return item.coverUrl || '';
}

function dropItemUrls(item) {
  for (const p of item.photos || []) {
    const u = photoUrls.get(p.id);
    if (u) { URL.revokeObjectURL(u); photoUrls.delete(p.id); }
  }
  const u = photoUrls.get(item.id);
  if (u) { URL.revokeObjectURL(u); photoUrls.delete(item.id); }
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
  closeMiniScanner();
  stopPreview();
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
    if (route.lastDetailId !== arg) { detailSelectedPhoto = null; route.lastDetailId = arg; }
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

  // A new app version that arrived mid-session applies on the next
  // navigation, so it never interrupts typing or scanning.
  if (pendingReload && view !== 'form' && view !== 'scan') {
    location.reload();
    return;
  }

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
  const total = items.reduce((sum, i) => sum + parseValue(i.value), 0);
  $('#stat-value-card').hidden = total <= 0;
  if (total > 0) $('#stat-value').textContent = fmtMoney(total);

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
        it.format, it.notes, it.summary, it.barcode, locationLabel(it),
        ...(it.tags || [])].join(' '));
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
  if (!(draft.photos || []).length && found.coverUrl) {
    draft.photos = [newPhoto({ url: found.coverUrl, label: 'Front' })];
  }
  migrateItem(draft);
  // A record picked from name-search doesn't have its tracklist yet.
  if (found.kind === 'record' && found.mbid && !(found.tracks || []).length) {
    const target = draft;
    fetchReleaseDetails(found.mbid).then((details) => {
      if (!details) return;
      if (draft === target || items.some((i) => i.id === target.id)) {
        if (details.tracks) target.tracks = details.tracks;
        if (details.genre && !target.genre) {
          target.genre = details.genre;
          if (draft === target && !views.form.hidden && !$('#item-form').elements.genre.value.trim()) {
            $('#item-form').elements.genre.value = details.genre;
          }
        }
        if (items.some((i) => i.id === target.id)) putItem(target);
      }
    });
  }
  // A book picked from name-search doesn't have its blurb yet.
  if (found.kind === 'book' && found.barcode && !found.summary) {
    const target = draft;
    fetchBookDescription(found.barcode.replace(/[^0-9Xx]/g, '')).then((summary) => {
      if (summary && !target.summary) {
        target.summary = summary;
        if (draft === target && !views.form.hidden && !$('#item-form').elements.summary.value.trim()) {
          $('#item-form').elements.summary.value = summary;
        }
        if (items.some((i) => i.id === target.id)) putItem(target);
      }
    });
  }
  maybeEnrichDraft(draft);
  toast(`Found “${found.title}” — check the details, then save.`);
  location.hash = '#/new';
}

// Fill in genre and a short summary from Claude when the databases
// didn't provide them. Only ever fills blanks — never overwrites what
// the databases found or the user typed.
async function maybeEnrichDraft(target) {
  const key = getVisionKey();
  // A stub blurb on a book ("First edition.") still deserves a real About.
  const summaryOk = target.summary && !(target.kind === 'book' && target.summary.length < 60);
  if (!key || !target.title || (target.genre && summaryOk)) return;
  let extra = null;
  try { extra = await enrichItem(target, key); } catch { return; }
  if (!extra) return;
  const live = draft === target && !views.form.hidden;
  const form = $('#item-form');
  if (extra.genre && !target.genre) {
    target.genre = extra.genre;
    if (live && !form.elements.genre.value.trim()) form.elements.genre.value = extra.genre;
  }
  if (extra.summary && !summaryOk) {
    const oldStub = target.summary;
    target.summary = extra.summary;
    if (live) {
      const current = form.elements.summary.value.trim();
      if (!current || current === oldStub) form.elements.summary.value = extra.summary;
    }
  }
  // If it was saved before the answer arrived, update the stored item too.
  if (items.some((i) => i.id === target.id)) {
    migrateItem(target);
    await putItem(target);
    if (currentView === 'detail') rerender();
    scheduleSync();
  }
}

/* ---------------- inline barcode capture (form) ---------------- */

let stopMiniScan = null;

async function openMiniScanner() {
  $('#mini-scan').hidden = false;
  const status = $('#mini-scan-status');
  status.textContent = 'Starting camera…';
  try {
    stopMiniScan = await startScanner($('#mini-scan-video'), (code) => {
      const digits = code.replace(/[^0-9Xx]/g, '');
      $('#item-form').elements.barcode.value = digits;
      if (draft) draft.barcode = digits;
      if (navigator.vibrate) navigator.vibrate(60);
      closeMiniScanner();
      toast(`Barcode ${digits} captured.`);
    });
    status.textContent = 'Line the barcode up in the frame.';
  } catch (err) {
    status.textContent = err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied — type the number into the field instead.'
      : 'The camera is unavailable — type the number into the field instead.';
  }
}

function closeMiniScanner() {
  if (stopMiniScan) { stopMiniScan(); stopMiniScan = null; }
  $('#mini-scan').hidden = true;
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
  for (const name of ['title', 'creator', 'year', 'format', 'publisher', 'genre', 'barcode', 'condition', 'summary', 'notes', 'value', 'pages']) {
    form.elements[name].value = draft[name] || '';
  }
  form.elements.tags.value = (draft.tags || []).join(', ');
  renderLocationSelects(draft.bookcaseId, draft.shelf);
  renderFormCover();
  if (!isEdit && !draft.title) form.elements.title.focus();
}

// Bookcase + shelf selects: shelf options follow the chosen bookcase.
function renderLocationSelects(bookcaseId, shelf) {
  const cases = getBookcases();
  const bcSel = $('#form-bookcase');
  bcSel.innerHTML = `<option value="">—</option>${cases.map((b) =>
    `<option value="${esc(b.id)}"${b.id === bookcaseId ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}`;
  if (!cases.length) {
    bcSel.innerHTML = '<option value="">Add bookcases in Settings</option>';
  }
  renderShelfSelect(shelf);
}

function renderShelfSelect(shelf) {
  const cases = getBookcases();
  const bc = cases.find((b) => b.id === $('#form-bookcase').value);
  const shelfSel = $('#form-shelf');
  if (!bc) {
    shelfSel.innerHTML = '<option value="">—</option>';
    shelfSel.disabled = true;
    return;
  }
  shelfSel.disabled = false;
  const options = ['<option value="">—</option>'];
  for (let i = 1; i <= bc.shelves; i++) {
    options.push(`<option value="${i}"${String(i) === String(shelf) ? ' selected' : ''}>Shelf ${i}</option>`);
  }
  shelfSel.innerHTML = options.join('');
}

function renderFormCover() {
  $('#form-cover').innerHTML = coverHtml(draft);
  $('#cover-clear').hidden = !(draft.photos || []).length;
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
  // The photo of your copy becomes the cover; a looked-up image stays in
  // the gallery behind it.
  draft.photos.unshift(newPhoto({ blob: await fileToCover(file) }));
  migrateItem(draft);
  renderFormCover();
}

// "Take a photo" in the add sheet: the shutter IS the entry point — the
// photo becomes the new item's cover. With a Claude API key configured,
// the photo is identified and everything fills in automatically.
async function onPhotoPicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  closeSheet();
  draft = newItem('record');
  draft.photos = [newPhoto({ blob: await fileToCover(file) })];
  migrateItem(draft);
  location.hash = '#/new';
  if (views.form && !views.form.hidden) renderFormCover();
  if (getVisionKey()) {
    identifyAndFill(draft);
  } else {
    toast('Cover captured — now fill in the details.');
  }
}

// The auto-identification pipeline: Claude names the item from the photo,
// then the open databases fill in the rest — metadata, tracklist, and the
// archive's front/back images for records.
async function identifyAndFill(target) {
  const setStatus = (text) => {
    if (draft === target && !views.form.hidden) $('#form-title').textContent = text;
  };
  setStatus('Identifying photo…');
  let id = null;
  try {
    id = await identifyPhoto(target.photos[0].blob, getVisionKey());
  } catch (err) {
    setStatus('New item');
    toast(err.message || 'Identification failed — fill in the details yourself.');
    return;
  }
  if (!id || !id.title) {
    setStatus('New item');
    toast("Couldn't identify the cover — fill in the details yourself.");
    return;
  }
  // Abandon silently if the user already started typing or moved on.
  if (draft !== target || $('#item-form').elements.title.value.trim()) return;

  target.kind = id.kind || target.kind;
  target.title = id.title;
  target.creator = id.creator;
  target.year = id.year;
  target.genre = id.genre || '';
  target.summary = id.summary || '';
  setStatus('Fetching details…');

  // Confirm against the open databases and pull the rich details.
  try {
    const q = [id.creator, id.title].filter(Boolean).join(' ');
    const results = target.kind === 'book' ? await searchBooks(q) : await searchRecords(q);
    const best = results[0];
    if (best && fold(best.title).includes(fold(id.title).slice(0, 12))) {
      for (const f of ['title', 'creator', 'year', 'format', 'publisher', 'mbid']) {
        if (best[f]) target[f] = best[f];
      }
      if (best.genre && !target.genre) target.genre = best.genre;
      if (target.kind === 'record' && target.mbid) {
        const details = await fetchReleaseDetails(target.mbid);
        target.tracks = (details && details.tracks) || [];
        if (details && details.genre && !target.genre) target.genre = details.genre;
        // Bring in the archive's images — front and back of the sleeve.
        const images = await findArchivePhotos(target).catch(() => []);
        for (const img of images) {
          const label = fold(img.label);
          if (label.includes('front') || label.includes('back')) {
            target.photos.push(newPhoto({ url: img.url, label: img.label }));
          }
        }
      } else if (best.coverUrl) {
        target.photos.push(newPhoto({ url: best.coverUrl, label: 'Cover' }));
      }
    }
  } catch {
    // identification alone is still worth prefilling
  }

  if (draft === target && !views.form.hidden && !$('#item-form').elements.title.value.trim()) {
    renderForm();
    $('#form-title').textContent = 'Check & save';
    const extras = target.photos.length - 1;
    toast(`Identified “${target.title}”${id.confidence !== 'high' ? ' (best guess)' : ''}${extras > 0 ? ` — added ${extras} archive image${extras === 1 ? '' : 's'}` : ''}. Check the details, then save.`);
  }
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
  for (const name of ['creator', 'year', 'format', 'publisher', 'genre', 'barcode', 'condition', 'summary', 'notes', 'pages']) {
    draft[name] = form.elements[name].value.trim();
  }
  draft.bookcaseId = form.elements.bookcaseId.value;
  draft.shelf = draft.bookcaseId ? form.elements.shelf.value : '';
  const newValue = form.elements.value.value.trim();
  if (newValue !== (draft.value || '')) {
    draft.valueDate = newValue ? new Date().toISOString() : '';
  }
  draft.value = newValue;
  draft.title = title;
  draft.tags = form.elements.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
  draft.updatedAt = new Date().toISOString();
  migrateItem(draft);
  await putItem(draft);
  const idx = items.findIndex((i) => i.id === draft.id);
  if (idx >= 0) items[idx] = draft; else items.push(draft);
  const saved = draft;
  draft = null;
  updateNavCount();
  toast(`“${saved.title}” is on the shelf.`);
  location.hash = `#/item/${saved.id}`;
  cachePhotoBlobs(saved);
  maybeEnrichDraft(saved);
  scheduleSync();
}

// Pull remote photo images into the catalog itself, so they survive
// offline, sync as files, and travel with backups. Best effort — some
// cover hosts don't allow cross-origin reads, and the URL keeps working.
async function cachePhotoBlobs(item) {
  let changed = false;
  for (const photo of item.photos || []) {
    if (photo.blob || !photo.url) continue;
    try {
      const res = await fetch(photo.url);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob.type.startsWith('image/') || !blob.size) continue;
      photo.blob = blob;
      photoUrls.delete(photo.id);
      changed = true;
    } catch {
      // keep the remote URL only
    }
  }
  if (changed && items.some((i) => i.id === item.id)) {
    migrateItem(item);
    await putItem(item);
    if (currentView === 'detail') rerender();
    scheduleSync();
  }
}

/* ---------------- track previews ---------------- */

// 30-second previews from the iTunes Search API — keyless and reachable
// from the browser. Previews are of the digital release, so pre-digital
// rarities often have none; the row says so instead of failing silently.

const previewCache = new Map(); // folded "artist|title" -> url or null
let previewAudio = null;
let previewKey = '';

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = `itunes_cb_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('load failed')); };
    script.src = `${url}&callback=${cb}`;
    document.head.appendChild(script);
  });
}

async function findPreviewUrl(artist, title) {
  const key = fold(`${artist}|${title}`);
  if (previewCache.has(key)) return previewCache.get(key);
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&media=music&entity=song&limit=5`;
  let data = null;
  try {
    const res = await fetch(url);
    if (res.ok) data = await res.json();
  } catch { /* CORS or offline — try JSONP below */ }
  if (!data) {
    try { data = await jsonp(url); } catch { data = null; }
  }
  const results = (data && data.results) || [];
  const wanted = fold(title).slice(0, 12);
  const hit = results.find((r) => fold(r.trackName || '').includes(wanted)) || results[0];
  const preview = (hit && hit.previewUrl) || null;
  previewCache.set(key, preview);
  return preview;
}

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  previewKey = '';
  $$('.track-play.is-playing').forEach((b) => b.classList.remove('is-playing'));
}

async function togglePreview(item, track, btn) {
  const key = `${item.id}|${track.no}`;
  if (previewKey === key) { stopPreview(); return; }
  stopPreview();
  btn.classList.add('is-loading');
  const url = await findPreviewUrl(item.creator, track.title);
  btn.classList.remove('is-loading');
  if (!url) {
    toast(`No preview available for “${track.title}”.`);
    return;
  }
  previewAudio = new Audio(url);
  previewKey = key;
  btn.classList.add('is-playing');
  previewAudio.onended = stopPreview;
  previewAudio.onerror = () => { stopPreview(); toast("The preview couldn't be played."); };
  previewAudio.play().catch(() => { stopPreview(); toast("The preview couldn't be played."); });
}

/* ---------------- detail ---------------- */

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Persist an in-place change to an item made from the detail page.
async function saveItemMutation(item) {
  item.updatedAt = new Date().toISOString();
  migrateItem(item);
  await putItem(item);
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) items[idx] = item;
  renderDetail(item);
  scheduleSync();
}

function photoImgHtml(photo, item) {
  const src = photoSrc(photo);
  if (!src) return placeholderHtml(item);
  return `<img src="${esc(src)}" alt="" loading="lazy"
    onerror="this.hidden=true;this.nextElementSibling.hidden=false">${placeholderHtml(item, true)}`;
}

function renderDetail(item) {
  const meta = [item.year, item.genre, item.format, item.condition].filter(Boolean);
  const rows = [
    ['Location', locationLabel(item)],
    [item.kind === 'book' ? 'Publisher' : 'Label', item.publisher],
    ['Pages', item.pages],
    ['Barcode', item.barcode, 'mono'],
    ['Added', new Date(item.createdAt).toLocaleDateString()],
    ['Notes', item.notes],
  ].filter(([, v]) => v);

  const photos = item.photos || [];
  const shown = photos.find((p) => p.id === detailSelectedPhoto) || photos[0] || null;
  const canFindArchive = !!(item.barcode || item.mbid);

  const tracks = item.tracks || [];
  const totalMs = tracks.reduce((sum, t) => sum + (t.ms || 0), 0);
  const tracklist = tracks.length ? `
    <div class="detail-section-head">
      <h2>Tracklist</h2>
      ${totalMs ? `<span class="total-time">${fmtMs(totalMs)} total</span>` : ''}
    </div>
    <ol class="tracklist has-previews">
      ${tracks.map((t, i) => `<li>
        <button class="track-play" type="button" data-track="${i}" title="Play a 30-second preview" aria-label="Play preview of ${esc(t.title)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="glyph-play" d="M8 5.5v13l11-6.5z"/><path class="glyph-stop" d="M7 7h10v10H7z"/></svg>
        </button>
        <span class="track-no">${esc(t.no)}</span>
        <span class="track-title">${esc(t.title)}</span>
        <span class="track-time">${t.ms ? fmtMs(t.ms) : ''}</span>
      </li>`).join('')}
    </ol>` : '';

  const photoSection = `
    <div class="detail-section-head">
      <h2>Photos</h2>
      ${canFindArchive ? '<button id="find-archive" class="section-link linkish" type="button">Find in the archives</button>' : ''}
    </div>
    <div class="photo-strip">
      ${photos.map((p, i) => `
        <button class="photo-thumb${p === shown ? ' is-selected' : ''}" type="button" data-photo="${p.id}">
          ${photoImgHtml(p, item)}
          ${i === 0 ? '<span class="thumb-flag">Cover</span>' : ''}
          ${p.label && i !== 0 ? `<span class="thumb-flag quiet">${esc(p.label)}</span>` : ''}
        </button>`).join('')}
      <label class="photo-add" for="detail-photo-camera" title="Take a photo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3l-1.5 2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.5L15 3H9zm3 5.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
      </label>
      <label class="photo-add" for="detail-photo-file" title="Add from library">＋</label>
    </div>
    ${shown && photos.length > 1 ? `
      <div class="photo-actions">
        ${photos[0] !== shown ? '<button id="photo-default" class="btn btn-quiet" type="button">Make this the cover</button>' : ''}
        <button id="photo-remove" class="btn btn-danger" type="button">Remove photo</button>
      </div>` : shown ? `
      <div class="photo-actions">
        <button id="photo-remove" class="btn btn-danger" type="button">Remove photo</button>
      </div>` : ''}
    <p id="archive-status" class="scan-status" hidden></p>
    <div id="archive-results" class="archive-grid" hidden></div>`;

  const estValue = parseValue(item.value);
  const valueSection = `
    <div class="detail-section-head">
      <h2>Value</h2>
      ${estValue > 0 ? `<span class="total-time">${fmtMoney(estValue)}${item.valueDate
        ? ` · as of ${new Date(item.valueDate).toLocaleDateString()}` : ''}</span>` : ''}
    </div>
    <div class="value-panel">
      ${item.kind === 'record' ? '<p id="discogs-price" class="value-live"></p>' : ''}
      <div class="market-links">
        ${marketLinks(item).map((l) =>
          `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}
      </div>
      <p class="aside-note">${estValue > 0
        ? 'Check the markets now and then and update the estimate in Edit.'
        : 'Check the markets, then record an estimated value in Edit — the Home screen totals it across the collection.'}</p>
    </div>`;

  $('#detail-card').innerHTML = `
    <div class="detail-top">
      <div class="detail-cover">${shown ? photoImgHtml(shown, item) : placeholderHtml(item)}</div>
      <div>
        <span class="kind-badge">${item.kind}</span>
        <h1>${esc(item.title)}</h1>
        <p class="detail-creator">${esc(item.creator)}</p>
        ${meta.length ? `<div class="detail-meta">
          ${meta.map((m) => `<span class="meta-chip">${esc(m)}</span>`).join('')}</div>` : ''}
        ${item.summary ? `<p class="detail-summary">${esc(item.summary)}</p>` : ''}
        <div class="detail-actions">
          <a class="btn btn-accent" href="#/edit/${item.id}">Edit</a>
          <button id="detail-delete" class="btn btn-danger" type="button">Remove</button>
        </div>
      </div>
    </div>
    ${photoSection}
    ${valueSection}
    ${tracklist}
    <dl class="detail-fields">
      ${rows.map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd></div>`).join('')}
      ${item.tags.length ? `<div><dt>Shelves</dt><dd class="tag-list">
        ${item.tags.map((t) => `<span class="meta-chip">${esc(t)}</span>`).join('')}</dd></div>` : ''}
    </dl>`;

  bindDetailPhotoEvents(item, shown);
  if (item.kind === 'record') renderDiscogsPrice(item);
  $$('#detail-card .track-play').forEach((btn) => {
    btn.addEventListener('click', () => togglePreview(item, tracks[Number(btn.dataset.track)], btn));
  });

  $('#detail-delete').onclick = async () => {
    if (!confirm(`Remove “${item.title}” from the catalog?`)) return;
    await deleteItem(item.id);
    recordTombstone(item.id);
    items = items.filter((i) => i.id !== item.id);
    dropItemUrls(item);
    updateNavCount();
    toast('Removed.');
    location.hash = '#/library';
    scheduleSync();
  };
}

function bindDetailPhotoEvents(item, shown) {
  $$('#detail-card .photo-thumb').forEach((btn) => {
    btn.addEventListener('click', () => {
      detailSelectedPhoto = btn.dataset.photo;
      renderDetail(item);
    });
  });

  const makeDefault = $('#photo-default');
  if (makeDefault) {
    makeDefault.addEventListener('click', async () => {
      item.photos = [shown, ...item.photos.filter((p) => p !== shown)];
      await saveItemMutation(item);
      toast('Cover updated.');
    });
  }

  const remove = $('#photo-remove');
  if (remove) {
    remove.addEventListener('click', async () => {
      if (!confirm('Remove this photo?')) return;
      item.photos = item.photos.filter((p) => p !== shown);
      const u = photoUrls.get(shown.id);
      if (u) { URL.revokeObjectURL(u); photoUrls.delete(shown.id); }
      detailSelectedPhoto = null;
      await saveItemMutation(item);
    });
  }

  const find = $('#find-archive');
  if (find) find.addEventListener('click', () => runArchiveSearch(item));
}

async function runArchiveSearch(item) {
  const status = $('#archive-status');
  const grid = $('#archive-results');
  status.hidden = false;
  grid.hidden = false;
  status.textContent = 'Searching the archives…';
  grid.innerHTML = '';
  let found = [];
  try { found = await findArchivePhotos(item); } catch { found = []; }
  const have = new Set((item.photos || []).map((p) => p.url).filter(Boolean));
  const fresh = found.filter((f) => !have.has(f.url));
  if (!fresh.length) {
    status.textContent = found.length
      ? 'Every archive image is already in the gallery.'
      : 'No extra images in the archives for this one.';
    return;
  }
  status.textContent = `${fresh.length} image${fresh.length === 1 ? '' : 's'} found — tap to add.`;
  grid.innerHTML = fresh.map((f, i) => `
    <button class="archive-pick" type="button" data-idx="${i}">
      <img src="${esc(f.thumb)}" alt="" loading="lazy">
      <span>${esc(f.label)}</span>
    </button>`).join('');
  $$('#archive-results .archive-pick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const f = fresh[Number(btn.dataset.idx)];
      item.photos.push(newPhoto({ url: f.url, label: f.label }));
      detailSelectedPhoto = null;
      await saveItemMutation(item);
      toast(`Added “${f.label}”.`);
      cachePhotoBlobs(item);
      runArchiveSearch(item); // keep the remaining archive images on screen
    });
  });
}

/* ---------------- live record prices ---------------- */

const discogsCache = new Map(); // item id -> stats (or null) for this session

function paintDiscogs(el, stats) {
  if (!stats) {
    el.textContent = 'Not matched on Discogs — try the search link below.';
    return;
  }
  const price = stats.lowestPrice != null
    ? `Lowest ask ${fmtMoney(stats.lowestPrice)}`
    : 'No copies for sale right now';
  el.innerHTML = `${esc(price)}${stats.numForSale ? ` · ${stats.numForSale} for sale` : ''}
    · <a href="${esc(stats.url)}" target="_blank" rel="noopener">view on Discogs ↗</a>`;
}

async function renderDiscogsPrice(item) {
  const el = $('#discogs-price');
  if (!el) return;
  const token = getDiscogsToken();
  if (!token) {
    el.innerHTML = 'Live prices: add a free Discogs token in <a href="#/settings">Settings</a>.';
    return;
  }
  if (discogsCache.has(item.id)) {
    paintDiscogs(el, discogsCache.get(item.id));
    return;
  }
  el.textContent = 'Checking Discogs…';
  let stats = null;
  let error = null;
  try {
    stats = await discogsStats(item, token);
    discogsCache.set(item.id, stats);
    if (stats && stats.releaseId && item.discogsId !== String(stats.releaseId)) {
      // Remember the match; no updatedAt bump so edits elsewhere still win.
      item.discogsId = String(stats.releaseId);
      await putItem(item);
    }
  } catch (err) {
    error = err.message || 'Discogs is unavailable right now.';
  }
  // Only paint if this item's detail page is still on screen.
  const live = $('#discogs-price');
  const shownId = (location.hash.match(/^#\/item\/(.*)$/) || [])[1];
  if (!live || shownId !== item.id) return;
  if (error) live.textContent = error;
  else paintDiscogs(live, stats);
}

// The + tile in the photo strip: add any number of photos at once.
async function onDetailPhotosPicked(ev) {
  const files = [...(ev.target.files || [])];
  ev.target.value = '';
  if (!files.length) return;
  const id = (location.hash.match(/^#\/item\/(.*)$/) || [])[1];
  const item = items.find((i) => i.id === id);
  if (!item) return;
  for (const file of files) {
    item.photos.push(newPhoto({ blob: await fileToCover(file) }));
  }
  detailSelectedPhoto = null;
  await saveItemMutation(item);
  toast(`Added ${files.length} photo${files.length === 1 ? '' : 's'}.`);
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
      for (const u of photoUrls.values()) URL.revokeObjectURL(u);
      photoUrls.clear();
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
    $('#sync-disconnect').addEventListener('click', async () => {
      if (!confirm('Stop syncing on this device? Your catalog stays here and in the repo.')) return;
      setSyncConfig(null);
      await resealIfLocked();
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
      await resealIfLocked();
      renderSettings();
      renderSyncIndicators();
      await runSync('manual');
    });
  }

  renderLocationsPanel();
  renderDiscogsPanel();
  renderVisionPanel();
  renderLockPanel();

  const records = items.filter((i) => i.kind === 'record').length;
  $('#backup-stats').innerHTML = `
    <span>${records} records</span><span>${items.length - records} books</span>
    <span>${[...new Set(items.flatMap((i) => i.tags))].length} shelves</span>`;
}

function renderDiscogsPanel() {
  const panel = $('#discogs-panel');
  if (getDiscogsToken()) {
    panel.innerHTML = `
      <p class="sync-note">Connected. Record pages now show the current lowest asking price and how many copies are for sale, with a link to that release's full sale history.</p>
      <div class="form-actions">
        <button id="discogs-remove" class="btn btn-danger" type="button">Remove token</button>
      </div>`;
    $('#discogs-remove').addEventListener('click', async () => {
      setDiscogsToken('');
      await resealIfLocked();
      discogsCache.clear();
      renderDiscogsPanel();
    });
  } else {
    panel.innerHTML = `
      <p class="aside-note">See live marketplace prices for your records right on their pages. Needs a free Discogs account: generate a personal access token under
      <a href="https://www.discogs.com/settings/developers" target="_blank" rel="noopener">Discogs → Settings → Developers</a> and paste it here.</p>
      <label class="field">
        <span class="field-label">Discogs personal token</span>
        <input id="discogs-token-input" type="password" autocomplete="off" placeholder="paste token">
      </label>
      <div class="form-actions">
        <button id="discogs-save" class="btn btn-accent" type="button">Save token</button>
      </div>
      <p class="sync-note">Stored only in this browser and sent only to api.discogs.com.</p>`;
    $('#discogs-save').addEventListener('click', async () => {
      const token = $('#discogs-token-input').value.trim();
      if (!token) { toast('Paste the token first.'); return; }
      setDiscogsToken(token);
      await resealIfLocked();
      discogsCache.clear();
      renderDiscogsPanel();
      toast('Discogs connected.');
    });
  }
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
    const photos = [];
    for (const p of it.photos || []) {
      const { blob, ...pr } = p;
      photos.push({ ...pr, data: blob ? await blobToDataUrl(blob) : null });
    }
    out.push({
      ...rest,
      photos,
      // legacy field so backups still open in older builds
      coverData: coverBlob ? await blobToDataUrl(coverBlob) : null,
    });
  }
  const payload = { app: 'stacks', version: 2, exportedAt: new Date().toISOString(), items: out, bookcases: getBookcasesBundle() };
  const stamp = new Date().toISOString().slice(0, 10);
  download(`stacks-backup-${stamp}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  toast(`Backed up ${out.length} items.`);
}

function exportCsv() {
  const bookcases = getBookcases();
  const cols = ['kind', 'title', 'creator', 'year', 'format', 'publisher', 'genre', 'condition', 'barcode', 'pages', 'bookcase', 'shelf', 'summary', 'value', 'valueDate', 'tags', 'notes', 'createdAt'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const it of items) {
    lines.push(cols.map((c) => {
      if (c === 'tags') return cell(it.tags.join('; '));
      if (c === 'bookcase') return cell((bookcases.find((b) => b.id === it.bookcaseId) || {}).name || '');
      return cell(it[c]);
    }).join(','));
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
    adoptBookcasesBundle(payload.bookcases);
    let added = 0;
    let updated = 0;
    for (const raw of payload.items) {
      if (!raw.id || !raw.title) continue;
      const { coverData, ...rest } = raw;
      const item = Object.assign(newItem(rest.kind === 'book' ? 'book' : 'record'), rest);
      item.tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
      item.tracks = Array.isArray(item.tracks) ? item.tracks : [];
      if (Array.isArray(rest.photos)) {
        item.photos = [];
        for (const p of rest.photos) {
          const { data, ...pr } = p;
          const photo = newPhoto(pr);
          if (data && data.startsWith('data:')) photo.blob = await (await fetch(data)).blob();
          item.photos.push(photo);
        }
      } else if (coverData && coverData.startsWith('data:')) {
        item.coverBlob = await (await fetch(coverData)).blob();
      }
      migrateItem(item);
      const existing = items.findIndex((i) => i.id === item.id);
      if (existing >= 0) { items[existing] = item; updated++; } else { items.push(item); added++; }
      dropItemUrls(item);
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); closeMiniScanner(); }
  });
  $('#form-scan-btn').addEventListener('click', openMiniScanner);
  $('#mini-scan-close').addEventListener('click', closeMiniScanner);

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
  $('#form-bookcase').addEventListener('change', () => renderShelfSelect(''));
  $('#item-form').addEventListener('submit', saveForm);
  $('#form-cancel').addEventListener('click', () => { draft = null; history.back(); });
  $('#cover-file').addEventListener('change', onCoverPicked);
  $('#photo-file').addEventListener('change', onPhotoPicked);
  $('#cover-clear').addEventListener('click', () => {
    const removed = draft.photos.shift();
    if (removed) photoUrls.delete(removed.id);
    migrateItem(draft);
    renderFormCover();
  });
  $('#detail-photo-file').addEventListener('change', onDetailPhotosPicked);
  $('#detail-photo-camera').addEventListener('change', onDetailPhotosPicked);
  $('#cover-file-lib').addEventListener('change', onCoverPicked);
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

/* ---------------- app lock ---------------- */

function bindLockScreen() {
  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await unlock($('#lock-pass').value);
    if (!ok) {
      $('#lock-error').hidden = false;
      $('#lock-pass').select();
      return;
    }
    $('#lock-pass').value = '';
    $('#lock-error').hidden = true;
    $('#lock-screen').hidden = true;
    document.body.classList.remove('is-locked');
    startApp();
  });
  $('#lock-reset').addEventListener('click', async () => {
    if (!confirm('Reset this device? The local copy of the catalog and its tokens are wiped. Anything synced or backed up is safe and can be restored.')) return;
    if (!confirm('Really reset? This cannot be undone on this device.')) return;
    await resetDevice();
  });
}

function renderLocationsPanel() {
  const panel = $('#locations-panel');
  const cases = getBookcases();
  const rows = cases.map((b) => {
    const count = items.filter((i) => i.bookcaseId === b.id).length;
    return `
      <div class="location-row" data-id="${esc(b.id)}">
        <span class="location-name">${esc(b.name)}</span>
        <span class="location-meta">${b.shelves} shel${b.shelves === 1 ? 'f' : 'ves'} · ${count} item${count === 1 ? '' : 's'}</span>
        <button class="clear-link location-remove" type="button">Remove</button>
      </div>`;
  }).join('');
  panel.innerHTML = `
    ${cases.length ? `<div class="location-list">${rows}</div>`
      : '<p class="aside-note">Name your bookcases here, then assign every item a bookcase and shelf on its form — so the catalog can tell you exactly where a record or book physically lives.</p>'}
    <div class="location-add">
      <input id="bookcase-name" type="text" autocomplete="off" placeholder="Bookcase name — e.g. Living room wall">
      <input id="bookcase-shelves" type="text" inputmode="numeric" autocomplete="off" placeholder="Shelves" aria-label="Number of shelves">
      <button id="bookcase-add" class="btn btn-accent" type="button">Add</button>
    </div>`;

  $('#bookcase-add').addEventListener('click', async () => {
    const name = $('#bookcase-name').value.trim();
    const shelves = $('#bookcase-shelves').value.trim();
    if (!name) { toast('Give the bookcase a name.'); return; }
    saveBookcases([...cases, newBookcase(name, shelves)]);
    renderLocationsPanel();
    toast(`“${name}” added.`);
    scheduleSync();
  });

  $$('#locations-panel .location-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.location-row').dataset.id;
      const bc = cases.find((b) => b.id === id);
      const affected = items.filter((i) => i.bookcaseId === id);
      const warning = affected.length
        ? ` ${affected.length} item${affected.length === 1 ? "'s" : "s'"} location will be cleared.`
        : '';
      if (!confirm(`Remove “${bc.name}”?${warning}`)) return;
      saveBookcases(cases.filter((b) => b.id !== id));
      for (const item of affected) {
        item.bookcaseId = '';
        item.shelf = '';
        item.updatedAt = new Date().toISOString();
        await putItem(item);
      }
      renderLocationsPanel();
      toast('Removed.');
      scheduleSync();
    });
  });
}

function renderVisionPanel() {
  const panel = $('#vision-panel');
  if (getVisionKey()) {
    panel.innerHTML = `
      <p class="sync-note">Connected. "Take a photo" now identifies the item from the cover and fills in everything automatically — metadata, tracklist, and the archive's front/back images for records. Each identification costs a fraction of a cent on your Claude account.</p>
      <div class="form-actions">
        <button id="vision-remove" class="btn btn-danger" type="button">Remove key</button>
      </div>`;
    $('#vision-remove').addEventListener('click', async () => {
      setVisionKey('');
      await resealIfLocked();
      renderVisionPanel();
    });
  } else {
    panel.innerHTML = `
      <p class="aside-note">Photograph a cover and have it identified automatically — Claude reads the sleeve or jacket, then the open databases fill in the rest. Needs your own Claude API key from
      <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> (each photo costs a fraction of a cent).</p>
      <label class="field">
        <span class="field-label">Claude API key</span>
        <input id="vision-key-input" type="password" autocomplete="off" placeholder="sk-ant-…">
      </label>
      <div class="form-actions">
        <button id="vision-save" class="btn btn-accent" type="button">Save key</button>
      </div>
      <p class="sync-note">Stored only in this browser (encrypted when the app lock is on) and sent only to api.anthropic.com along with the photo.</p>`;
    $('#vision-save').addEventListener('click', async () => {
      const key = $('#vision-key-input').value.trim();
      if (!key) { toast('Paste the API key first.'); return; }
      setVisionKey(key);
      await resealIfLocked();
      renderVisionPanel();
      toast('Photo identification is on.');
    });
  }
}

function renderLockPanel() {
  const panel = $('#lock-panel');
  if (isLockEnabled()) {
    panel.innerHTML = `
      <p class="sync-note">App lock is on. Opening the app on this device asks for the passphrase, and the sync and Discogs tokens are stored encrypted with it.</p>
      <label class="field">
        <span class="field-label">Current passphrase</span>
        <input id="lock-current" type="password" autocomplete="current-password">
      </label>
      <label class="field">
        <span class="field-label">New passphrase <em>for changing it</em></span>
        <input id="lock-new" type="password" autocomplete="new-password">
      </label>
      <div class="form-actions">
        <button id="lock-change" class="btn btn-quiet" type="button">Change passphrase</button>
        <button id="lock-off" class="btn btn-danger" type="button">Turn off lock</button>
      </div>`;
    $('#lock-change').addEventListener('click', async () => {
      const cur = $('#lock-current').value;
      const next = $('#lock-new').value;
      if (next.length < 4) { toast('New passphrase needs at least 4 characters.'); return; }
      if (await changePassphrase(cur, next)) { renderLockPanel(); toast('Passphrase changed.'); }
      else toast("Current passphrase doesn't match.");
    });
    $('#lock-off').addEventListener('click', async () => {
      if (await disableLock($('#lock-current').value)) { renderLockPanel(); toast('App lock is off.'); }
      else toast("Current passphrase doesn't match.");
    });
  } else {
    panel.innerHTML = `
      <p class="aside-note">Require a passphrase to open the app on this device. It also encrypts the stored sync and Discogs tokens. Each person sets their own passphrase on their own device — and if it's forgotten, the way back in is a device reset (the collection stays safe in the sync repo and backups).</p>
      <label class="field">
        <span class="field-label">Passphrase</span>
        <input id="lock-pass-1" type="password" autocomplete="new-password">
      </label>
      <label class="field">
        <span class="field-label">Repeat passphrase</span>
        <input id="lock-pass-2" type="password" autocomplete="new-password">
      </label>
      <div class="form-actions">
        <button id="lock-on" class="btn btn-accent" type="button">Turn on app lock</button>
      </div>`;
    $('#lock-on').addEventListener('click', async () => {
      const a = $('#lock-pass-1').value;
      const b = $('#lock-pass-2').value;
      if (a.length < 4) { toast('Passphrase needs at least 4 characters.'); return; }
      if (a !== b) { toast("The passphrases don't match."); return; }
      await enableLock(a);
      renderLockPanel();
      toast('App lock is on.');
    });
  }
}

/* ---------------- boot ---------------- */

let appStarted = false;

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  items = await getAllItems();
  // Upgrade items saved before the photo gallery existed.
  for (const item of items) {
    if (migrateItem(item)) await putItem(item);
  }
  bindEvents();
  updateNavCount();
  renderSyncIndicators();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // When an update finishes installing mid-session, refresh so the new
    // version shows without waiting for a manual close-and-reopen —
    // immediately on passive views, deferred if a form or scan is open.
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshed) return; // first install: already fresh
      refreshed = true;
      if (currentView === 'form' || currentView === 'scan') {
        pendingReload = true;
      } else {
        location.reload();
      }
    });
  }
  if (getSyncConfig() && navigator.onLine !== false) runSync('startup');
}

async function main() {
  bindLockScreen();
  if (isLockEnabled() && !(await tryRestoreSession())) {
    document.body.classList.add('is-locked');
    $('#lock-screen').hidden = false;
    $('#lock-pass').focus();
    return; // startApp() runs after a successful unlock
  }
  await startApp();
}

main();
