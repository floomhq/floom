// AES-256-GCM encryption for org secrets.
// Key: 32-byte hex string from SECRETS_ENCRYPTION_KEY env var.

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;

function getKeyMaterial(hexKey: string): Uint8Array {
  if (hexKey.length !== 64) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  const keyMaterial = getKeyMaterial(hexKey);
  return crypto.subtle.importKey(
    "raw",
    keyMaterial.buffer as ArrayBuffer,
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encrypt(
  plaintext: string,
  hexKey: string
): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded
  );

  // Prepend IV to ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(
  encryptedBase64: string,
  hexKey: string
): Promise<string> {
  const key = await importKey(hexKey);
  const combined = Uint8Array.from(atob(encryptedBase64), (c) =>
    c.charCodeAt(0)
  );

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
