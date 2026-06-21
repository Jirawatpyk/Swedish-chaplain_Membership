/**
 * COMP-1 US3-D (/speckit-review Fix 1) — erasure-log keyset cursor codec.
 *
 * `decodeCursor` is FAIL-CLOSED + must NEVER throw: a tampered/garbage cursor
 * decodes to `undefined` (the page renders the first page). The decoded
 * `memberId` flows into `lt(members.member_id, cursor.memberId)` against a
 * Postgres `uuid` column — a non-UUID value would throw `22P02` and, since the
 * page's read has no try/catch, surface as a 500. So `decodeCursor` UUID-shape-
 * guards `memberId` (mirroring the F9 audit reader's `ACTOR_UUID_RE`). These
 * tests pin: a clean encode→decode round-trip, and `undefined` for every
 * malformed input class — INCLUDING a valid-shape cursor whose `memberId` is
 * not a UUID (the bug this fix closes).
 */
import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
} from '@/app/(staff)/admin/compliance/erasure-log/cursor';

const UUID = '11111111-1111-4111-8111-111111111111';

/** base64url-encode an arbitrary JSON value (to forge cursor payloads). */
function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('erasure-log cursor codec', () => {
  it('round-trips a valid cursor through encode → decode', () => {
    const erasedAt = new Date('2026-06-20T08:30:00.000Z');
    const decoded = decodeCursor(encodeCursor({ erasedAt, memberId: UUID }));
    expect(decoded).toBeDefined();
    expect(decoded!.memberId).toBe(UUID);
    expect(decoded!.erasedAt.toISOString()).toBe(erasedAt.toISOString());
  });

  it('returns undefined for an empty string (no cursor → first page)', () => {
    expect(decodeCursor('')).toBeUndefined();
  });

  it('returns undefined for non-base64 / garbage input', () => {
    expect(decodeCursor('!!!not base64!!!')).toBeUndefined();
  });

  it('returns undefined for valid base64 that is not valid JSON', () => {
    const notJson = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(decodeCursor(notJson)).toBeUndefined();
  });

  it('returns undefined for valid JSON of the wrong shape (missing fields)', () => {
    expect(decodeCursor(b64url({ erasedAt: '2026-06-20T00:00:00.000Z' }))).toBeUndefined();
    expect(decodeCursor(b64url({ memberId: UUID }))).toBeUndefined();
    expect(decodeCursor(b64url({}))).toBeUndefined();
    // right keys, wrong value types
    expect(decodeCursor(b64url({ erasedAt: 123, memberId: UUID }))).toBeUndefined();
    expect(decodeCursor(b64url({ erasedAt: '2026-06-20T00:00:00.000Z', memberId: 7 }))).toBeUndefined();
  });

  it('returns undefined for a valid shape with an invalid date', () => {
    expect(decodeCursor(b64url({ erasedAt: 'not-a-date', memberId: UUID }))).toBeUndefined();
  });

  it('returns undefined for a valid shape with a NON-UUID memberId (22P02 guard)', () => {
    // The bug: a well-formed string memberId that is not a UUID would reach the
    // `uuid`-column keyset predicate and throw Postgres 22P02 → a 500. Reject it.
    expect(
      decodeCursor(b64url({ erasedAt: '2026-06-20T00:00:00.000Z', memberId: 'not-a-uuid' })),
    ).toBeUndefined();
    // a SQL-injection-shaped probe is also rejected (defence in depth)
    expect(
      decodeCursor(b64url({ erasedAt: '2026-06-20T00:00:00.000Z', memberId: "'; DROP TABLE members; --" })),
    ).toBeUndefined();
    // empty memberId is not a UUID either
    expect(
      decodeCursor(b64url({ erasedAt: '2026-06-20T00:00:00.000Z', memberId: '' })),
    ).toBeUndefined();
  });
});
