/**
 * #754 follow-up, review round 1 (L5) — `tryRenewalsCronLock` reads the
 * row Postgres returns. An unexpected shape must fail loudly (a 500 the
 * coordinator counts as failed), never read as "another run holds the lock"
 * — that would skip the tenant's run with nobody noticing.
 */
import { describe, expect, it } from 'vitest';
import { tryRenewalsCronLock } from '@/lib/renewals-cron-lock';

function txReturning(rows: unknown) {
  return { execute: async () => rows } as unknown as Parameters<typeof tryRenewalsCronLock>[0];
}

describe('tryRenewalsCronLock', () => {
  it('returns true when Postgres granted the lock', async () => {
    await expect(tryRenewalsCronLock(txReturning([{ acquired: true }]), 'renewals:dispatch:', 't')).resolves.toBe(true);
  });

  it('returns false when another session holds it', async () => {
    await expect(tryRenewalsCronLock(txReturning([{ acquired: false }]), 'renewals:dispatch:', 't')).resolves.toBe(false);
  });

  it.each([
    ['no row', []],
    ['a row without the column', [{}]],
    ['a non-boolean value', [{ acquired: 't' }]],
  ])('throws on %s', async (_label, rows) => {
    await expect(tryRenewalsCronLock(txReturning(rows), 'renewals:dispatch:', 't')).rejects.toThrow(
      /unexpected/i,
    );
  });
});
