/**
 * COMP-1 US3-D — the DPO erasure-evidence read port.
 *
 * Backs the read-only admin "erasure evidence" page (`getErasureEvidenceLog`
 * use-case, US3-D Task 3). For ONE erased member it returns every Art.17
 * evidence event: the tenant-scoped erasure lifecycle (`member_erasure_
 * requested` / `member_erased` / `event_buyer_pii_redacted` / `subprocessor_
 * erasure_propagated`, matched by `payload->>'member_id'`) UNIONed with the
 * tenant-NULL F1 `user_erased` identity proof (matched by `target_user_id`).
 *
 * ⚠️ SECURITY-CRITICAL (PERMISSIVE-RLS hazard). The `audit_log_tenant_
 * isolation` RLS policy is PERMISSIVE (`tenant_id IS NULL OR tenant_id =
 * current_setting('app.current_tenant')`, migration 0007), so tenant-NULL
 * rows (the F1 `user_erased` events) are visible to EVERY tenant at the DB
 * layer — the ONLY cross-tenant wall is the app-layer `tenant_id = ctx.slug`
 * predicate. The `user_erased` arm DELIBERATELY removes that wall for ONE
 * event, so it MUST be bounded by `target_user_id = ANY(<member's own linked
 * users>)` and DROPPED ENTIRELY when that set is empty (FIX-1). See the
 * adapter (`infrastructure/db/erasure-evidence-repo.ts`) for the enforcement.
 */
import type { TenantContext } from '@/modules/tenants';

/**
 * Canonical `audit_log.event_type` names the US3-D evidence read folds over
 * (S-2). Both the SECURITY-CRITICAL adapter allow-list (`erasure-evidence-
 * repo.ts`) AND the insights fold (`erasure-evidence.ts`) reference these — a
 * typo would otherwise silently yield no rows with no compile error. The four
 * tenant-scoped lifecycle events are matched by `payload->>'member_id'`; the
 * tenant-NULL F1 `user_erased` proof is matched by `target_user_id`.
 *
 * The adapter's `TENANT_SCOPED_ERASURE_EVENTS` allow-list remains the single
 * source of WHICH events the query fetches; these constants make the references
 * to each name compile-checked.
 */
export const ERASURE_EVIDENCE_EVENTS = {
  /** US3-A Art.12 attestation (reason + identity verification + note). */
  requested: 'member_erasure_requested',
  /** Cascade completion proof (sessions/invitations revoked + re_drive). */
  erased: 'member_erased',
  /** US3-B tax-document PII redaction (invoice / credit_note discriminator). */
  taxRedacted: 'event_buyer_pii_redacted',
  /** US3-C sub-processor (Resend) propagation outcome. */
  subprocessorPropagated: 'subprocessor_erasure_propagated',
  /** F1 tenant-NULL credential-erasure identity proof. */
  userErased: 'user_erased',
} as const;

export type ErasureEvidenceEventType =
  (typeof ERASURE_EVIDENCE_EVENTS)[keyof typeof ERASURE_EVIDENCE_EVENTS];

/** One evidence row — a projection of the underlying `audit_log` row. */
export interface ErasureEvidenceRow {
  readonly id: string;
  /**
   * `member_erasure_requested` | `member_erased` | `event_buyer_pii_redacted`
   * | `subprocessor_erasure_propagated` | `user_erased`.
   */
  readonly eventType: string;
  readonly occurredAtIso: string;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly payload: Record<string, unknown> | null;
}

export interface ErasureEvidenceReadPort {
  /**
   * Read ONE member's full erasure evidence.
   *
   * `memberLinkedUserIds` MUST be the member's OWN linked user ids (resolved
   * upstream via the members barrel `listMemberLinkedUserIds`). When EMPTY,
   * the tenant-NULL `user_erased` arm is DROPPED — the query issues NO
   * unbounded tenant-NULL read (FIX-1).
   */
  readForMember(
    ctx: TenantContext,
    memberId: string,
    memberLinkedUserIds: readonly string[],
  ): Promise<readonly ErasureEvidenceRow[]>;
}
