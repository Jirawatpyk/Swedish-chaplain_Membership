/**
 * 063-renewal-audit-fixes — unit tests for the shared at-risk
 * tier-downgrade SQL fragment (`tier-bucket-ordinal-sql.ts`).
 *
 * Both at-risk scorers (single-member `drizzle-at-risk-scorer.ts` + batch
 * `drizzle-member-renewal-flags-repo.ts`) embed this fragment so they
 * cannot drift on the definition of a tier downgrade (a move to a lower
 * tier BUCKET ordinal, NOT a fee decrease). These tests lock:
 *   - the CASE expression is derived from the canonical Domain
 *     TIER_BUCKETS tuple (so a reorder is caught here, not at runtime),
 *   - unknown / NULL buckets map to a sentinel ABOVE every known bucket
 *     (so an orphan bucket never reads as "lower than" a known one),
 *   - the downgrade predicate composes new-ordinal < old-ordinal.
 */
import { describe, expect, it } from 'vitest';
import { TIER_BUCKETS } from '@/modules/renewals/domain/value-objects/tier-bucket';
import {
  tierBucketOrdinalCaseSql,
  tierBucketDowngradePredicateSql,
} from '@/modules/renewals/infrastructure/drizzle/tier-bucket-ordinal-sql';

describe('tierBucketOrdinalCaseSql', () => {
  it('emits a WHEN clause for every canonical bucket, in tuple order', () => {
    const sql = tierBucketOrdinalCaseSql('np.renewal_tier_bucket');
    TIER_BUCKETS.forEach((bucket, ordinal) => {
      expect(sql).toContain(`WHEN '${bucket}' THEN ${ordinal}`);
    });
  });

  it('interpolates the provided column reference verbatim', () => {
    expect(tierBucketOrdinalCaseSql('p_old.renewal_tier_bucket')).toContain(
      'CASE p_old.renewal_tier_bucket',
    );
  });

  it('maps unknown / NULL buckets to a sentinel above every known ordinal', () => {
    const sql = tierBucketOrdinalCaseSql('t.col');
    // ELSE sentinel === tuple length, strictly greater than the max known
    // ordinal (length - 1), so an unknown bucket never sorts BELOW a
    // known one — i.e. it can never falsely register as a downgrade.
    expect(sql).toContain(`ELSE ${TIER_BUCKETS.length}`);
    expect(TIER_BUCKETS.length).toBeGreaterThan(TIER_BUCKETS.length - 1);
  });

  it('orders the canonical buckets thai_alumni < start_up < regular < premium < partnership', () => {
    // Guards the FR-029 downgrade semantics: this is the ordering the two
    // scorers compare against. A reorder of TIER_BUCKETS would silently
    // change which transitions count as downgrades.
    expect([...TIER_BUCKETS]).toEqual([
      'thai_alumni',
      'start_up',
      'regular',
      'premium',
      'partnership',
    ]);
  });
});

describe('tierBucketDowngradePredicateSql', () => {
  it('composes new-bucket ordinal < old-bucket ordinal', () => {
    const sql = tierBucketDowngradePredicateSql(
      'np.renewal_tier_bucket',
      'op.renewal_tier_bucket',
    );
    expect(sql).toContain('CASE np.renewal_tier_bucket');
    expect(sql).toContain('CASE op.renewal_tier_bucket');
    // The new-ordinal CASE must appear on the LEFT of the `<` (a downgrade
    // = lower NEW ordinal than OLD ordinal).
    const newIdx = sql.indexOf('np.renewal_tier_bucket');
    const ltIdx = sql.indexOf('<');
    const oldIdx = sql.indexOf('op.renewal_tier_bucket');
    expect(newIdx).toBeLessThan(ltIdx);
    expect(ltIdx).toBeLessThan(oldIdx);
  });
});

describe('tierBucketOrdinalCaseSql — columnRef SQL-injection guard', () => {
  it('accepts the qualified column references the real callers pass', () => {
    // The exact literals threaded by the two scorers
    // (drizzle-at-risk-scorer + drizzle-member-renewal-flags-repo).
    for (const ref of [
      'np.renewal_tier_bucket',
      'op.renewal_tier_bucket',
      'p_new.renewal_tier_bucket',
      'p_old.renewal_tier_bucket',
    ]) {
      expect(() => tierBucketOrdinalCaseSql(ref)).not.toThrow();
    }
  });

  it('rejects an unqualified identifier (no table prefix)', () => {
    expect(() => tierBucketOrdinalCaseSql('renewal_tier_bucket')).toThrow(
      /untrusted columnRef/,
    );
  });

  it('rejects a dynamic / user-controlled SQL-injection string', () => {
    expect(() =>
      tierBucketOrdinalCaseSql("np.bucket; DROP TABLE members; --"),
    ).toThrow(/untrusted columnRef/);
    expect(() =>
      tierBucketOrdinalCaseSql("(SELECT secret FROM tenants)"),
    ).toThrow(/untrusted columnRef/);
    expect(() => tierBucketOrdinalCaseSql('np.col OR 1=1')).toThrow(
      /untrusted columnRef/,
    );
  });

  it('rejects whitespace, quoting, and empty input', () => {
    for (const bad of ['', ' np.col', 'np.col ', '"np"."col"', 'np .col']) {
      expect(() => tierBucketOrdinalCaseSql(bad)).toThrow(/untrusted columnRef/);
    }
  });

  it('propagates the guard through tierBucketDowngradePredicateSql', () => {
    // The predicate builds two CASE expressions; a bad ref on EITHER
    // side must throw (the guard fires inside tierBucketOrdinalCaseSql).
    expect(() =>
      tierBucketDowngradePredicateSql('np.col; --', 'op.renewal_tier_bucket'),
    ).toThrow(/untrusted columnRef/);
    expect(() =>
      tierBucketDowngradePredicateSql('np.renewal_tier_bucket', 'bad ref'),
    ).toThrow(/untrusted columnRef/);
  });
});
