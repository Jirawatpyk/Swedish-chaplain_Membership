/**
 * F119 T087 — `getMemberVersionThread` (FR-008, FR-032, FR-007;
 * contracts/portal-eblast-approval-api.md § `GET /api/broadcasts/[id]/versions`).
 *
 * The member side of the history record: the E-Blast's workflow summary,
 * every version the member was SHOWN (their original and each version sent to
 * them), every decision with its reason, and — on the approve-as-submitted
 * path, where no version row exists (R2) — `approvedAsSubmitted` so the
 * history is never blank. Its own record: the audit trail is never read to
 * build it (FR-032).
 *
 * What the member may see is `_member-view.ts`'s one projection: never the
 * unsent working copy, never a staff user (`authoredBy` is `'member'` |
 * `'organisation'`, `approvedAsSubmitted.by` is `'organisation'`).
 *
 * Owning-member rule (FR-013), read in ONE tenant tx: an unknown id (or
 * another tenant's — indistinguishable under RLS) → `not_found`, audited
 * `broadcast_cross_tenant_probe`; another member's → `not_found`, audited
 * `broadcast_cross_member_probe`, and nothing of theirs is read past the
 * broadcast row. Both audits run after the read. Never 403 — no existence
 * leak. Membership standing is not consulted (reading is not a benefit
 * action — spec § Edge Cases).
 *
 * Pure Application — no framework imports.
 */
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { MemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../../domain/broadcast';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastDecisionsRepo } from '../../ports/broadcast-decisions-repo';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import { safeAuditEmitTyped } from '../_safe-audit-emit';
import type { ApprovalBroadcastsRepo } from './_approval-tx';
import {
  isVisibleToMember,
  memberWorkflowSummary,
  projectDecisionForMember,
  projectVersionForMember,
  type MemberVisibleDecision,
  type MemberVisibleVersion,
  type MemberWorkflowSummary,
} from './_member-view';

export interface GetMemberVersionThreadDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx' | 'findByIdInTx'>;
  readonly versionsRepo: Pick<BroadcastVersionsRepo, 'listByBroadcast'>;
  readonly decisionsRepo: Pick<BroadcastDecisionsRepo, 'listByBroadcast'>;
  readonly audit: AuditPort;
}

export interface GetMemberVersionThreadInput {
  readonly broadcastId: BroadcastId;
  /** The caller's member (resolved from the portal session, never the request). */
  readonly memberId: MemberId;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export interface MemberThreadDecision extends MemberVisibleDecision {
  /** True when the caller's own login recorded it (another contact of the company may have). */
  readonly decidedByMe: boolean;
}

export interface MemberVersionThread {
  readonly broadcastId: BroadcastId;
  readonly summary: MemberWorkflowSummary;
  /** v0 and every version sent to the member, oldest first. */
  readonly versions: readonly MemberVisibleVersion[];
  /** Every decision, oldest first. */
  readonly decisions: readonly MemberThreadDecision[];
  /** FR-007 — set only when no version row exists and the E-Blast was approved. */
  readonly approvedAsSubmitted: { readonly at: Date; readonly by: 'organisation' } | null;
}

export type GetMemberVersionThreadError =
  | { readonly kind: 'not_found' }
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

export async function getMemberVersionThread(
  deps: GetMemberVersionThreadDeps,
  input: GetMemberVersionThreadInput,
): Promise<Result<MemberVersionThread, GetMemberVersionThreadError>> {
  const slug = deps.tenant.slug;
  let read;
  try {
    read = await deps.broadcastsRepo.withTx(async (tx) => {
      const broadcast = await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId);
      if (broadcast === null) return { probe: 'cross_tenant' as const };
      if (broadcast.requestedByMemberId !== input.memberId) return { probe: 'cross_member' as const };
      // Sequential on purpose: one tx is one connection.
      const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      const decisions = await deps.decisionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      return { probe: null, broadcast, versions, decisions };
    });
  } catch (e) {
    return err({ kind: 'server_error', errKind: errKind(e) });
  }

  if (read.probe !== null) {
    await emitProbe(deps, input, read.probe);
    return err({ kind: 'not_found' });
  }
  const { broadcast, versions, decisions } = read;
  return ok({
    broadcastId: input.broadcastId,
    summary: memberWorkflowSummary(broadcast),
    versions: versions.filter(isVisibleToMember).map(projectVersionForMember),
    decisions: decisions.map((d) => ({ ...projectDecisionForMember(d), decidedByMe: d.decidedByUserId === input.actorUserId })),
    approvedAsSubmitted:
      versions.length === 0 && broadcast.approvedAt !== null ? { at: broadcast.approvedAt, by: 'organisation' } : null,
  });
}

/**
 * The two probe audits, after the read on their own connection. The
 * cross-member row carries camelCase keys on purpose: a REFUSED probe must
 * never spell `member_id`, the one key the 0009 `last_activity_at` trigger
 * reads — otherwise guessing ids would refresh the probed member's recency.
 */
async function emitProbe(
  deps: GetMemberVersionThreadDeps,
  input: GetMemberVersionThreadInput,
  probe: 'cross_tenant' | 'cross_member',
): Promise<void> {
  if (probe === 'cross_tenant') {
    await emitCrossTenantProbe({
      audit: deps.audit,
      tenantId: deps.tenant.slug,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'get-member-version-thread' },
    });
    return;
  }
  await safeAuditEmitTyped(deps.audit, null, {
    eventType: 'broadcast_cross_member_probe',
    tenantId: deps.tenant.slug,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    summary: `Member ${input.memberId} tried to read the version thread of broadcast ${input.broadcastId} owned by another member`,
    payload: { probedMemberId: input.memberId, probedBroadcastId: input.broadcastId as string, operation: 'version_thread' },
  });
}
