/**
 * 063-renewal-audit-fixes — shared SQL fragment for the at-risk
 * tier-downgrade factor (FR-029 line 8).
 *
 * A "tier downgrade" is a move to a lower tier BUCKET — NOT merely an
 * annual-fee decrease (a same-bucket fee cut via custom pricing /
 * override is NOT a downgrade). The canonical bucket ordering is the
 * Domain `TIER_BUCKETS` tuple (`value-objects/tier-bucket.ts`); this
 * helper derives the SQL `CASE ... WHEN ... THEN <ordinal> END`
 * expression from that single source so the two at-risk scorers (the
 * single-member `drizzle-at-risk-scorer.ts` + the batch
 * `drizzle-member-renewal-flags-repo.ts`) cannot drift apart.
 *
 * Unknown / NULL bucket values map to a high sentinel (length of the
 * tuple) so they never read as "lower than" a known bucket — i.e. an
 * orphan or corrupt bucket value is treated as "not a downgrade",
 * matching the batch's prior `ELSE 99` behaviour.
 *
 * The inverse direction (old=unknown sentinel → new=known ordinal)
 * cannot produce a false downgrade either: the sentinel ordinal sits
 * strictly above every known ordinal, so `new < old` (= "downgrade")
 * would require `new` to be above all known ordinals — impossible for
 * a valid bucket. As an additional safety net, the DB CHECK constraint
 * `membership_plans_renewal_tier_bucket_check` rejects non-null bucket
 * values that are not in the `TIER_BUCKETS` tuple, so a corrupt-but-
 * non-null value cannot reach this expression in production.
 *
 * Infrastructure-only: returns a raw SQL string fragment for embedding
 * into a `sql`` template. The caller substitutes the column reference
 * (`p_new.renewal_tier_bucket` / `np.renewal_tier_bucket`).
 */
import { TIER_BUCKETS } from '../../domain/value-objects/tier-bucket';

/**
 * High sentinel ordinal for unknown / NULL buckets. Equal to the tuple
 * length so it sorts strictly ABOVE every known bucket (0..n-1).
 */
const UNKNOWN_BUCKET_ORDINAL = TIER_BUCKETS.length;

/**
 * Strict allowlist for a qualified SQL column reference: a `table.column`
 * pair, each part an identifier (`[a-z_][a-z0-9_]*`). This is the ONLY
 * shape the current callers pass (e.g. `np.renewal_tier_bucket`). The
 * runtime guard below rejects anything else (whitespace, quotes, dots
 * elsewhere, parentheses, etc.) so a future caller that accidentally
 * threads a dynamic / user-controlled string fails LOUDLY at call time
 * rather than silently interpolating a SQL-injection vector — static
 * analysis cannot catch a raw-string interpolation, so we guard at runtime.
 */
const QUALIFIED_COLUMN_REF = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i;

/**
 * Assert that a `columnRef` is a trusted qualified column reference
 * (`table.column`). Throws a clear error on anything else.
 */
function assertTrustedColumnRef(columnRef: string): void {
  if (!QUALIFIED_COLUMN_REF.test(columnRef)) {
    throw new Error(
      `tierBucketOrdinalCaseSql: untrusted columnRef ${JSON.stringify(
        columnRef,
      )} — expected a qualified column reference (table.column). ` +
        `This value is interpolated verbatim into raw SQL; dynamic / ` +
        `user-controlled strings are a SQL-injection vector and are rejected.`,
    );
  }
}

/**
 * Build a SQL `CASE <columnRef> WHEN 'bucket' THEN <ordinal> ... ELSE
 * <sentinel> END` expression as a raw string. `columnRef` MUST be a
 * trusted, code-controlled qualified column reference (e.g.
 * `'np.renewal_tier_bucket'`) — it is interpolated verbatim, so NEVER
 * pass user input here. A runtime guard (`assertTrustedColumnRef`)
 * rejects anything that is not a bare `table.column` reference.
 *
 * Example output (with the current 5-bucket tuple):
 *   CASE np.renewal_tier_bucket
 *     WHEN 'thai_alumni' THEN 0
 *     WHEN 'start_up'    THEN 1
 *     WHEN 'regular'     THEN 2
 *     WHEN 'premium'     THEN 3
 *     WHEN 'partnership' THEN 4
 *     ELSE 5
 *   END
 */
export function tierBucketOrdinalCaseSql(columnRef: string): string {
  assertTrustedColumnRef(columnRef);
  const whenClauses = TIER_BUCKETS.map(
    (bucket, ordinal) => `WHEN '${bucket}' THEN ${ordinal}`,
  ).join(' ');
  return `CASE ${columnRef} ${whenClauses} ELSE ${UNKNOWN_BUCKET_ORDINAL} END`;
}

/**
 * Predicate fragment: "the NEW bucket ordinal is strictly lower than the
 * OLD bucket ordinal" = a tier downgrade. `newColumnRef` / `oldColumnRef`
 * are trusted, code-controlled column references.
 */
export function tierBucketDowngradePredicateSql(
  newColumnRef: string,
  oldColumnRef: string,
): string {
  return `${tierBucketOrdinalCaseSql(newColumnRef)} < ${tierBucketOrdinalCaseSql(
    oldColumnRef,
  )}`;
}
