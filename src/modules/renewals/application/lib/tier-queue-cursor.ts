/**
 * #765 — the tier-upgrade admin queue's page cursor.
 *
 * The queue is ordered `(created_at DESC, suggestion_id DESC)`; the next
 * page starts strictly after the last row kept. `createdAt` travels as the
 * full-precision text Postgres prints (`to_char(... 'US')`, microseconds),
 * never through a JS Date, which keeps only milliseconds and would repeat or
 * drop rows that share a millisecond at the page boundary (the E-Blast queue
 * lesson, PR #760). The cursor is base64url JSON so it stays opaque in URLs.
 *
 * Pure: no framework imports, so the route, the page and the repo share it.
 */

export interface TierQueueCursorKey {
  /** ISO 8601 UTC, up to microseconds, e.g. `2026-11-10T03:04:05.123456Z`. */
  readonly createdAt: string;
  readonly suggestionId: string;
}

const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function encodeTierQueueCursor(key: TierQueueCursorKey): string {
  return toBase64Url(JSON.stringify({ c: key.createdAt, s: key.suggestionId }));
}

/** `null` for anything that is not a cursor this queue wrote (including the old row-id cursor). */
export function decodeTierQueueCursor(raw: string): TierQueueCursorKey | null {
  const text = fromBase64Url(raw);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { c, s } = parsed as { c?: unknown; s?: unknown };
  if (typeof c !== 'string' || !CREATED_AT_RE.test(c)) return null;
  if (typeof s !== 'string' || !UUID_RE.test(s)) return null;
  return { createdAt: c, suggestionId: s };
}

/** Thrown by the repo when handed a cursor that does not decode; the route answers 400 first. */
export class InvalidTierQueueCursorError extends Error {
  constructor() {
    super('invalid tier-upgrade queue cursor');
    this.name = 'InvalidTierQueueCursorError';
  }
}
