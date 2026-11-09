// Web Crypto helpers (crypto.subtle only; works in Workers, Node >= 20 and browsers).

const encoder = new TextEncoder();

const bytes = (input) => (typeof input === 'string' ? encoder.encode(input) : input);

export const toHex = (buffer) => Array.from(new Uint8Array(buffer))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');

export async function sha256Hex(input) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes(input)));
}

export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, bytes(message)));
}

/**
 * Constant-time string comparison. Both sides are hashed first so the loop always
 * runs over 32 bytes and the inputs' lengths are not leaked through timing.
 */
export async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    // eslint-disable-next-line no-bitwise -- constant-time compare needs XOR/OR, not early exit
    diff |= x[i] ^ y[i];
  }
  return diff === 0;
}

/** URL-safe random secret, e.g. for per-round sandbox reviewer links. */
export function randomToken(size = 24) {
  const buf = crypto.getRandomValues(new Uint8Array(size));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
