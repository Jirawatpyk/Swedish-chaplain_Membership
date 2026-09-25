/**
 * F119 T060 — `confirmSchedule` (FR-012, FR-012a, FR-016, FR-017, FR-018;
 * contracts/admin-eblast-formatting-api.md § `POST …/[id]/schedule`,
 * dashboard-and-notifications.md §§ 2–3, data-model §§ 8.2–8.3).
 *
 *   from `member_approved`, mode keep_proposal | schedule | send_now
 *       → PROMOTES the approved version: `subject` / `body_html` /
 *         `body_source` are copied from `approved_version_id` onto
 *         `broadcasts` in the SAME statement as `member_approved → approved`
 *         (trigger exemption E1 is on that edge alone, and it is the only
 *         content write after submit), with `scheduled_for` (E2),
 *         `approved_at` / `approved_by_user_id` and `stage_entered_at`;
 *   from `approved`, mode schedule | send_now
 *       → changes `scheduled_for` only (E2 admits `approved → approved`);
 *   from `approved`, mode cancel
 *       → clears `scheduled_for` AND `approved_version_id` in the same
 *         UPDATE as `approved → changes_requested`, so the row leaves the
 *         only dispatchable status (FR-017) and names no approval that no
 *         longer governs it (see below).
 *
 * A row the dispatcher has already handed over (`hasDispatchBegun` —
 * `resend_broadcast_id` or `audience_import_id` set while the status still
 * reads `approved`, T166 R-H1) is refused `sending_started` on every mode.
 *
 * Every other (stage, mode) pair is refused — `keep_proposal` on an already
 * scheduled row and `cancel` before anything is scheduled are not in the
 * contract table (`mode_not_allowed`); a round-0 row (approved as submitted,
 * never in a design round) is `round_zero` on every mode (data-model § 8.2:
 * `approved → changes_requested` needs round ≥ 1, and this route re-times
 * only rows the approval round produced).
 *
 * The confirmed time obeys the existing `now + 5 min` floor
 * (`MIN_SCHEDULE_LEAD_MS`, `approve-broadcast.ts`): an explicit `schedule`
 * time is checked before any read, `keep_proposal` once the frozen proposal
 * is read — a proposal already in the past is refused the same way (the
 * "proposed time already passed" edge case). `send_now` is now, as in
 * `approveBroadcast`.
 *
 * The promotion re-reads the owning member's halt flag and F8 membership
 * access just before the row lock (T166 S-H1, the rules submit applies; the
 * bridges take their own pool connections) and applies them under it: halted →
 * `member_halted`, suspended / terminated → `member_not_in_good_standing`, a
 * read that cannot be answered → `server_error` (fail closed). Both refusals
 * write submit's own refusal audit row after the rollback (T166 follow-up,
 * `standingRefusalAuditEvent`); a fail-closed read writes none. A re-time of an
 * already `approved` row does not re-read them — the promotion is the edge
 * where the row becomes dispatchable — and dispatch does not re-read them
 * either (quickstart § 3.6).
 *
 * The promotion re-checks every image of the approved version against the
 * tenant allow-list (read before the tx, on its own connection): a host
 * removed since the approval refuses it, naming the image, and the E-Blast
 * stays at Member approved.
 *
 * Confirming or changing the time is not a content change and NEVER voids
 * the member's approval (FR-012): those modes do not write
 * `approved_version_id`. A `cancel` clears it: the row moves to
 * `changes_requested`, marketing must send a new version and the member must
 * approve that one, so the approval no longer governs the row — and the
 * column is SC-002's proof, which must never name an approval that is not in
 * force (a set `approved_version_id` is coherent only at `member_approved` /
 * `approved`). That is not a content void, so no
 * `broadcast_member_approval_voided` is emitted; the cancel's own
 * `broadcast_schedule_confirmed` row still names the version it cancelled.
 * Audit `broadcast_schedule_confirmed` (the proposal is
 * quoted, never overwritten — FR-016). Enqueue one
 * `eblast_schedule_confirmed_member` row when a time was confirmed, to the
 * same contact rule the send uses; no active portal contact left means no
 * row — a notification never blocks the send.
 *
 * One tenant tx with throw-to-rollback; the route owns the span. 100 %
 * branch pinned (T158). Pure Application — no framework imports.
 */
import { assertNever } from '@/lib/assert-never';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../../domain/broadcast';
import { scheduleDiffers } from '../../../domain/approval/member-decision';
import { hasDispatchBegun } from '../../../domain/stage/in-progress-statuses';
import {
  evaluateImageSources,
  type UnsafeImageSource,
} from '../../../domain/value-objects/image-source-allowlist';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastsRepo } from '../../ports/broadcasts-repo';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { EblastNotificationOutboxPort } from '../../ports/eblast-notification-outbox-port';
import type { ImageAllowlistPort } from '../../ports/image-allowlist-port';
import type { MemberPortalRecipientPort } from '../../ports/member-portal-recipient-port';
import { ApprovalDependencyError, approvalErrKind, standingUnavailableError } from '../../approval-dependency-error';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import { safeAuditEmit } from '../_safe-audit-emit';
import { MIN_SCHEDULE_LEAD_MS } from '../approve-broadcast';
import { emitUnsafeImageSourcesAudit } from '../validate-image-source-allowlist';
import {
  readMemberSendStanding,
  standingRefusalAuditEvent,
  type MemberSendStanding,
  type MemberSendStandingDeps,
} from '../_member-send-standing';
import { ApprovalRefusal, isOwnRefusal, type ApprovalBroadcastsRepo } from './_approval-tx';
import { ownerMemberId } from './_owner-member-id';
import { chooseApprovalRecipient } from './_approval-recipient';

export type ScheduleMode =
  | { readonly mode: 'keep_proposal' }
  | { readonly mode: 'schedule'; readonly scheduledFor: Date }
  | { readonly mode: 'send_now' }
  | { readonly mode: 'cancel' };

export interface ConfirmScheduleDeps {
  readonly tenant: TenantContext;
  /** `findById` — the non-locking pre-read the standing read keys on (T166 follow-up). */
  readonly broadcastsRepo: ApprovalBroadcastsRepo & Pick<BroadcastsRepo, 'findById'>;
  readonly versionsRepo: BroadcastVersionsRepo;
  readonly imageAllowlist: ImageAllowlistPort;
  readonly portalRecipients: MemberPortalRecipientPort;
  readonly outbox: EblastNotificationOutboxPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * T166 S-H1 — the send-time rules submit applies (halt flag + F8 membership
   * access), re-read at the promotion. REQUIRED: a security gate is not
   * optional in the composition.
   */
  readonly sendStanding: MemberSendStandingDeps;
}

export interface ConfirmScheduleInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  /** The session role, recorded as-is (`?? null`), never a literal. */
  readonly actorRole: string | null;
  readonly requestId: string | null;
  readonly mode: ScheduleMode;
}

export interface ConfirmScheduleOutput {
  /**
   * The row's new STATUS (not the `stageOf` display stage — PR #392 review
   * C5: the route's 409 `details.stage` carries that vocabulary, so this
   * key is named for what it holds).
   */
  readonly status: 'approved' | 'changes_requested';
  /** null on `cancel`. */
  readonly confirmedSendAt: Date | null;
  /** The member's frozen proposal (FR-016); null when none was recorded. */
  readonly proposedSendAt: Date | null;
  readonly differs: boolean;
  /** The row's `current_round` (unchanged by any mode) — for the span. */
  readonly round: number;
}

export type ConfirmScheduleError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'stage_changed'; readonly status: BroadcastStatus }
  | { readonly kind: 'mode_not_allowed'; readonly status: BroadcastStatus; readonly mode: ScheduleMode['mode'] }
  | { readonly kind: 'round_zero' }
  /** T166 R-H1 — the dispatcher already handed the row to the provider (`hasDispatchBegun`). */
  | { readonly kind: 'sending_started'; readonly status: BroadcastStatus }
  | { readonly kind: 'no_proposal' }
  /** T166 S-H1 — the owning member's broadcasts are halted pending admin review. */
  | { readonly kind: 'member_halted'; readonly memberId: string }
  /** T166 S-H1 — the owning member's membership is suspended or terminated (F8). */
  | { readonly kind: 'member_not_in_good_standing'; readonly memberId: string }
  | { readonly kind: 'schedule_too_soon'; readonly scheduledFor: Date }
  | { readonly kind: 'image_source_not_allowlisted'; readonly images: readonly UnsafeImageSource[] }
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

export async function confirmSchedule(
  deps: ConfirmScheduleDeps,
  input: ConfirmScheduleInput,
): Promise<Result<ConfirmScheduleOutput, ConfirmScheduleError>> {
  const slug = deps.tenant.slug;
  const mode = input.mode;
  const floorOk = (at: Date) => at.getTime() >= deps.clock.now().getTime() + MIN_SCHEDULE_LEAD_MS;

  // An explicit time is checked before any read, as `approveBroadcast` does.
  if (mode.mode === 'schedule' && !floorOk(mode.scheduledFor)) {
    return err({ kind: 'schedule_too_soon', scheduledFor: mode.scheduledFor });
  }

  try {
    // Before the row lock, on its own connection (the promotion re-check).
    const allowlist = await deps.imageAllowlist.findByTenantId(slug);
    // T166 follow-up — the promotion's standing reads go through the members
    // bridges, each on its OWN pool connection, so they are made before the
    // lock too (the R-L3 class). `requested_by_member_id` is immutable after
    // submit, so a non-locking pre-read names the member the locked row will.
    // Only a promotion reads standing, so only a `member_approved` row is read
    // for; a missing row falls through to the not-found handling in the tx.
    const preRead = await deps.broadcastsRepo.findById(slug, input.broadcastId);
    const standing =
      preRead?.status === 'member_approved'
        ? await readMemberSendStanding(deps.sendStanding, deps.tenant, preRead.requestedByMemberId)
        : null;

    return ok(
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.lockForUpdate(tx, slug, input.broadcastId);
        const broadcast = (await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId)) ?? refuse({ kind: 'not_found' });
        const promoting = admit(broadcast, mode.mode);
        // T166 R-H1 — the dispatch leg commits its lock BEFORE calling Resend,
        // so an `approved` row can already be handed over while its status
        // still says `approved`. A cancel or a re-time cannot recall that, and
        // a promotion over an inherited id would let the next dispatch record
        // this version as sent without sending it.
        if (hasDispatchBegun(broadcast)) refuse({ kind: 'sending_started', status: broadcast.status });
        // A row the approval round produced always names the version the
        // member approved (only a void / withdrawal clears it, and both leave
        // these two stages). Missing ⇒ an invariant breach, not a refusal.
        const versionId = broadcast.approvedVersionId;
        if (versionId === null) throw new Error(`${broadcast.status} broadcast without an approved version`);

        const now = deps.clock.now();
        const timing = resolveTiming(mode, broadcast, now, floorOk);
        const confirmed = timing.kind === 'cancel' ? null : timing.at;

        let fields: Partial<Broadcast>;
        if (promoting) {
          // T166 S-H1 — the promotion is the send-time edge of the round (the
          // row becomes dispatchable here), so the rules that block sending
          // (read just before the lock) are applied now: a member halted,
          // suspended or terminated since they submitted does not get the
          // E-Blast sent.
          assertMemberMaySend(standing, broadcast.requestedByMemberId);
          const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
          const approved = versions.find((v) => v.id === versionId);
          if (approved === undefined) throw new Error('approved version not found under the broadcast lock');
          const unsafe = evaluateImageSources(approved.bodyHtml, allowlist);
          if (unsafe.length > 0) refuse({ kind: 'image_source_not_allowlisted', images: unsafe });
          fields = {
            subject: approved.subject,
            bodyHtml: approved.bodyHtml,
            bodySource: approved.bodySource,
            scheduledFor: confirmed,
            approvedAt: now,
            approvedByUserId: input.actorUserId,
            stageEnteredAt: now,
          };
        } else {
          // Re-time an already scheduled row: the time only. A cancel also
          // clears the approval it takes out of force (docblock). The repo
          // stamps `stage_entered_at` itself when the status changes.
          fields = timing.kind === 'cancel' ? { scheduledFor: null, approvedVersionId: null } : { scheduledFor: confirmed };
        }
        const target = timing.kind === 'cancel' ? 'changes_requested' : 'approved';
        await deps.broadcastsRepo.applyTransition(tx, slug, input.broadcastId, target, fields, broadcast.status);

        const proposed = broadcast.proposedSendAt;
        const common = {
          related_member_id: broadcast.requestedByMemberId,
          broadcast_id: input.broadcastId,
          version_id: versionId,
          proposed_send_at: proposed?.toISOString() ?? null,
          actor_role: input.actorRole ?? null,
        };
        const differs = timing.kind === 'cancel' ? false : scheduleDiffers(proposed, timing.at);
        await deps.audit.emitTyped(tx, {
          eventType: 'broadcast_schedule_confirmed',
          tenantId: slug,
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          summary: `E-Blast ${input.broadcastId} send time ${timing.kind === 'cancel' ? 'cancelled' : 'confirmed'} (${mode.mode})`,
          payload:
            timing.kind === 'cancel'
              ? { ...common, mode: 'cancel', confirmed_send_at: null, differs: false }
              : { ...common, mode: timing.mode, confirmed_send_at: timing.at.toISOString(), differs },
        });

        if (timing.kind === 'confirm') {
          const contacts = await deps.portalRecipients.listActivePortalContacts(deps.tenant, ownerMemberId(broadcast), tx);
          const recipient = chooseApprovalRecipient(contacts, broadcast.submittedByUserId);
          if (recipient === null) {
            logger.warn(
              { tenantId: slug, broadcastId: input.broadcastId, requestId: input.requestId, reason: 'no_portal_user' },
              'broadcasts.schedule.member_notification_skipped',
            );
          } else {
            await deps.outbox.enqueueInTx(tx, deps.tenant, {
              type: 'eblast_schedule_confirmed_member',
              toEmail: recipient.email,
              locale: recipient.locale,
              contextData: { tenantId: slug, broadcastId: input.broadcastId, versionId },
            });
          }
        }

        return { status: target, confirmedSendAt: confirmed, proposedSendAt: proposed, differs, round: broadcast.currentRound };
      }),
    );
  } catch (e) {
    if (!(e instanceof ApprovalRefusal)) return err({ kind: 'server_error', errKind: approvalErrKind(e) });
    // #400 item 5 — a refusal another use case raised is not ours to map.
    if (!isOwnRefusal(e, 'confirm-schedule')) throw e;
    const refusal = e.refusal as ConfirmScheduleError;
    if (refusal.kind === 'not_found') {
      await emitCrossTenantProbe({
        audit: deps.audit,
        tenantId: slug,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'confirm-schedule' },
      });
    }
    if (refusal.kind === 'member_halted' || refusal.kind === 'member_not_in_good_standing') {
      // T166 follow-up — submit's own refusal row, written AFTER the rollback
      // (a row on the refused tx would roll back with it): best-effort on
      // autocommit, exactly like the cross-tenant probe above.
      const event = standingRefusalAuditEvent({
        refusal: refusal.kind === 'member_halted' ? 'halted' : 'not_in_good_standing',
        surface: 'schedule_confirm',
        tenantSlug: slug,
        memberId: refusal.memberId,
        broadcastId: input.broadcastId as string,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        requestId: input.requestId,
      });
      await safeAuditEmit(deps.audit, null, event);
      broadcastsMetrics.auditEmitCount(slug, event.eventType);
    }
    if (refusal.kind === 'image_source_not_allowlisted') {
      await emitUnsafeImageSourcesAudit(deps.audit, {
        tenantId: slug,
        actorUserId: input.actorUserId,
        requestId: input.requestId ?? 'confirm-schedule',
        unsafeImageSources: refusal.images.map((image) => image.src),
      });
    }
    return err(refusal);
  }
}

/**
 * T166 S-H1 — refuse the promotion for a member who may not send; a read that
 * cannot be answered THROWS (→ `server_error`, the tx rolls back): fail closed.
 * `null` = the row reached `member_approved` after the pre-read, so nothing
 * was read for it — fail closed the same way rather than promote unchecked.
 */
function assertMemberMaySend(standing: MemberSendStanding | null, memberId: string): void {
  if (standing === null) throw new ApprovalDependencyError('member_send_standing', 'not_read_before_lock');
  switch (standing.kind) {
    case 'ok':
      return;
    case 'halted':
      return refuse({ kind: 'member_halted', memberId });
    case 'not_in_good_standing':
      return refuse({ kind: 'member_not_in_good_standing', memberId });
    case 'halt_read_failed':
    case 'access_unavailable':
      // Round-4 B3 — naming WHICH read failed and why, for the route's log.
      throw standingUnavailableError(standing);
    default:
      // Round-4 B2 — an unknown kind is never read as "may send".
      return assertNever(standing);
  }
}

/**
 * The (stage, mode) gate, on the RE-READ row. Returns whether this call
 * promotes the approved version; throws the refusal otherwise.
 */
function admit(broadcast: Broadcast, mode: ScheduleMode['mode']): boolean {
  if (broadcast.status !== 'member_approved' && broadcast.status !== 'approved') {
    return refuse({ kind: 'stage_changed', status: broadcast.status });
  }
  if (broadcast.currentRound < 1) refuse({ kind: 'round_zero' });
  const promoting = broadcast.status === 'member_approved';
  const allowed = promoting ? mode !== 'cancel' : mode !== 'keep_proposal';
  if (!allowed) refuse({ kind: 'mode_not_allowed', status: broadcast.status, mode });
  return promoting;
}

type Timing =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'confirm'; readonly mode: Exclude<ScheduleMode['mode'], 'cancel'>; readonly at: Date };

/** The time this call confirms, or the cancellation. */
function resolveTiming(mode: ScheduleMode, broadcast: Broadcast, now: Date, floorOk: (at: Date) => boolean): Timing {
  switch (mode.mode) {
    case 'cancel':
      return { kind: 'cancel' };
    case 'send_now':
      return { kind: 'confirm', mode: 'send_now', at: now };
    case 'schedule':
      return { kind: 'confirm', mode: 'schedule', at: mode.scheduledFor };
    case 'keep_proposal': {
      const proposal = broadcast.proposedSendAt ?? refuse({ kind: 'no_proposal' });
      if (!floorOk(proposal)) refuse({ kind: 'schedule_too_soon', scheduledFor: proposal });
      return { kind: 'confirm', mode: 'keep_proposal', at: proposal };
    }
  }
}

/** Throw-to-rollback: the refusal leaves the tx, which rolls back (`_approval-tx.ts`). */
function refuse(refusal: ConfirmScheduleError): never {
  throw new ApprovalRefusal<ConfirmScheduleError>('confirm-schedule', refusal);
}
