// Accounts and the cloud connection (Supabase): sign-in, the session, and
// the client the sync engine talks through. The library is vendored
// (vendor/supabase.js, loaded as a classic script that defines a global).
//
// The project URL and publishable key below are public by design: they only
// identify the project. Every row and photo is protected server-side by
// row-level security (each person sees only their own data, and only
// approved emails can read or write anything).

export const SUPABASE_URL = 'https://vxqitvcycmaircasiysq.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_hbQgFgHi5ueNuQGxV3QgFg_LWrIOU06';

const SESSION_KEY = 'stacks-auth';

export function cloudConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY && globalThis.supabase);
}

// The login session normally lives in localStorage. With the app lock on, it
// lives only in memory and in the lock's encrypted bundle instead, so it
// can't be read from the browser while locked. lock.js flips this mode.
let lockedMode = false;
const memory = new Map();
let onLockedSessionChange = () => {};

const authStorage = {
  getItem(k) {
    if (lockedMode) return memory.has(k) ? memory.get(k) : null;
    try { return localStorage.getItem(k); } catch { return null; }
  },
  setItem(k, v) {
    if (lockedMode) { memory.set(k, v); onLockedSessionChange(); return; }
    try { localStorage.setItem(k, v); } catch {}
  },
  removeItem(k) {
    if (lockedMode) { memory.delete(k); onLockedSessionChange(); return; }
    try { localStorage.removeItem(k); } catch {}
  },
};

// lock.js: the raw stored session, to seal into the encrypted bundle.
export function exportStoredSession() {
  return authStorage.getItem(SESSION_KEY);
}

// lock.js: keep the session in memory only (lock on) or put it back in
// localStorage (lock off). `session` restores what the bundle held.
export function setSessionLocked(locked, session, onChange) {
  if (locked) {
    if (session !== undefined && session !== null) memory.set(SESSION_KEY, session);
    else if (!memory.has(SESSION_KEY)) {
      try {
        const s = localStorage.getItem(SESSION_KEY);
        if (s) memory.set(SESSION_KEY, s);
      } catch {}
    }
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    lockedMode = true;
    onLockedSessionChange = onChange || (() => {});
  } else {
    const s = memory.get(SESSION_KEY);
    lockedMode = false;
    memory.clear();
    try {
      if (s) localStorage.setItem(SESSION_KEY, s);
    } catch {}
  }
}

export function clearStoredSession() {
  memory.clear();
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// The app's own address, where email links (confirm account, reset
// password) bring people back to.
function appUrl() {
  return location.origin + location.pathname;
}

let client = null;

// Created lazily, so a locked device only builds it after unlocking (when
// the session is back in memory).
export function cloud() {
  if (!cloudConfigured()) return null;
  if (!client) {
    client = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        storage: authStorage,
        storageKey: SESSION_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'implicit',
      },
    });
  }
  return client;
}

// An email link lands with its tokens in the URL fragment, which would
// otherwise read as an app route.
export function isAuthCallback() {
  return /(^|[#&])(access_token|error_description|error_code)=/.test(location.hash);
}

export async function currentUser() {
  const sb = cloud();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session ? data.session.user : null;
}

export function onAuthChange(fn) {
  const sb = cloud();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((event, session) => fn(event, session));
  return () => data.subscription.unsubscribe();
}

// Errors from the auth server, in plain words.
function authError(err) {
  const m = String((err && err.message) || '');
  if (/invalid login credentials/i.test(m)) return 'That email and password don’t match.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first. The link is in your inbox.';
  if (/already registered|already been registered/i.test(m)) return 'That email already has an account. Sign in instead.';
  if (/password should be at least/i.test(m)) return 'Use a password of at least 8 characters.';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  if (/fetch|network/i.test(m)) return 'Couldn’t reach the server. Check your connection.';
  return m || 'Something went wrong. Try again.';
}

export async function signIn(email, password) {
  const { data, error } = await cloud().auth.signInWithPassword({ email, password });
  if (error) throw new Error(authError(error));
  return data.user;
}

// Returns {needsConfirmation} — true when the account must be confirmed from
// the emailed link before signing in.
export async function signUp(email, password) {
  const { data, error } = await cloud().auth.signUp({
    email,
    password,
    options: { emailRedirectTo: appUrl() },
  });
  if (error) throw new Error(authError(error));
  // An already-registered email comes back as a user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('That email already has an account. Sign in instead.');
  }
  return { needsConfirmation: !data.session };
}

export async function sendPasswordReset(email) {
  const { error } = await cloud().auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) throw new Error(authError(error));
}

export async function setNewPassword(password) {
  const { error } = await cloud().auth.updateUser({ password });
  if (error) throw new Error(authError(error));
}

export async function signOut() {
  const sb = cloud();
  if (sb) await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  clearStoredSession();
}
