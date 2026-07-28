/**
 * DV-Wave2 ⑥ — pure `collectionRatePct` Domain helper (100% line coverage).
 *
 * Examples pin the worked spec case; the fast-check property is the review-
 * mandated guard against any >100% / negative regression (the exact failure
 * class the banned flow÷stock rate exhibits).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { collectionRatePct } from '@/modules/renewals';

describe('collectionRatePct', () => {
  it('worked spec case: 190000 / (190000 + 50000) → 79.16 (renders "79.2%")', () => {
    const r = collectionRatePct(190000n, 50000n);
    expect(r).toBe(79.16);
    expect(r?.toFixed(1)).toBe('79.2');
  });

  it('returns null when nothing has come due yet this fiscal year (denom 0)', () => {
    expect(collectionRatePct(0n, 0n)).toBeNull();
  });

  it('100% when everything due is settled', () => {
    expect(collectionRatePct(100n, 0n)).toBe(100);
  });

  it('0% when everything due is still owed', () => {
    expect(collectionRatePct(0n, 100n)).toBe(0);
  });

  it('property: result is null or within [0, 100] for any non-negative legs', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (settled, overdue) => {
          const r = collectionRatePct(settled, overdue);
          if (r === null) {
            // Only the denom-0 case yields null.
            expect(settled + overdue).toBe(0n);
          } else {
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(100);
          }
        },
      ),
    );
  });
});
