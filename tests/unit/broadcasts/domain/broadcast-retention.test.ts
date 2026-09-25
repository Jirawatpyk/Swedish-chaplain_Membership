/**
 * F7 retention sweep (migration 0310) — the retention clock of a closed
 * E-Blast: which column anchors it, when it expires, and that nothing but a
 * terminal row ever has one.
 *
 * The anchor is the moment the row reached its terminal status, never
 * `updated_at` (a redaction or an audience clean-up touches that, and would
 * restart the clock). `stage_entered_at` is the fallback for a row whose own
 * column is NULL, and the only anchor `expired_no_member_response` has.
 */
import { describe, expect, it } from 'vitest';

import {
  RETENTION_ANCHOR_FIELD,
  addCalendarYearsUtc,
  isPastRetention,
  retentionAnchorOf,
  retentionExpiresAt,
  type RetentionClockInput,
} from '@/modules/broadcasts/domain/retention/broadcast-retention';
import {
  BROADCAST_STATUSES,
  TERMINAL_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const STAGE = new Date('2020-01-10T00:00:00.000Z');
const OWN = new Date('2020-03-15T08:30:00.000Z');

function row(status: BroadcastStatus, overrides: Partial<RetentionClockInput> = {}): RetentionClockInput {
  return {
    status,
    retentionYears: 5,
    stageEnteredAt: STAGE,
    sentAt: null,
    partialDeliveryAcceptedAt: null,
    failedToDispatchAt: null,
    rejectedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe('RETENTION_ANCHOR_FIELD', () => {
  it('names an anchor for exactly the terminal statuses', () => {
    expect(Object.keys(RETENTION_ANCHOR_FIELD).sort()).toEqual([...TERMINAL_BROADCAST_STATUSES].sort());
  });

  it('never anchors on updated_at', () => {
    expect(Object.values(RETENTION_ANCHOR_FIELD)).not.toContain('updatedAt');
  });
});

describe('retentionAnchorOf — each terminal status reads its own column', () => {
  it.each([
    ['sent', 'sentAt'],
    ['partial_delivery_accepted', 'partialDeliveryAcceptedAt'],
    ['failed_to_dispatch', 'failedToDispatchAt'],
    ['rejected', 'rejectedAt'],
    ['cancelled', 'cancelledAt'],
  ] as const)('%s → %s', (status, field) => {
    expect(RETENTION_ANCHOR_FIELD[status]).toBe(field);
    expect(retentionAnchorOf(row(status, { [field]: OWN }))).toEqual(OWN);
  });

  it('expired_no_member_response → stage_entered_at (it has no column of its own)', () => {
    expect(RETENTION_ANCHOR_FIELD.expired_no_member_response).toBe('stageEnteredAt');
    expect(retentionAnchorOf(row('expired_no_member_response'))).toEqual(STAGE);
  });

  it.each(['sent', 'partial_delivery_accepted', 'failed_to_dispatch', 'rejected', 'cancelled'] as const)(
    '%s with its own column NULL falls back to stage_entered_at',
    (status) => {
      expect(retentionAnchorOf(row(status))).toEqual(STAGE);
    },
  );

  it('ignores a column that belongs to another status', () => {
    // A cancelled row that also carries sent_at (impossible today, but the
    // clock must follow the status, not whichever column happens to be set).
    expect(retentionAnchorOf(row('cancelled', { sentAt: OWN }))).toEqual(STAGE);
  });

  it('a non-terminal row has no retention clock', () => {
    const open = BROADCAST_STATUSES.filter(
      (s) => !(TERMINAL_BROADCAST_STATUSES as readonly string[]).includes(s),
    );
    expect(open.length).toBeGreaterThan(0);
    for (const status of open) {
      expect(retentionAnchorOf(row(status, { sentAt: OWN }))).toBeNull();
      expect(retentionExpiresAt(row(status))).toBeNull();
    }
  });
});

describe('retentionExpiresAt — anchor + the row\'s own retention_years', () => {
  it('5 years', () => {
    expect(retentionExpiresAt(row('sent', { sentAt: OWN }))).toEqual(new Date('2025-03-15T08:30:00.000Z'));
  });

  it('10 years', () => {
    expect(retentionExpiresAt(row('sent', { sentAt: OWN, retentionYears: 10 }))).toEqual(
      new Date('2030-03-15T08:30:00.000Z'),
    );
  });
});

describe('addCalendarYearsUtc', () => {
  it('keeps the day and the time of day', () => {
    expect(addCalendarYearsUtc(new Date('2021-07-04T23:59:59.999Z'), 5)).toEqual(
      new Date('2026-07-04T23:59:59.999Z'),
    );
  });

  it('clamps 29 February to 28 February in a non-leap target year, as Postgres `+ interval` does', () => {
    expect(addCalendarYearsUtc(new Date('2024-02-29T12:00:00.000Z'), 5)).toEqual(
      new Date('2029-02-28T12:00:00.000Z'),
    );
  });

  it('keeps 29 February when the target year is a leap year', () => {
    expect(addCalendarYearsUtc(new Date('2024-02-29T12:00:00.000Z'), 4)).toEqual(
      new Date('2028-02-29T12:00:00.000Z'),
    );
  });
});

describe('isPastRetention', () => {
  const sent = row('sent', { sentAt: OWN });

  it('is false the instant before expiry and true at it', () => {
    expect(isPastRetention(sent, new Date('2025-03-15T08:29:59.999Z'))).toBe(false);
    expect(isPastRetention(sent, new Date('2025-03-15T08:30:00.000Z'))).toBe(true);
  });

  it('is never true for a non-terminal row, however old', () => {
    expect(isPastRetention(row('approved'), new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });
});
