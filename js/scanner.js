// Camera barcode scanning. Uses the native BarcodeDetector where available
// (Chrome/Android); otherwise lazy-loads the vendored ZXing bundle, which
// covers iOS Safari and desktop Firefox.

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

let zxingLoaded = null;

function loadZxing() {
  if (!zxingLoaded) {
    zxingLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing.min.js';
      s.onload = () => resolve(window.ZXing);
      s.onerror = () => reject(new Error('Could not load the barcode reader.'));
      document.head.appendChild(s);
    });
  }
  return zxingLoaded;
}

async function nativeDetectorSupported() {
  if (!('BarcodeDetector' in window)) return false;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    return FORMATS.some((f) => supported.includes(f));
  } catch {
    return false;
  }
}

// Starts the camera on `video` and calls `onCode(text)` on the first hit.
// Returns a stop() function; always call it when leaving the scanner.
export async function startScanner(video, onCode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser has no camera access. Type the number instead.');
  }

  if (await nativeDetectorSupported()) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    const detector = new window.BarcodeDetector({ formats: FORMATS });
    let running = true;
    const stop = () => {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
    (async function poll() {
      while (running) {
        try {
          const codes = await detector.detect(video);
          if (codes.length && running) {
            stop();
            onCode(codes[0].rawValue);
            return;
          }
        } catch {
          // frame not ready yet — keep polling
        }
        await new Promise((r) => setTimeout(r, 180));
      }
    })();
    return stop;
  }

  const ZXing = await loadZxing();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
    ZXing.BarcodeFormat.CODE_128,
  ]);
  const reader = new ZXing.BrowserMultiFormatReader(hints);
  let done = false;
  const stop = () => {
    done = true;
    reader.reset();
  };
  try {
    await reader.decodeFromConstraints(
      { video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false },
      video,
      (result) => {
        if (result && !done) {
          stop();
          onCode(result.getText());
        }
      }
    );
  } catch (err) {
    stop();
    if (err && err.name === 'NotAllowedError') throw err;
    throw new Error('No camera found — type the number below instead.');
  }
  return stop;
}
