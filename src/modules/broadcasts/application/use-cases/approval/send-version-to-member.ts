/**
 * F119 T059 — `sendVersionToMember` (FR-003, FR-004, FR-011, FR-024,
 * FR-026; contracts/admin-eblast-formatting-api.md § `POST
 * …/[id]/version/send`, dashboard-and-notifications.md §§ 2–3).
 *
 * Marketing sends the working copy to the member for approval. The tenant's
 * image allow-list is read first, on its own connection; then ONE tenant tx,
 * with throw-to-rollback (`_approval-tx.ts`):
 *
 *   1. Re-read the broadcast `FOR UPDATE` and re-check the stage from THAT
 *      read: it must be `in_design` with a working copy — and, when the
 *      caller names the `updatedAt` it last saw (FR-033, round-4 B1), the
 *      working copy must still carry it, else `version_changed` with the
 *      current copy: the save's own check, so a clean-but-stale screen cannot
 *      send content another marketing user saved unseen.
 *   2. At least one member contact who can sign in to approve (an ACTIVE
 *      portal login) — else `no_portal_user` (spec § Edge Cases).
 *   3. The content rules AGAIN, on the working copy as it stands under the
 *      lock (FR-004: "cannot be sent to the member until it passes") —
 *      `checkVersionContent`, the very rule set every save applies, including
 *      each image host against the allow-list read in step 0 (a host removed
 *      since the save is refused here, naming the image).
 *   4. Stamp `sent_to_member_at` (the version is read-only from now on — the
 *      version trigger freezes every stamped row).
 *   5. `in_design → awaiting_member_approval`: `current_round = version_no`
 *      (the round moves HERE and only here — a round is a version sent to
 *      the member, FR-026), `stage_entered_at` = now, and the reminder clock
 *      reset (`member_reminder_stage = 0`, `member_expiry_notified_at = NULL`).
 *   6. Audit `broadcast_version_sent_to_member` (`related_member_id`; the
 *      note's LENGTH, never its text).
 *   7. Enqueue ONE `eblast_version_sent_member` outbox row to the chosen
 *      contact in the contact's language, ids only. Unconditional: nothing
 *      here reads the feature flag — the drainer skips the row while it is
 *      off (T152a).
 *
 * Re-sending content byte-identical to the previous round is allowed and is
 * the next round (FR-011); there is no "nothing changed" refusal.
 *
 * The counter is emitted after the commit. The route owns the span. 100 %
 * branch pinned (T158). Pure Application — no framework imports.
 */
import { broadcastsMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId, BroadcastVersionId } from '../../../domain/broadcast';
import type { BroadcastVersion } from '../../../domain/approval/broadcast-version';
import { memberApprovalExpiresAt } from '../../../domain/approval/member-approval-expiry';
import type { BroadcastStatus } from '../../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../../ports/audit-port';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { EblastNotificationOutboxPort } from '../../ports/eblast-notification-outbox-port';
import type { HtmlSanitizerPort } from '../../ports/html-sanitizer-port';
import type { ImageAllowlistPort } from '../../ports/image-allowlist-port';
import type { MemberPortalRecipientPort } from '../../ports/member-portal-recipient-port';
import { approvalErrKind } from '../../approval-dependency-error';
import { emitCrossTenantProbe } from '../_emit-cross-tenant-probe';
import { emitUnsafeImageSourcesAudit } from '../validate-image-source-allowlist';
import { ApprovalRefusal, isOwnRefusal, type ApprovalBroadcastsRepo } from './_approval-tx';
import { ownerMemberId } from './_owner-member-id';
import { chooseApprovalRecipient } from './_approval-recipient';
import { checkVersionContent, type VersionContentError } from './_version-content';

export interface SendVersionToMemberDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: ApprovalBroadcastsRepo;
  readonly versionsRepo: BroadcastVersionsRepo;
  readonly sanitizer: HtmlSanitizerPort;
  readonly imageAllowlist: ImageAllowlistPort;
  readonly portalRecipients: MemberPortalRecipientPort;
  readonly outbox: EblastNotificationOutboxPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface SendVersionToMemberInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  /** The session role, recorded as-is (`?? null`), never a literal. */
  readonly actorRole: string | null;
  readonly requestId: string | null;
  /**
   * FR-033 (round-4 B1) — the working copy's `updatedAt` the caller last saw,
   * the save's concurrency token. Optional: absent, the copy under the lock is
   * sent (a caller that sends no body keeps the old behaviour).
   */
  readonly expectedUpdatedAt?: Date;
}

export interface SendVersionToMemberOutput {
  /** The new status (#400 item 6: `status`, not `stage` — the value is a status). */
  readonly status: 'awaiting_member_approval';
  readonly whoseTurn: 'member';
  /** The new `current_round` — the sent version's `version_no`. */
  readonly round: number;
  readonly versionId: BroadcastVersionId;
  /** `stage_entered_at` + 30 days (FR-022a). */
  readonly expiresAt: Date;
}

export type SendVersionToMemberError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'stage_changed'; readonly status: BroadcastStatus }
  | { readonly kind: 'no_working_copy' }
  /** FR-033 (round-4 B1) — the working copy changed since the caller read it; nothing was sent. */
  | { readonly kind: 'version_changed'; readonly current: BroadcastVersion }
  | { readonly kind: 'no_portal_user' }
  | VersionContentError
  /** An infrastructure fault; `errKind` is the error CLASS only (never `e.message` — F7-5). */
  | { readonly kind: 'server_error'; readonly errKind: string };

export async function sendVersionToMember(
  deps: SendVersionToMemberDeps,
  input: SendVersionToMemberInput,
): Promise<Result<SendVersionToMemberOutput, SendVersionToMemberError>> {
  const slug = deps.tenant.slug;
  let sent: SendVersionToMemberOutput;
  try {
    // Step 0 — on its own connection, before the row lock is taken.
    const allowlist = await deps.imageAllowlist.findByTenantId(slug);

    sent = await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.lockForUpdate(tx, slug, input.broadcastId);
      const broadcast = (await deps.broadcastsRepo.findByIdInTx(tx, slug, input.broadcastId)) ?? refuse({ kind: 'not_found' });
      if (broadcast.status !== 'in_design') refuse({ kind: 'stage_changed', status: broadcast.status });

      const versions = await deps.versionsRepo.listByBroadcast(slug, input.broadcastId, tx);
      const workingCopy = versions.find((v) => v.sentToMemberAt === null) ?? refuse({ kind: 'no_working_copy' });
      // FR-033 (round-4 B1) — compared exactly as the save compares it: in JS
      // on the ms-precision `Date` (the column is µs; the client echoes ms).
      if (input.expectedUpdatedAt !== undefined && workingCopy.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        refuse({ kind: 'version_changed', current: workingCopy });
      }

      const contacts = await deps.portalRecipients.listActivePortalContacts(deps.tenant, ownerMemberId(broadcast), tx);
      const recipient = chooseApprovalRecipient(contacts, broadcast.submittedByUserId) ?? refuse({ kind: 'no_portal_user' });

      const checked = checkVersionContent(deps.sanitizer, workingCopy, allowlist);
      if (!checked.ok) refuse(checked.error);

      const now = deps.clock.now();
      const stamped = await deps.versionsRepo.markSent(slug, workingCopy.id, now, tx);
      // Unreachable under the row lock (every writer of the working copy
      // takes the same lock) — a throw, so the tx rolls back.
      if (stamped === null) throw new Error('working copy vanished under the broadcast lock');

      const round = workingCopy.versionNo;
      await deps.broadcastsRepo.applyTransition(
        tx,
        slug,
        input.broadcastId,
        'awaiting_member_approval',
        { stageEnteredAt: now, currentRound: round, memberReminderStage: 0, memberExpiryNotifiedAt: null },
        'in_design',
      );

      await deps.audit.emitTyped(tx, {
        eventType: 'broadcast_version_sent_to_member',
        tenantId: slug,
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        summary: `E-Blast ${input.broadcastId} version ${round} sent to the member for approval`,
        payload: {
          related_member_id: broadcast.requestedByMemberId,
          broadcast_id: input.broadcastId,
          version_id: workingCopy.id,
          round,
          note_length: workingCopy.noteToMember?.length ?? 0,
          notified: true,
          actor_role: input.actorRole ?? null,
        },
      });
      await deps.outbox.enqueueInTx(tx, deps.tenant, {
        type: 'eblast_version_sent_member',
        toEmail: recipient.email,
        locale: recipient.locale,
        contextData: { tenantId: slug, broadcastId: input.broadcastId, versionId: workingCopy.id, round },
      });

      return {
        status: 'awaiting_member_approval' as const,
        whoseTurn: 'member' as const,
        round,
        versionId: workingCopy.id,
        expiresAt: memberApprovalExpiresAt(now),
      };
    });
  } catch (e) {
    if (!(e instanceof ApprovalRefusal)) return err({ kind: 'server_error', errKind: approvalErrKind(e) });
    // #400 item 5 — a refusal another use case raised is not ours to map.
    if (!isOwnRefusal(e, 'send-version-to-member')) throw e;
    const refusal = e.refusal as SendVersionToMemberError;
    if (refusal.kind === 'not_found') {
      await emitCrossTenantProbe({
        audit: deps.audit,
        tenantId: slug,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        surface: { kind: 'broadcast', broadcastId: input.broadcastId as string, useCase: 'send-version-to-member' },
      });
    }
    if (refusal.kind === 'image_source_not_allowlisted') {
      // After the rollback, on its own connection — as every save does.
      await emitUnsafeImageSourcesAudit(deps.audit, {
        tenantId: slug,
        actorUserId: input.actorUserId,
        requestId: input.requestId ?? 'send-version-to-member',
        unsafeImageSources: refusal.images.map((image) => image.src),
      });
    }
    return err(refusal);
  }

  broadcastsMetrics.versionSent(slug, sent.round);
  return ok(sent);
}

/** Throw-to-rollback: the refusal leaves the tx, which rolls back (`_approval-tx.ts`). */
function refuse(refusal: SendVersionToMemberError): never {
  throw new ApprovalRefusal<SendVersionToMemberError>('send-version-to-member', refusal);
}
