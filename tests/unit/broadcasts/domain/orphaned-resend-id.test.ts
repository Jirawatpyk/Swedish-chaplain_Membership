/**
 * Spec 140 s2d (#736b) — the one stuck rule of a tenant audience orphan:
 * `attempts >= ORPHAN_STUCK_ATTEMPTS` AND `created_at` at or before
 * `orphanStuckCutoff(at)` (`ORPHAN_STUCK_MIN_AGE_MS` earlier). Pass (b) judges
 * it in JS (`isOrphanStuck`); both repos judge it in SQL from the same cutoff
 * (`orphanStuckSql`, which truncates `created_at` to milliseconds — the
 * precision the driver hands the app).
 */
import { describe, expect, it } from 'vitest';
import {
  ORPHAN_STUCK_ATTEMPTS,
  ORPHAN_STUCK_MIN_AGE_MS,
  isOrphanStuck,
  orphanStuckCutoff,
} from '@/modules/broadcasts/domain/value-objects/orphaned-resend-id';

const AT = Date.parse('2026-11-04T12:00:00.000Z');
const row = (attempts: number, createdAtMs: number) => ({ attempts, createdAt: new Date(createdAtMs) });

describe('isOrphanStuck / orphanStuckCutoff (spec 140 s2d #736b)', () => {
  it('the cutoff is ORPHAN_STUCK_MIN_AGE_MS before the instant', () => {
    expect(orphanStuckCutoff(new Date(AT)).getTime()).toBe(AT - ORPHAN_STUCK_MIN_AGE_MS);
  });

  it('is stuck at exactly ORPHAN_STUCK_ATTEMPTS tries and exactly the minimum age', () => {
    expect(isOrphanStuck(row(ORPHAN_STUCK_ATTEMPTS, AT - ORPHAN_STUCK_MIN_AGE_MS), AT)).toBe(true);
  });

  it('is not stuck one millisecond short of the minimum age', () => {
    expect(isOrphanStuck(row(ORPHAN_STUCK_ATTEMPTS, AT - ORPHAN_STUCK_MIN_AGE_MS + 1), AT)).toBe(false);
  });

  it('is not stuck one try short, however old', () => {
    expect(isOrphanStuck(row(ORPHAN_STUCK_ATTEMPTS - 1, AT - 100 * ORPHAN_STUCK_MIN_AGE_MS), AT)).toBe(false);
  });

  it('a created_at 0.4 ms past the cutoff is truncated to the cutoff, so it is stuck', () => {
    // `Date` clips fractional milliseconds, as SQL date_trunc('milliseconds') does.
    expect(isOrphanStuck(row(ORPHAN_STUCK_ATTEMPTS, AT - ORPHAN_STUCK_MIN_AGE_MS + 0.4), AT)).toBe(true);
  });

  it('agrees with created_at <= orphanStuckCutoff(at) for a tried-enough row', () => {
    const cutoff = orphanStuckCutoff(new Date(AT)).getTime();
    for (const delta of [-60_000, -1, 0, 1, 60_000]) {
      const o = row(ORPHAN_STUCK_ATTEMPTS + 3, cutoff + delta);
      expect(isOrphanStuck(o, AT)).toBe(o.createdAt.getTime() <= cutoff);
    }
  });
});
