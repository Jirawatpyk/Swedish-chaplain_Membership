/**
 * F119 T055 — `BroadcastDecisionsRepo` Application port (data-model § 2).
 *
 * The member's decisions on a version — APPEND-ONLY. There is no update and
 * no delete method on this port, by construction: the table's
 * `broadcast_member_decisions_append_only_fn` trigger refuses both (only the
 * erasure GUC may rewrite `reason`, and that redaction is T082's port, not
 * this one). A decision row is SC-002's proof of who approved which version,
 * so it must outlive every later change to the E-Blast.
 *
 * Every method runs on the caller's `runInTenant` `tx` — REQUIRED, never the
 * pool-global `db` (RLS bypass).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { MemberDecision, MemberDecisionKind } from '../../domain/approval/member-decision';

/** Opaque tx handle from `BroadcastsRepo.withTx`. */
export type BroadcastDecisionsTx = unknown;

export interface NewMemberDecision {
  readonly broadcastId: BroadcastId;
  readonly versionId: string;
  readonly round: number;
  readonly decision: MemberDecisionKind;
  readonly reason: string | null;
  readonly decidedByUserId: string;
  readonly decidedByContactId: string;
}

export interface BroadcastDecisionsRepo {
  /** Append one decision; returns it with its generated id and `decidedAt`. */
  insert(
    tenantId: TenantSlug,
    input: NewMemberDecision,
    tx: BroadcastDecisionsTx,
  ): Promise<MemberDecision>;

  /** Every decision on one E-Blast, oldest first — the history thread (FR-032). */
  listByBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    tx: BroadcastDecisionsTx,
  ): Promise<readonly MemberDecision[]>;
}
