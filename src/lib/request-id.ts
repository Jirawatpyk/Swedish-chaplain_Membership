import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 generator (T020).
 *
 * UUIDv7 (RFC 9562) is a 128-bit identifier whose first 48 bits encode
 * the unix epoch in milliseconds. The remaining 80 bits are random with
 * a 4-bit version field and a 2-bit variant field embedded.
 *
 * Why v7 (not v4):
 *   - Time-ordered → primary-key inserts stay sequential, avoiding
 *     B-tree fragmentation in Postgres.
 *   - Sortable correlation IDs in logs.
 *   - Still globally unique with 74 bits of entropy.
 *
 * We implement it manually instead of pulling another dependency
 * because the algorithm fits in ~30 lines and Node 20 does not yet
 * expose `crypto.randomUUID({ version: 7 })`.
 */
export function uuidv7(): string {
  const now = BigInt(Date.now());

  // 16 bytes total
  const bytes = randomBytes(16);

  // First 6 bytes = 48-bit unix-ms big-endian
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);

  // Set version (7) in the high nibble of byte 6
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Set variant (RFC 4122) in the high two bits of byte 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  // Format as canonical UUID string (8-4-4-4-12)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-` +
    `${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-` +
    `${hex.slice(20)}`
  );
}

/**
 * Read the inbound request id from a Headers object, or generate a new
 * one if absent or malformed. Used by middleware (T043) to attach a
 * stable id to every request before it reaches the app.
 *
 * Header precedence: `x-request-id` → `x-vercel-id` → generate.
 */
const REQUEST_ID_PATTERN = /^[a-f0-9-]{8,128}$/i;

export function requestIdFromHeaders(headers: Headers): string {
  const fromInbound =
    headers.get('x-request-id') ?? headers.get('x-vercel-id') ?? '';
  return REQUEST_ID_PATTERN.test(fromInbound) ? fromInbound : uuidv7();
}

export const REQUEST_ID_HEADER = 'x-request-id';
