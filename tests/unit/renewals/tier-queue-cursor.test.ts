/**
 * #765 — the tier-upgrade admin queue pages by a real keyset on
 * `(created_at, suggestion_id)`. The cursor carries `created_at` at full
 * Postgres precision (microseconds, written by `to_char` in the repo): a JS
 * Date would cut it to milliseconds and repeat or drop rows at the page
 * boundary (the E-Blast queue lesson, PR #760).
 */
import { describe, expect, it } from 'vitest';
import { decodeTierQueueCursor, encodeTierQueueCursor } from '@/modules/renewals';

const ID = '0b5f6a8e-2d47-4c1a-9f3e-7a1b2c3d4e5f';

describe('tier-upgrade queue cursor', () => {
  it('round-trips a microsecond timestamp and the suggestion id', () => {
    const key = { createdAt: '2026-11-10T03:04:05.123456Z', suggestionId: ID };
    expect(decodeTierQueueCursor(encodeTierQueueCursor(key))).toEqual(key);
  });

  it('accepts a millisecond or whole-second timestamp', () => {
    for (const createdAt of ['2026-11-10T03:04:05.123Z', '2026-11-10T03:04:05Z']) {
      expect(decodeTierQueueCursor(encodeTierQueueCursor({ createdAt, suggestionId: ID }))).toEqual({
        createdAt,
        suggestionId: ID,
      });
    }
  });

  it.each([
    ['the old row-id cursor', ID],
    ['not base64url JSON', '%%%'],
    ['a bad timestamp', Buffer.from(JSON.stringify({ c: '2026-13-45 nope', s: ID })).toString('base64url')],
    ['a non-uuid id', Buffer.from(JSON.stringify({ c: '2026-11-10T03:04:05Z', s: "x' OR 1=1" })).toString('base64url')],
    ['missing fields', Buffer.from(JSON.stringify({ c: '2026-11-10T03:04:05Z' })).toString('base64url')],
    ['empty', ''],
  ])('refuses %s', (_label, raw) => {
    expect(decodeTierQueueCursor(raw)).toBeNull();
  });
});
