// In-browser background removal using IMG.LY's open-source ONNX model
// (https://github.com/imgly/background-removal-js). The library and its
// model (~40 MB) load from a CDN on first use; the service worker caches
// both so later cutouts work offline. The photo itself never leaves the
// device — inference runs locally in WebAssembly.

const MODULE_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1/+esm';

let modPromise = null;

function loadModule() {
  if (!modPromise) {
    modPromise = import(MODULE_URL).catch((err) => {
      modPromise = null; // let a later tap retry after a network hiccup
      throw new Error('Could not load the background-removal model — check the connection and try again.'
        + (err && err.message ? ` (${err.message})` : ''));
    });
  }
  return modPromise;
}

// blob in → PNG blob with a transparent background out. onProgress gets a
// short human-readable status ("Downloading model… 42%", "Working…").
export async function removePhotoBackground(blob, onProgress = () => {}) {
  onProgress('Loading…');
  const mod = await loadModule();
  const removeBackground = mod.removeBackground || mod.default;
  if (typeof removeBackground !== 'function') {
    throw new Error('The background-removal library did not load correctly.');
  }
  const perAsset = new Map(); // asset key -> [loaded, total] while downloading
  return removeBackground(blob, {
    output: { format: 'image/png' },
    progress: (key, current, total) => {
      if (!String(key).startsWith('fetch')) { onProgress('Working…'); return; }
      if (!total) return;
      perAsset.set(key, [current, total]);
      let cur = 0;
      let tot = 0;
      for (const [c, t] of perAsset.values()) { cur += c; tot += t; }
      onProgress(`Downloading model… ${Math.min(100, Math.round((cur / tot) * 100))}%`);
    },
  });
}
