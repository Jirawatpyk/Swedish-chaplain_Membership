/**
 * T128 — Unit tests for benefits-page server-component helpers (US3).
 *
 * Spec authority: spec.md US3 AS1, AS2, AS4 + contracts/broadcasts-api.md
 * § 1.7 (`nextResetAt` + `tenantTimezone`).
 *
 * Authored RED-first against a not-yet-existing module; GREEN once
 * `src/app/(member)/portal/benefits/e-blasts/_helpers/quota-banner.ts`
 * landed. Helpers asserted:
 *   - `formatNextResetAt(quotaYear, tenantTz)` → ISO 8601 UTC instant
 *     pointing at 1 January (year+1) in `tenantTz`.
 *   - `shouldShowPlanChangedExplainer(planChangedAt, quotaYear, tenantTz)`
 *     → boolean. True iff the plan changed inside the current quota year.
 *   - `paginateHistory<T>(rows, page, perPage)` → `{ items, page, perPage,
 *     totalPages, total }`.
 */
import { describe, expect, it } from 'vitest';
import * as helpers from '@/app/(member)/portal/benefits/e-blasts/_helpers/quota-banner';

function ensureLoaded(): typeof helpers {
  return helpers;
}

describe('T128 RED — benefits page helpers (US3)', () => {
  describe('formatNextResetAt', () => {
    it('returns next-year boundary in tenant TZ as ISO 8601 UTC (Asia/Bangkok)', () => {
      const h = ensureLoaded();
      // 2027-01-01T00:00:00+07:00 === 2026-12-31T17:00:00Z
      expect(h.formatNextResetAt(2026, 'Asia/Bangkok')).toBe(
        '2026-12-31T17:00:00.000Z',
      );
    });

    it('handles UTC tenant timezone (no offset)', () => {
      const h = ensureLoaded();
      expect(h.formatNextResetAt(2026, 'UTC')).toBe('2027-01-01T00:00:00.000Z');
    });

    it('handles Europe/Stockholm CET year boundary (+01:00)', () => {
      const h = ensureLoaded();
      expect(h.formatNextResetAt(2026, 'Europe/Stockholm')).toBe(
        '2026-12-31T23:00:00.000Z',
      );
    });

    it('rejects invalid IANA TZ names', () => {
      const h = ensureLoaded();
      expect(() => h.formatNextResetAt(2026, 'Invalid/Zone')).toThrow();
    });
  });

  describe('shouldShowPlanChangedExplainer (AS2)', () => {
    const TZ = 'Asia/Bangkok';

    it('true when plan changed earlier this quota year', () => {
      const h = ensureLoaded();
      const planChangedAt = new Date('2026-03-15T05:00:00Z');
      expect(h.shouldShowPlanChangedExplainer(planChangedAt, 2026, TZ)).toBe(
        true,
      );
    });

    it('false when plan never changed (null)', () => {
      const h = ensureLoaded();
      expect(h.shouldShowPlanChangedExplainer(null, 2026, TZ)).toBe(false);
    });

    it('false when plan changed in a previous quota year', () => {
      const h = ensureLoaded();
      const planChangedAt = new Date('2025-08-01T05:00:00Z');
      expect(h.shouldShowPlanChangedExplainer(planChangedAt, 2026, TZ)).toBe(
        false,
      );
    });

    it('respects tenant timezone year boundary — 2025-12-31T23:00Z falls in 2026 quota year for Asia/Bangkok', () => {
      const h = ensureLoaded();
      // 2025-12-31T23:00Z = 2026-01-01T06:00 ICT → 2026 quota year
      const planChangedAt = new Date('2025-12-31T23:00:00Z');
      expect(h.shouldShowPlanChangedExplainer(planChangedAt, 2026, TZ)).toBe(
        true,
      );
    });
  });

  describe('paginateHistory', () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({
      id: `b-${i + 1}`,
      subject: `Broadcast ${i + 1}`,
    }));

    it('page 1 of 23 rows @ 10 per page → 10 items, 3 pages', () => {
      const h = ensureLoaded();
      const page = h.paginateHistory(rows, 1, 10);
      expect(page.items).toHaveLength(10);
      expect(page.items[0]!.id).toBe('b-1');
      expect(page.items[9]!.id).toBe('b-10');
      expect(page.page).toBe(1);
      expect(page.perPage).toBe(10);
      expect(page.totalPages).toBe(3);
      expect(page.total).toBe(23);
    });

    it('page 3 of 23 rows @ 10 per page → 3 items (tail)', () => {
      const h = ensureLoaded();
      const page = h.paginateHistory(rows, 3, 10);
      expect(page.items).toHaveLength(3);
      expect(page.items[0]!.id).toBe('b-21');
      expect(page.items[2]!.id).toBe('b-23');
    });

    it('clamps page > totalPages back to last page', () => {
      const h = ensureLoaded();
      const page = h.paginateHistory(rows, 99, 10);
      expect(page.page).toBe(3);
      expect(page.items[0]!.id).toBe('b-21');
    });

    it('clamps page < 1 to 1', () => {
      const h = ensureLoaded();
      const page = h.paginateHistory(rows, 0, 10);
      expect(page.page).toBe(1);
      expect(page.items[0]!.id).toBe('b-1');
    });

    it('empty input → 0 items, 0 totalPages, page=1', () => {
      const h = ensureLoaded();
      const page = h.paginateHistory([], 1, 10);
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
      expect(page.totalPages).toBe(0);
      expect(page.page).toBe(1);
    });

    it('rejects perPage < 1', () => {
      const h = ensureLoaded();
      expect(() => h.paginateHistory(rows, 1, 0)).toThrow();
    });
  });
});
