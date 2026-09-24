/**
 * F119 T130 — `expireStaleMemberApprovals`: the daily approval-lifecycle tick
 * (FR-014, FR-022, FR-022a; contracts/dashboard-and-notifications.md § 5,
 * data-model § 3). It rides the existing `prune-expired-drafts` cron (no new
 * job) as that route's third, independently guarded block.
 *
 * For every E-Blast in `awaiting_member_approval` — and in NO other status
 * (FR-022a: once the member approved, or a schedule was confirmed, no expiry
 * can occur) — the Domain policy `nextReminder` decides one step:
 *
 *   day 3 / day 7  a reminder to the member         → `member_reminder_stage` 1 / 2
 *   day 23         a warning to BOTH sides          → `member_reminder_stage` 3
 *   day 30         `→ expired_no_member_response`, `member_expiry_notified_at`
 *                  stamped, the closure to BOTH sides
 *
 * Exactly one per threshold: the counter records what was served, and every
 * entry into `awaiting_member_approval` resets it (a new version restarts the
 * clock). Nothing here can approve anything (FR-014) — the only transitions it
 * writes are the same-status counter bump and the expiry.
 *
 * Shape:
 *   1. ONE scan transaction with its own `SET LOCAL statement_timeout`: two
 *      candidate lists, each ≤ `APPROVAL_LIFECYCLE_BATCH`, oldest first —
 *      reminders/warnings (waited ≥ 3 and < 30 days) and expiries (≥ 30).
 *   2. ONE `runInTenant` per candidate (`withTx`, its own statement timeout):
 *      the row is re-read under `lockForUpdate` and the policy re-run on what
 *      the lock sees, so a member who decided between the scan and the lock,
 *      a new round, or a concurrent tick that already served the step all
 *      make the row a no-op. The counter/status write, the audit row and the
 *      outbox rows share that transaction (SC-004); a row that throws rolls
 *      back alone, is counted in `rowsFailed` and is retried tomorrow.
 *
 * Audit (system rows, `actor_role: 'system'`, `related_member_id`):
 * `broadcast_approval_reminder_sent { reminder }` when a reminder was actually
 * enqueued, `broadcast_approval_expiry_warned { days_waiting }` when the warning
 * reached anyone, `broadcast_approval_expired { days_waiting,
 * allowance_released: true }` on every closure. A reminder with no member
 * contact to send it to still moves the counter (it must not fire daily
 * forever), but writes no "reminder sent" row — nothing was sent.
 *
 * Never logs a subject, body, note, reason or address. Pure Application — no
 * framework imports.
 */
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast } from '../../../domain/broadcast';
import { MEMBER_APPROVAL_EXPIRY_DAYS } from '../../../domain/approval/member-approval-expiry';
import {
  MEMBER_APPROVAL_REMINDER_DAYS,
  REMINDER_STAGE,
  daysWaiting,
  nextReminder,
  type ApprovalScheduleStep,
} from '../../../domain/approval/approval-schedule-policy';
import type { ApprovalLifecycleScanPort, AwaitingApprovalCandidate } from '../../ports/approval-lifecycle-scan-port';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { EblastNotificationOutboxPort } from '../../ports/eblast-notification-outbox-port';
import type { MarketingDirectoryPort } from '../../ports/marketing-directory-port';
import type { MemberPortalRecipientPort } from '../../ports/member-portal-recipient-port';
import type { ApprovalBroadcastsRepo } from './_approval-tx';
import { chooseApprovalRecipient } from './_approval-recipient';

/** ≤ this many rows per kind per tick (the tenant has ~2 in flight; the bound stops a backlog making the tick unbounded). */
export const APPROVAL_LIFECYCLE_BATCH = 200;

/**
 * The scan's and each row's `SET LOCAL statement_timeout`. 5 s like the image
 * sweep's per-row bound: each is a handful of indexed statements
 * (`broadcasts_awaiting_member_idx` serves the scan).
 */
export const APPROVAL_LIFECYCLE_TIMEOUT_MS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpireStaleMemberApprovalsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: ApprovalBroadcastsRepo;
  readonly versionsRepo: Pick<BroadcastVersionsRepo, 'listByBroadcast'>;
  readonly lifecycleScan: ApprovalLifecycleScanPort;
  readonly portalRecipients: MemberPortalRecipientPort;
  readonly marketingDirectory: MarketingDirectoryPort;
  readonly outbox: EblastNotificationOutboxPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface ExpireStaleMemberApprovalsInput {
  readonly requestId: string;
}

export interface ExpireStaleMemberApprovalsOutput {
  /** Candidates the scan returned (both kinds). */
  readonly scanned: number;
  /** Day-3 / day-7 steps applied. */
  readonly remindersSent: number;
  /** Day-23 steps applied. */
  readonly warningsSent: number;
  /** Rows closed as `expired_no_member_response`. */
  readonly expired: number;
  /** Rows whose transaction threw — rolled back, left for the next tick. */
  readonly rowsFailed: number;
}

export type ExpireStaleMemberApprovalsError = { readonly kind: 'lifecycle.server_error'; readonly errKind: string };

/** The `kind` discriminator of `eblast_approval_lifecycle` (data-model § 7.3) each step enqueues. */
type LifecycleKind = 'reminder_day3' | 'reminder_day7' | 'expiry_warning_day23' | 'expired_day30';

const KIND_OF: Readonly<Record<ApprovalScheduleStep, LifecycleKind>> = {
  day3: 'reminder_day3',
  day7: 'reminder_day7',
  day23: 'expiry_warning_day23',
  expire: 'expired_day30',
};

export async function expireStaleMemberApprovals(
  deps: ExpireStaleMemberApprovalsDeps,
  input: ExpireStaleMemberApprovalsInput,
): Promise<Result<ExpireStaleMemberApprovalsOutput, ExpireStaleMemberApprovalsError>> {
  const slug = deps.tenant.slug;
  const now = deps.clock.now();
  const expiryCutoff = new Date(now.getTime() - MEMBER_APPROVAL_EXPIRY_DAYS * DAY_MS);

  let candidates: readonly AwaitingApprovalCandidate[];
  try {
    candidates = await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.lifecycleScan.setStatementTimeoutInTx(tx, APPROVAL_LIFECYCLE_TIMEOUT_MS);
      const reminders = await deps.lifecycleScan.listAwaitingMemberApprovalInTx(tx, slug, {
        enteredAtOrBefore: new Date(now.getTime() - MEMBER_APPROVAL_REMINDER_DAYS.day3 * DAY_MS),
        enteredAfter: expiryCutoff,
        limit: APPROVAL_LIFECYCLE_BATCH,
      });
      const expiries = await deps.lifecycleScan.listAwaitingMemberApprovalInTx(tx, slug, {
        enteredAtOrBefore: expiryCutoff,
        limit: APPROVAL_LIFECYCLE_BATCH,
      });
      return [...reminders, ...expiries];
    });
  } catch (e) {
    return err({ kind: 'lifecycle.server_error', errKind: errKind(e) });
  }

  const counts = { remindersSent: 0, warningsSent: 0, expired: 0, rowsFailed: 0 };
  for (const candidate of candidates) {
    try {
      const step = await processRow(deps, candidate, now, input.requestId);
      if (step === 'expire') {
        counts.expired += 1;
        broadcastsMetrics.approvalExpired(slug);
      } else if (step === 'day23') {
        counts.warningsSent += 1;
      } else if (step !== null) {
        counts.remindersSent += 1;
      }
    } catch (e) {
      counts.rowsFailed += 1;
      logger.warn(
        { tenantId: slug, broadcastId: candidate.broadcastId, requestId: input.requestId, err: errKind(e) },
        'M119.cron.approval_lifecycle.row_failed',
      );
    }
  }
  return ok({ scanned: candidates.length, ...counts });
}

/** One candidate, in its own transaction; the step it applied, or null when the lock saw nothing due. */
async function processRow(
  deps: ExpireStaleMemberApprovalsDeps,
  candidate: AwaitingApprovalCandidate,
  now: Date,
  requestId: string,
): Promise<ApprovalScheduleStep | null> {
  const slug = deps.tenant.slug;
  return deps.broadcastsRepo.withTx(async (tx) => {
    await deps.lifecycleScan.setStatementTimeoutInTx(tx, APPROVAL_LIFECYCLE_TIMEOUT_MS);
    const status = await deps.broadcastsRepo.lockForUpdate(tx, slug, candidate.broadcastId);
    if (status !== 'awaiting_member_approval') return null;
    const broadcast = await deps.broadcastsRepo.findByIdInTx(tx, slug, candidate.broadcastId);
    if (broadcast === null) return null;
    const step = nextReminder(broadcast.stageEnteredAt, now, broadcast.memberReminderStage);
    if (step === null) return null;

    const versions = await deps.versionsRepo.listByBroadcast(slug, candidate.broadcastId, tx);
    const version = versions.find((v) => v.versionNo === broadcast.currentRound && v.sentToMemberAt !== null);
    // Unreachable by construction (the send stamps the version and sets the
    // round in one tx) — a throw, so this row rolls back and is counted.
    if (version === undefined) throw new Error('awaiting row has no sent version for its round');

    const common = {
      related_member_id: broadcast.requestedByMemberId,
      broadcast_id: candidate.broadcastId as string,
      version_id: version.id,
      round: broadcast.currentRound,
      actor_role: 'system' as const,
    };
    const waited = daysWaiting(broadcast.stageEnteredAt, now);

    if (step === 'expire') {
      await deps.broadcastsRepo.applyTransition(
        tx,
        slug,
        candidate.broadcastId,
        'expired_no_member_response',
        { memberExpiryNotifiedAt: now },
        'awaiting_member_approval',
      );
      await deps.audit.emitTyped(tx, {
        eventType: 'broadcast_approval_expired',
        tenantId: slug,
        requestId,
        actorUserId: 'system',
        summary: `E-Blast ${candidate.broadcastId as string} closed after ${waited} days without a member response`,
        payload: { ...common, days_waiting: waited, allowance_released: true },
      });
      await notify(deps, tx, broadcast, version.id, 'expire', { member: true, staff: true });
      return step;
    }

    await deps.broadcastsRepo.applyTransition(
      tx,
      slug,
      candidate.broadcastId,
      'awaiting_member_approval',
      { memberReminderStage: REMINDER_STAGE[step] },
      'awaiting_member_approval',
    );
    if (step === 'day23') {
      const sent = await notify(deps, tx, broadcast, version.id, step, { member: true, staff: true });
      if (sent > 0) {
        await deps.audit.emitTyped(tx, {
          eventType: 'broadcast_approval_expiry_warned',
          tenantId: slug,
          requestId,
          actorUserId: 'system',
          summary: `E-Blast ${candidate.broadcastId as string} closes in 7 days without a member response`,
          payload: { ...common, days_waiting: waited },
        });
      }
      return step;
    }
    const sent = await notify(deps, tx, broadcast, version.id, step, { member: true, staff: false });
    if (sent > 0) {
      await deps.audit.emitTyped(tx, {
        eventType: 'broadcast_approval_reminder_sent',
        tenantId: slug,
        requestId,
        actorUserId: 'system',
        summary: `E-Blast ${candidate.broadcastId as string} ${step} reminder sent to the member`,
        payload: { ...common, reminder: step },
      });
    } else {
      logger.warn(
        { tenantId: slug, broadcastId: candidate.broadcastId, reminder: step, requestId },
        'M119.cron.approval_lifecycle.no_member_recipient',
      );
    }
    return step;
  });
}

/**
 * Enqueue the step's `eblast_approval_lifecycle` rows on the row's tx, ids and
 * discriminators only: one to the member's approval contact (their language),
 * and — for the warning and the closure — one per marketing roster recipient.
 * Returns how many rows were enqueued.
 */
async function notify(
  deps: ExpireStaleMemberApprovalsDeps,
  tx: unknown,
  broadcast: Broadcast,
  versionId: string,
  step: ApprovalScheduleStep,
  to: { readonly member: boolean; readonly staff: boolean },
): Promise<number> {
  const slug = deps.tenant.slug;
  const base = {
    tenantId: slug as string,
    broadcastId: broadcast.broadcastId as string,
    versionId,
    round: broadcast.currentRound,
    kind: KIND_OF[step],
  };
  let enqueued = 0;
  if (to.member) {
    const contacts = await deps.portalRecipients.listActivePortalContacts(deps.tenant, broadcast.requestedByMemberId, tx);
    const recipient = chooseApprovalRecipient(contacts, broadcast.submittedByUserId);
    if (recipient !== null) {
      await deps.outbox.enqueueInTx(tx, deps.tenant, {
        type: 'eblast_approval_lifecycle',
        toEmail: recipient.email,
        locale: recipient.locale,
        contextData: { ...base, audience: 'member' },
      });
      enqueued += 1;
    }
  }
  if (to.staff) {
    for (const recipient of await deps.marketingDirectory.listRecipients()) {
      await deps.outbox.enqueueInTx(tx, deps.tenant, {
        type: 'eblast_approval_lifecycle',
        toEmail: recipient.email,
        locale: recipient.locale,
        contextData: { ...base, audience: 'staff', recipientUserId: recipient.userId },
      });
      enqueued += 1;
    }
  }
  return enqueued;
}
