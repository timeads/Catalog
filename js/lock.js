// App lock: a per-device passphrase gate. The passphrase derives a key
// (PBKDF2 → AES-GCM, WebCrypto) that encrypts the stored sync and Discogs
// tokens, so they can't be lifted from the browser while locked. Unlock
// lasts for the browser session. "Forgot" is a device reset — the local
// copy is wiped and restored from the sync repo or a backup.

import { getSyncConfig, setSyncConfig, overrideSyncConfig, removeStoredSyncConfig } from './sync.js';
import { getDiscogsToken, setDiscogsToken, overrideDiscogsToken, removeStoredDiscogsToken } from './value.js';
import { getVisionKey, setVisionKey, overrideVisionKey, removeStoredVisionKey } from './identify.js';

const LOCK_KEY = 'stacks-lock';
const SESSION_KEY = 'stacks-unlock-key';
const ITERATIONS = 210000;

let sessionKey = null; // CryptoKey while unlocked

function readBundle() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY)) || null; } catch { return null; }
}

function writeBundle(b) {
  localStorage.setItem(LOCK_KEY, JSON.stringify(b));
}

export function isLockEnabled() {
  return !!readBundle();
}

export function isUnlocked() {
  return !isLockEnabled() || !!sessionKey;
}

/* ---------------- crypto plumbing ---------------- */

const te = new TextEncoder();
const td = new TextDecoder();

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function unb64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveKey(pass, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so the session can survive reloads via sessionStorage
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
  return { iv: b64(iv), data: b64(data) };
}

async function decrypt(key, box) {
  const data = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data),
  );
  return td.decode(data);
}

/* ---------------- secrets handling ---------------- */

function collectSecrets() {
  return JSON.stringify({ sync: getSyncConfig(), discogs: getDiscogsToken(), vision: getVisionKey() });
}

function applySecrets(json) {
  const s = JSON.parse(json);
  overrideSyncConfig(s.sync || null);
  overrideDiscogsToken(s.discogs || '');
  overrideVisionKey(s.vision || '');
}

// While the lock is on, plaintext tokens must not sit in localStorage.
async function sealSecrets(key, bundle) {
  bundle.secrets = await encrypt(key, collectSecrets());
  writeBundle(bundle);
  removeStoredSyncConfig();
  removeStoredDiscogsToken();
  removeStoredVisionKey();
}

// Call after tokens change (connect/disconnect) while the lock is on.
export async function resealIfLocked() {
  const bundle = readBundle();
  if (!bundle || !sessionKey) return;
  await sealSecrets(sessionKey, bundle);
}

/* ---------------- lifecycle ---------------- */

export async function enableLock(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pass, salt, ITERATIONS);
  const bundle = {
    v: 1,
    salt: b64(salt),
    iterations: ITERATIONS,
    verify: await encrypt(key, 'stacks-ok'),
  };
  await sealSecrets(key, bundle);
  sessionKey = key;
  await storeSessionKey(key);
}

export async function unlock(pass) {
  const bundle = readBundle();
  if (!bundle) return true;
  try {
    const key = await deriveKey(pass, unb64(bundle.salt), bundle.iterations);
    if ((await decrypt(key, bundle.verify)) !== 'stacks-ok') return false;
    applySecrets(await decrypt(key, bundle.secrets));
    sessionKey = key;
    await storeSessionKey(key);
    return true;
  } catch {
    return false;
  }
}

export async function disableLock(pass) {
  const bundle = readBundle();
  if (!bundle) return true;
  if (!(await unlock(pass))) return false;
  // Write the secrets back as plaintext storage and drop the lock.
  setSyncConfig(getSyncConfig());
  setDiscogsToken(getDiscogsToken());
  setVisionKey(getVisionKey());
  localStorage.removeItem(LOCK_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  sessionKey = null;
  return true;
}

export async function changePassphrase(oldPass, newPass) {
  if (!(await unlock(oldPass))) return false;
  await enableLock(newPass);
  return true;
}

// Session persistence: reloading the tab shouldn't re-ask, closing the
// browser should.
async function storeSessionKey(key) {
  try {
    const raw = await crypto.subtle.exportKey('raw', key);
    sessionStorage.setItem(SESSION_KEY, b64(raw));
  } catch {}
}

export async function tryRestoreSession() {
  const bundle = readBundle();
  if (!bundle) return true;
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw', unb64(stored), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'],
    );
    if ((await decrypt(key, bundle.verify)) !== 'stacks-ok') return false;
    applySecrets(await decrypt(key, bundle.secrets));
    sessionKey = key;
    return true;
  } catch {
    return false;
  }
}

// The escape hatch: wipe this device — lock, tokens, and the local catalog.
// The collection stays in the sync repo and in any backups.
export async function resetDevice() {
  localStorage.removeItem(LOCK_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  removeStoredSyncConfig();
  removeStoredDiscogsToken();
  removeStoredVisionKey();
  for (const k of ['stacks-sync-covers', 'stacks-sync-last', 'stacks-tombstones']) {
    localStorage.removeItem(k);
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('stacks-catalog');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  location.reload();
}
