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
 * Build a SQL `CASE <columnRef> WHEN 'bucket' THEN <ordinal> ... ELSE
 * <sentinel> END` expression as a raw string. `columnRef` MUST be a
 * trusted, code-controlled column reference (e.g. `'np.renewal_tier_bucket'`)
 * — it is interpolated verbatim, so NEVER pass user input here.
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
