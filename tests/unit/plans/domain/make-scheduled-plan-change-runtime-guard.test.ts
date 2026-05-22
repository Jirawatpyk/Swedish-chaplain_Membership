/**
 * R4-I11 — `makeScheduledPlanChange` runtime guard.
 *
 * The factory exposes 4 TS overloads (`pending`, `applied`,
 * `superseded`, `cancelled`) that enforce the timestamp parameter
 * at compile time for the 3 terminal statuses. A typed caller cannot
 * call `makeScheduledPlanChange(base, 'applied')` without supplying
 * a timestamp — TS refuses to match the overload.
 *
 * BUT — a caller that widens the status via `as ScheduledPlanChangeStatus`
 * (or via generic propagation, or via `any`) bypasses the overload
 * signature and lands on the implementation overload. Without the
 * runtime guard, the implementation produces a corrupt record with
 * `appliedAt: undefined` (the `timestamp!` non-null assertion does
 * nothing at runtime). That corrupt record would slip past the type
 * system + only fail later at `assertValidScheduledPlanChange` with
 * the cryptic "status↔timestamp invariant" message.
 *
 * This test pins the runtime guard: it throws BEFORE the corrupt
 * record can be returned + the error message names the missing
 * parameter.
 */
import { describe, expect, it } from 'vitest';
import {
  makeScheduledPlanChange,
  type ScheduledPlanChangeStatus,
} from '@/modules/plans';

const BASE = {
  tenantId: 'test-swecham',
  scheduledChangeId: 'sched-test-r4-i11',
  memberId: '11111111-1111-1111-1111-111111111111',
  effectiveAtCycleId: '22222222-2222-2222-2222-222222222222',
  fromPlanId: 'corporate-regular',
  toPlanId: 'corporate-premier',
  scheduledByUserId: '33333333-3333-3333-3333-333333333333',
  reason: null,
  scheduledAt: '2026-05-19T10:00:00Z',
};
const TS = '2026-05-19T12:00:00Z';

describe('makeScheduledPlanChange — runtime guard (R4-I11)', () => {
  it("status='pending' constructs cleanly without a timestamp arg", () => {
    const row = makeScheduledPlanChange(BASE, 'pending');
    expect(row.status).toBe('pending');
    expect(row.appliedAt).toBeNull();
    expect(row.supersededAt).toBeNull();
    expect(row.cancelledAt).toBeNull();
  });

  it("status='applied' with a timestamp constructs cleanly", () => {
    const row = makeScheduledPlanChange(BASE, 'applied', TS);
    expect(row.status).toBe('applied');
    expect(row.appliedAt).toBe(TS);
    expect(row.supersededAt).toBeNull();
    expect(row.cancelledAt).toBeNull();
  });

  // Widened-status call sites bypassing the overload signatures.
  // Cast to the union type, then call the impl directly.
  const widened = makeScheduledPlanChange as (
    base: typeof BASE,
    status: ScheduledPlanChangeStatus,
    timestamp?: string,
  ) => unknown;

  it("throws when status='applied' but timestamp is undefined (widened cast bypass)", () => {
    expect(() => widened(BASE, 'applied')).toThrowError(
      /'timestamp' is required when status='applied'/,
    );
  });

  it("throws when status='superseded' but timestamp is undefined", () => {
    expect(() => widened(BASE, 'superseded')).toThrowError(
      /'timestamp' is required when status='superseded'/,
    );
  });

  it("throws when status='cancelled' but timestamp is undefined", () => {
    expect(() => widened(BASE, 'cancelled')).toThrowError(
      /'timestamp' is required when status='cancelled'/,
    );
  });

  it("does NOT throw when status='pending' regardless of timestamp arg", () => {
    expect(() => widened(BASE, 'pending')).not.toThrow();
    expect(() => widened(BASE, 'pending', undefined)).not.toThrow();
  });
});
