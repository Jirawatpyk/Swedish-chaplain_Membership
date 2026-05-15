/**
 * T015 (Feature 013 / F6.1) — `computeAttendeeFingerprint` tests.
 *
 * Per FR-019a, the fingerprint is a SHA-256 truncated to 16 hex characters
 * over the sorted, lowercased list of `attendee_email` values from
 * `Status === 'Attending'` rows. Used by FR-019b safety net to detect
 * "same CSV uploaded to a different event within 30 days".
 *
 * 8-step deterministic algorithm under test:
 *   1. Filter to isAttending === true
 *   2. Strip mailto (already done upstream — adapter pre-strips)
 *   3. Trim
 *   4. Lowercase
 *   5. Discard empty
 *   6. Sort lexicographically
 *   7. Join with NUL byte (` `)
 *   8. SHA-256 hex, take first 16 chars
 *
 * Property test (fast-check): two random permutations of the same
 * email list produce the same fingerprint.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeAttendeeFingerprint } from '@/modules/events/infrastructure/eventcreate-csv-adapter';
import type { EventCreateAttendeeRow } from '@/modules/events/infrastructure/eventcreate-csv-adapter';

function makeRow(
  email: string,
  opts: { isAttending?: boolean } = {},
): EventCreateAttendeeRow {
  return {
    isAttending: opts.isAttending ?? true,
    attendeeEmail: email,
    attendeeName: 'Test',
    attendeeCompany: undefined,
    attendeeExternalId: undefined,
    ticketType: undefined,
    inferredPaymentStatus: 'paid',
    pdpaConsentAcknowledged: null,
    rawStatus: opts.isAttending === false ? 'Cancelled' : 'Attending',
  };
}

describe('computeAttendeeFingerprint — basic shape', () => {
  it('returns 16-char hex string for non-empty Attending input', () => {
    const rows = [makeRow('a@example.com'), makeRow('b@example.com')];
    const fp = computeAttendeeFingerprint(rows);
    expect(fp).not.toBeNull();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns null for empty input (no rows at all)', () => {
    expect(computeAttendeeFingerprint([])).toBeNull();
  });

  it('returns null when no rows are Attending (FR-019a edge case)', () => {
    const rows = [
      makeRow('a@example.com', { isAttending: false }),
      makeRow('b@example.com', { isAttending: false }),
    ];
    expect(computeAttendeeFingerprint(rows)).toBeNull();
  });
});

describe('computeAttendeeFingerprint — determinism', () => {
  it('produces the same fingerprint for the same email list (sorted vs reversed)', () => {
    const ascending = [
      makeRow('alice@example.com'),
      makeRow('bob@example.com'),
      makeRow('charlie@example.com'),
    ];
    const descending = [
      makeRow('charlie@example.com'),
      makeRow('bob@example.com'),
      makeRow('alice@example.com'),
    ];
    expect(computeAttendeeFingerprint(ascending)).toBe(
      computeAttendeeFingerprint(descending),
    );
  });

  it('produces different fingerprints for different email sets', () => {
    const setA = [makeRow('alice@example.com')];
    const setB = [makeRow('bob@example.com')];
    expect(computeAttendeeFingerprint(setA)).not.toBe(
      computeAttendeeFingerprint(setB),
    );
  });

  it('matches manually-computed SHA-256 over canonical form', () => {
    // Verifies the exact algorithm: sort → NUL-join → sha256 → first 16 hex.
    const rows = [
      makeRow('charlie@example.com'),
      makeRow('alice@example.com'),
      makeRow('bob@example.com'),
    ];
    const expected = createHash('sha256')
      .update(
        ['alice@example.com', 'bob@example.com', 'charlie@example.com'].join(
          '\0',
        ),
        'utf8',
      )
      .digest('hex')
      .slice(0, 16);
    expect(computeAttendeeFingerprint(rows)).toBe(expected);
  });

  it('lowercases before hashing — UPPERCASE.COM and uppercase.com hash to same', () => {
    const upper = [makeRow('FOO@EXAMPLE.COM')];
    const lower = [makeRow('foo@example.com')];
    expect(computeAttendeeFingerprint(upper)).toBe(
      computeAttendeeFingerprint(lower),
    );
  });
});

describe('computeAttendeeFingerprint — Status filter (FR-019a step 1)', () => {
  it('only includes isAttending rows in the canonical form', () => {
    const mixed = [
      makeRow('attending@example.com', { isAttending: true }),
      makeRow('cancelled@example.com', { isAttending: false }),
    ];
    const attendingOnly = [makeRow('attending@example.com')];
    expect(computeAttendeeFingerprint(mixed)).toBe(
      computeAttendeeFingerprint(attendingOnly),
    );
  });
});

describe('computeAttendeeFingerprint — permutation property (fast-check)', () => {
  it('two random permutations of the same email list produce the same fingerprint', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.emailAddress(), { minLength: 1, maxLength: 20 }),
        (emails) => {
          const shuffled = [...emails].reverse();
          const a = emails.map((e) => makeRow(e));
          const b = shuffled.map((e) => makeRow(e));
          expect(computeAttendeeFingerprint(a)).toBe(
            computeAttendeeFingerprint(b),
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
