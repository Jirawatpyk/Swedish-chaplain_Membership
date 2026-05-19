/**
 * T034 — `RetentionSweeper` Application port (F6).
 *
 * Drives the two F6 retention cron passes:
 *   1. PII pseudonymisation sweep (FR-032 / SC-011 / Phase 10 T113) —
 *      replaces attendee_email/name/company on non-member rows older
 *      than 2 years with deterministic salted SHA-256 hashes; preserves
 *      quota + match-link metadata for forensic forensics.
 *   2. Idempotency-receipt TTL sweep (Phase 10 T115) —
 *      deletes `eventcreate_idempotency_receipts` rows where
 *      `ttl_expires_at < NOW()` to keep the table bounded at ~200
 *      in-flight rows.
 *
 * Both sweeps follow the multi-tenant iteration pattern per research.md
 * R9: super-admin enumeration of all tenants → `runInTenant(ctx, fn)`
 * per tenant → SELECT eligible rows → mutate → emit audit.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';

export interface PseudonymiseStaleNonMemberInput {
  readonly tenantId: TenantId;
  /** Cut-off date — registrations older than this AND non-member type get pseudonymised. */
  readonly olderThan: Date;
  /** Page size for the eligibility scan (defaults to 500 per pass per research.md R9). */
  readonly pageSize?: number;
}

export interface PseudonymiseStaleNonMemberResult {
  readonly rowsScanned: number;
  readonly rowsPseudonymised: number;
  readonly durationMs: number;
}

export interface SweepIdempotencyReceiptsInput {
  readonly tenantId: TenantId;
  /** Cut-off — rows with `ttl_expires_at < cutoff` are deleted. */
  readonly cutoff: Date;
}

export interface SweepIdempotencyReceiptsResult {
  readonly rowsDeleted: number;
  readonly durationMs: number;
}

export type RetentionSweeperError =
  | { readonly kind: 'db_error'; readonly message: string }
  | { readonly kind: 'missing_pseudonym_salt' };

export interface RetentionSweeper {
  /**
   * Sweep one tenant's non-member registrations past the 2y retention
   * threshold. Idempotent — re-running on already-pseudonymised rows is
   * a no-op (the eligibility filter excludes rows where
   * piiPseudonymisedAt IS NOT NULL).
   *
   * REJECTS the operation with `missing_pseudonym_salt` error when
   * `env.eventcreate.piiPseudonymSalt === null` so a misconfigured
   * deployment never silently produces null-salt pseudonyms.
   */
  pseudonymiseStaleNonMember(
    input: PseudonymiseStaleNonMemberInput,
  ): Promise<Result<PseudonymiseStaleNonMemberResult, RetentionSweeperError>>;

  /**
   * Sweep one tenant's idempotency receipts past their TTL. The partial
   * index `eventcreate_idempotency_receipts_ttl_idx` keeps the scan
   * bounded to rows nearing expiry.
   */
  sweepIdempotencyReceipts(
    input: SweepIdempotencyReceiptsInput,
  ): Promise<Result<SweepIdempotencyReceiptsResult, RetentionSweeperError>>;
}
