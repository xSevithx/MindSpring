// All encryption happens here, in the browser. The derived key never
// leaves the page and is never sent to the server.

const enc = new TextEncoder();
const dec = new TextDecoder();

// Use globalThis explicitly — a module named crypto.js must not shadow window.crypto.
const subtle = globalThis.crypto?.subtle;

export function assertCryptoAvailable() {
  if (!subtle) {
    throw new Error(
      'Encryption is unavailable in this browser context. Open the app at http://localhost:8080 (not your PC name or LAN IP), or serve it over HTTPS.'
    );
  }
}

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// Derive a 256-bit AES-GCM key from the password + per-user salt.
// PBKDF2 with a high iteration count slows brute-force on the key.
export async function deriveKey(password, saltB64) {
  assertCryptoAvailable();
  const baseKey = await subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: unb64(saltB64),
      iterations: 310000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptNote(key, plaintextObj) {
  assertCryptoAvailable();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(plaintextObj));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64(iv), ciphertext: b64(ct) };
}

export async function decryptNote(key, ivB64, ciphertextB64) {
  assertCryptoAvailable();
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) },
    key,
    unb64(ciphertextB64)
  );
  return JSON.parse(dec.decode(pt));
}
