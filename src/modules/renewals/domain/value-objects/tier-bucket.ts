/**
 * T030 (F8 Phase 2 Wave D) — `TierBucket` Domain value object.
 *
 * 5-value tier-bucket constant tuple per /speckit.clarify Q2 round 1
 * (5 fixed buckets). Mirrors the F2 `membership_plans.renewal_tier_bucket`
 * column (data-model.md § 3.2 — DB CHECK constraint enforces the same set)
 * and the F8 `tenant_renewal_schedule_policies.tier_bucket` PK part
 * (data-model.md § 2.4).
 *
 * Domain owns the parser + canonical list. Infrastructure schemas
 * narrow to the same literal union via `text(...)` columns + DB CHECK.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export const TIER_BUCKETS = [
  'thai_alumni',
  'start_up',
  'regular',
  'premium',
  'partnership',
] as const;

export type TierBucket = (typeof TIER_BUCKETS)[number];

export type TierBucketError = {
  readonly kind: 'invalid_tier_bucket';
  readonly raw: string;
};

/** Unchecked cast — use only in trusted contexts (DB row mapping, fixtures). */
export function asTierBucket(raw: string): TierBucket {
  return raw as TierBucket;
}

/** Validating parser — preferred for untrusted input (request bodies). */
export function parseTierBucket(raw: string): Result<TierBucket, TierBucketError> {
  if ((TIER_BUCKETS as readonly string[]).includes(raw)) {
    return ok(raw as TierBucket);
  }
  return err({ kind: 'invalid_tier_bucket', raw });
}

/** Runtime narrowing predicate. */
export function isTierBucket(value: unknown): value is TierBucket {
  return (
    typeof value === 'string' &&
    (TIER_BUCKETS as readonly string[]).includes(value)
  );
}
