export const SECRET_KEY_VERSION = 'v1';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  keyVersion: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x7ffe;
  const encodedChunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    encodedChunks.push(btoa(String.fromCharCode(...chunk)));
  }
  return encodedChunks.join('');
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Encryption key or ciphertext must be valid base64');
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const rawKey = decodeBase64(base64Key);
  if (rawKey.length !== 32) {
    throw new Error('AES-256 key must be exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(
  plaintext: string,
  base64Key: string,
): Promise<EncryptedSecret> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  return {
    ciphertext: encodeBase64(new Uint8Array(encrypted)),
    iv: encodeBase64(iv),
    keyVersion: SECRET_KEY_VERSION,
  };
}

export async function decryptSecret(
  encrypted: EncryptedSecret,
  base64Key: string,
): Promise<string> {
  if (encrypted.keyVersion !== SECRET_KEY_VERSION) {
    throw new Error(`Unsupported encryption key version: ${encrypted.keyVersion}`);
  }

  const key = await importKey(base64Key);
  const iv = decodeBase64(encrypted.iv);
  if (iv.length !== 12) throw new Error('AES-GCM IV must be exactly 12 bytes');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    decodeBase64(encrypted.ciphertext),
  );
  return decoder.decode(plaintext);
}

export function generateInvitationToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
