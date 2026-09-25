/**
 * F119 T078 — `recordMemberDecision` (US1-AS4, US2, FR-009, FR-010, FR-013,
 * FR-015, FR-015a, FR-021, FR-033; contracts/portal-eblast-approval-api.md
 * § `POST …/[id]/decision`, dashboard-and-notifications.md §§ 2–3).
 *
 * The member's decision on the version they were shown — one of three arms:
 *
 *   approved            awaiting_member_approval → member_approved;
 *                       `approved_version_id` = the version
 *   changes_requested   awaiting_member_approval → changes_requested;
 *                       the reminder clock reset (`member_reminder_stage = 0`)
 *   approval_withdrawn  member_approved | approved → changes_requested;
 *                       `approved_version_id` AND `scheduled_for` cleared
 *                       (trigger exemption E2 — "a confirmed schedule is
 *                       cancelled")
 *
 * The reason is checked FIRST, before any lock (Domain `validateDecisionReason`
 * — a blank reason is no reason: NULL for an approval note, `reason_required`
 * otherwise). Then ONE tenant tx with throw-to-rollback (`_approval-tx.ts`):
 *
 *   1. Re-read the broadcast `FOR UPDATE`. Unknown (or another tenant's —
 *      indistinguishable under RLS) → `not_found`, audited
 *      `broadcast_cross_tenant_probe`; another member's → `not_found`,
 *      audited `broadcast_cross_member_probe` (never 403 — no existence
 *      leak). Both audits run AFTER the rollback.
 *   2. The stage, from THAT read. A withdrawal is checked for the `sending`
 *      cut-off FIRST (`sending` also fails the stage rule, and the member must
 *      be told the send is under way, not that "the stage changed") — and so
 *      is an `approved` row the dispatcher has already handed over
 *      (`hasDispatchBegun`, T166 R-H1). A stage
 *      refusal carries the decision already recorded, so a repeated click is
 *      answered with what happened (research R19 — not a replay).
 *   3. The version: it must be the latest version SENT to the member, else
 *      `stale_version` carrying the current one.
 *   4. The decision row (append-only), the transition with `stage_entered_at`,
 *      the audit row (snake_case `member_id` — member activity, the 0009
 *      trigger key; lengths, never text), and one
 *      `eblast_member_decided_marketing` outbox row PER marketing recipient
 *      (FR-021a), ids only, on the same tx. The enqueue is unconditional —
 *      the flag lives at the drainer (T152a). The roster itself is read
 *      BEFORE the tx (T166 R-L3), and an empty one is reported after the
 *      commit, so a refused decision is never counted.
 *
 * Membership standing is NOT consulted: reading and deciding on a pending
 * version are not benefit actions (spec § Edge Cases); the existing refusals
 * apply at send time.
 *
 * The counter is emitted after the commit; the route owns the span and the
 * duration histogram. 100 % branch pinned. Pure Application — no framework
 * imports.
 */
import { broadcastsMetrics } from '@/lib/metrics';
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { MemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId, BroadcastVersionId } from '../../../domain/broadcast';
import type { BroadcastVersion } from '../../../domain/approval/broadcast-version';
import {
  validateDecisionReason,
  type MemberDecision,
  type MemberDecisionKind,
  type ReasonBounds,
} from '../../../domain/approval/member-decision';
import { hasDispatchBegun, hasSendingStarted } from '../../../domain/stage/in-progress-statuses';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastDecisionsRepo } from '../../ports/broadcast-decisions-repo';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { EblastNotificationOutboxPort } from '../../ports/eblast-notification-outbox-port';
import type { MarketingDirectoryPort, MarketingRecipient } from '../../ports/marketing-directory-port';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import { safeAuditEmitTyped } from '../_safe-audit-emit';
import { ApprovalRefusal, isOwnRefusal, type ApprovalBroadcastsRepo } from './_approval-tx';

export interface RecordMemberDecisionDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: ApprovalBroadcastsRepo;
  readonly versionsRepo: Pick<BroadcastVersionsRepo, 'listByBroadcast'>;
  readonly decisionsRepo: BroadcastDecisionsRepo;
  readonly marketingDirectory: MarketingDirectoryPort;
  readonly outbox: EblastNotificationOutboxPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface RecordMemberDecisionInput {
  readonly broadcastId: BroadcastId;
  /** The caller's member (resolved from the portal session, never the body). */
  readonly memberId: MemberId;
  readonly actorUserId: string;
  /** The session role, recorded as-is (the route passes `role ?? null`), never a literal. */
  readonly actorRole: string | null;
  /** The caller's own contact — `decided_by_contact_id` (SC-002: who approved). */
  readonly contactId: string;
  readonly versionId: BroadcastVersionId;
  readonly decision: MemberDecisionKind;
  /** The approval note (optional) or the reason (mandatory for the other two). */
  readonly reason: string | null;
  readonly requestId: string | null;
}

export interface RecordMemberDecisionOutput {
  /**
   * The new status — `member_approved` or `changes_requested`. Named
   * `status`, not `stage` (#400 item 6): its values are statuses, and the
   * same endpoint's 409 `details.stage` speaks the `stageOf` vocabulary.
   */
  readonly status: 'member_approved' | 'changes_requested';
  readonly whoseTurn: 'marketing';
  readonly round: number;
  readonly decision: MemberDecision;
}

export type RecordMemberDecisionError =
  | { readonly kind: 'reason_required' }
  | { readonly kind: 'reason_too_long'; readonly max: ReasonBounds['max'] }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'sending_started'; readonly status: BroadcastStatus }
  | {
      readonly kind: 'stage_changed';
      readonly status: BroadcastStatus;
      /** The latest decision on the E-Blast, if any — what the repeat is answered with. */
      readonly recorded: MemberDecision | null;
    }
  | {
      readonly kind: 'stale_version';
      readonly current: { readonly id: string; readonly versionNo: number } | null;
    }
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

/** A refusal that is audited after the rollback, never returned as-is. */
type ProbeRefusal = { readonly kind: 'probe'; readonly probe: 'cross_tenant' | 'cross_member' };
/** What this use case throws as an `ApprovalRefusal` (`_approval-tx.ts` `RefusalByUseCase`). */
export type RecordMemberDecisionRefusal =
  | Exclude<RecordMemberDecisionError, { kind: 'not_found' | 'server_error' }>
  | ProbeRefusal;
type Refusal = RecordMemberDecisionRefusal;

export async function recordMemberDecision(
  deps: RecordMemberDecisionDeps,
  input: RecordMemberDecisionInput,
): Promise<Result<RecordMemberDecisionOutput, RecordMemberDecisionError>> {
  const slug = deps.tenant.slug;
  // A blank reason is no reason (the Domain decides): NULL for an approval
  // note, `reason_required` for the other two.
  const reason = validateDecisionReason(input.decision, input.reason);
  if (!reason.ok) {
    return err(reason.error.code === 'reason_too_long' ? { kind: 'reason_too_long', max: reason.error.max } : { kind: 'reason_required' });
  }

  let decided: RecordMemberDecisionOutput;
  let roster: readonly MarketingRecipient[];
  try {
    // T166 R-L3 — the hand-off roster is read BEFORE the tx: a pool-global
    // read (`users` is cross-tenant) must not hold a second connection while
    // this tx holds the row lock. Its empty-roster count is paid below, only
    // for a decision that committed.
    roster = await deps.marketingDirectory.readRoster();
    decided = await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.lockForUpdate(tx, slug, input.broadcastId);
      const broadcast =
        (await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId)) ?? refuse({ kind: 'probe', probe: 'cross_tenant' });
      if (broadcast.requestedByMemberId !== input.memberId) refuse({ kind: 'probe', probe: 'cross_member' });

      const status = broadcast.status;
      if (input.decision === 'approval_withdrawn') {
        if (hasSendingStarted(status)) refuse({ kind: 'sending_started', status });
        // T166 R-H1 — `approved` but already handed over: the dispatch leg
        // commits its lock before calling Resend, so the send is under way
        // although the status has not moved yet.
        if (status === 'approved' && hasDispatchBegun(broadcast)) refuse({ kind: 'sending_started', status });
        if ((status !== 'member_approved' && status !== 'approved') || broadcast.currentRound < 1) {
          throw await stageChangedRefusal(deps, tx, input.broadcastId, status);
        }
      } else if (status !== 'awaiting_member_approval') {
        throw await stageChangedRefusal(deps, tx, input.broadcastId, status);
      }

      const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      const current = latestSentVersion(versions);
      if (current === null || current.id !== input.versionId) {
        refuse({ kind: 'stale_version', current: current && { id: current.id, versionNo: current.versionNo } });
      }
      const round = broadcast.currentRound;
      const now = deps.clock.now();

      const decision = await deps.decisionsRepo.insert(
        slug,
        {
          broadcastId: input.broadcastId,
          versionId: input.versionId,
          round,
          decision: input.decision,
          reason: reason.value,
          decidedByUserId: input.actorUserId,
          decidedByContactId: input.contactId,
        },
        tx,
      );

      const common = {
        member_id: broadcast.requestedByMemberId,
        broadcast_id: input.broadcastId as string,
        version_id: input.versionId,
        round,
        actor_role: input.actorRole,
      };
      const reasonLength = [...(reason.value ?? '')].length;
      const audit = { tenantId: slug, requestId: input.requestId, actorUserId: input.actorUserId };
      let target: RecordMemberDecisionOutput['status'];
      switch (input.decision) {
        case 'approved':
          target = 'member_approved';
          await deps.broadcastsRepo.applyTransition(tx, slug, input.broadcastId, target, { stageEnteredAt: now, approvedVersionId: input.versionId }, status);
          await deps.audit.emitTyped(tx, {
            ...audit,
            eventType: 'broadcast_member_approved',
            summary: `E-Blast ${input.broadcastId} version ${round} approved by the member`,
            payload: { ...common, note_length: reasonLength },
          });
          break;
        case 'changes_requested':
          target = 'changes_requested';
          await deps.broadcastsRepo.applyTransition(tx, slug, input.broadcastId, target, { stageEnteredAt: now, memberReminderStage: 0 }, status);
          await deps.audit.emitTyped(tx, {
            ...audit,
            eventType: 'broadcast_member_changes_requested',
            summary: `E-Blast ${input.broadcastId} version ${round}: the member requested changes`,
            payload: { ...common, reason_length: reasonLength },
          });
          break;
        case 'approval_withdrawn':
          target = 'changes_requested';
          await deps.broadcastsRepo.applyTransition(
            tx,
            slug,
            input.broadcastId,
            target,
            { stageEnteredAt: now, approvedVersionId: null, scheduledFor: null },
            status,
          );
          await deps.audit.emitTyped(tx, {
            ...audit,
            eventType: 'broadcast_member_approval_withdrawn',
            summary: `E-Blast ${input.broadcastId} version ${round}: the member withdrew their approval`,
            payload: { ...common, reason_length: reasonLength, cancelled_schedule_at: broadcast.scheduledFor?.toISOString() ?? null },
          });
          break;
      }

      // FR-021 — the hand-off to marketing, one row per recipient, ids only,
      // to the roster read before the tx (T166 R-L3).
      for (const recipient of roster) {
        await deps.outbox.enqueueInTx(tx, deps.tenant, {
          type: 'eblast_member_decided_marketing',
          toEmail: recipient.email,
          locale: recipient.locale,
          contextData: {
            tenantId: slug,
            broadcastId: input.broadcastId as string,
            versionId: input.versionId,
            round,
            decision: input.decision,
            recipientUserId: recipient.userId,
          },
        });
      }

      return { status: target, whoseTurn: 'marketing' as const, round, decision };
    });
  } catch (e) {
    if (!(e instanceof ApprovalRefusal)) return err({ kind: 'server_error', errKind: errKind(e) });
    // #400 item 5 — a refusal another use case raised is not ours to map.
    if (!isOwnRefusal(e, 'record-member-decision')) throw e;
    const refusal = e.refusal;
    if (refusal.kind !== 'probe') return err(refusal);
    await emitProbe(deps, input, refusal.probe);
    return err({ kind: 'not_found' });
  }

  broadcastsMetrics.memberDecision(slug, input.decision);
  if (roster.length === 0) deps.marketingDirectory.reportEmptyRoster();
  return ok(decided);
}

/** The highest-numbered version the member has been SENT — the one a decision must name. */
function latestSentVersion(versions: readonly BroadcastVersion[]): BroadcastVersion | null {
  return versions.reduce<BroadcastVersion | null>(
    (latest, v) => (v.versionNo >= 1 && v.sentToMemberAt !== null && (latest === null || v.versionNo > latest.versionNo) ? v : latest),
    null,
  );
}

/** `stage_changed`, carrying the decision already recorded (the answer to a repeat) — for the caller to throw. */
async function stageChangedRefusal(
  deps: RecordMemberDecisionDeps,
  tx: unknown,
  broadcastId: BroadcastId,
  status: BroadcastStatus,
): Promise<ApprovalRefusal<'record-member-decision'>> {
  const decisions = await deps.decisionsRepo.listByBroadcast(deps.tenant.slug, broadcastId, tx);
  return new ApprovalRefusal('record-member-decision', { kind: 'stage_changed', status, recorded: decisions.at(-1) ?? null });
}

/**
 * The two probe audits, after the rollback on their own connection. The
 * cross-member row carries camelCase keys on purpose: a REFUSED probe must
 * never spell `member_id`, the one key the 0009 `last_activity_at` trigger
 * reads — otherwise guessing ids would refresh the probed member's recency.
 */
async function emitProbe(
  deps: RecordMemberDecisionDeps,
  input: RecordMemberDecisionInput,
  probe: ProbeRefusal['probe'],
): Promise<void> {
  if (probe === 'cross_tenant') {
    await emitCrossTenantProbe({
      audit: deps.audit,
      tenantId: deps.tenant.slug,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'record-member-decision' },
    });
    return;
  }
  await safeAuditEmitTyped(deps.audit, null, {
    eventType: 'broadcast_cross_member_probe',
    tenantId: deps.tenant.slug,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    summary: `Member ${input.memberId} tried to decide on broadcast ${input.broadcastId} owned by another member`,
    payload: { probedMemberId: input.memberId, probedBroadcastId: input.broadcastId as string, operation: 'member_decision' },
  });
}

/** Throw-to-rollback: the refusal leaves the tx, which rolls back (`_approval-tx.ts`). */
function refuse(refusal: Refusal): never {
  throw new ApprovalRefusal('record-member-decision', refusal);
}
