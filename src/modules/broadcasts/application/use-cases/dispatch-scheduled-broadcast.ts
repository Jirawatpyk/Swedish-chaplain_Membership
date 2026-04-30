/**
 * `dispatch-scheduled-broadcast.ts` — F7 US2 cron worker (Wave 1).
 *
 * Per-cron-tick worker:
 *   1. lockForUpdate row in 'approved' status with scheduledFor <= now()
 *   2. Re-resolve recipient list (segment + suppression filter at
 *      dispatch boundary, FR-016 + FR-017)
 *   3. Resend Broadcasts API: createAudience + addContacts + createBroadcast
 *      + sendBroadcast (stable idempotency key per FR-020)
 *   4. attachResendIds(audienceId, broadcastId)
 *   5. applyTransition('sending', {sendingStartedAt})
 *   6. Audit broadcast_send_started
 *
 * On Resend retryable failure → row stays 'approved'; cron re-attempts
 * next tick with same idempotency key (Resend dedupes).
 *
 * On Resend permanent failure → applyTransition('failed_to_dispatch')
 * + audit broadcast_failed_to_dispatch.
 *
 * The cron route handler iterates eligible rows and calls this worker
 * once per row.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type {
  BroadcastsGatewayPort,
  AudienceContact,
} from '../ports/broadcasts-gateway-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import { resolveSegmentRecipients } from './resolve-segment-recipients';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';

const RESEND_FROM_EMAIL = 'noreply@swecham.example';

export type DispatchScheduledBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | {
      readonly kind: 'broadcast_invalid_state_transition';
      readonly observedStatus: string;
    }
  | { readonly kind: 'broadcast_audience_post_suppression_empty' }
  | {
      readonly kind: 'gateway_retryable';
      readonly reason: string;
    }
  | {
      readonly kind: 'broadcast_failed_to_dispatch';
      readonly reason: string;
    }
  | { readonly kind: 'dispatch.server_error'; readonly message: string };

export interface DispatchScheduledBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  readonly membersBridge: MembersBridgePort;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
  readonly eventAttendees: EventAttendeesRepository;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
}

export interface DispatchScheduledBroadcastInput {
  readonly broadcastId: BroadcastId;
}

export interface DispatchScheduledBroadcastOutput {
  readonly broadcast: Broadcast;
  readonly resendAudienceId: string;
  readonly resendBroadcastId: string;
  readonly recipientCount: number;
}

function buildIdempotencyKey(tenantId: string, broadcastId: string): string {
  return `broadcast-${tenantId}-${broadcastId}`;
}

export async function dispatchScheduledBroadcast(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
): Promise<
  Result<DispatchScheduledBroadcastOutput, DispatchScheduledBroadcastError>
> {
  const now = deps.clock.now();

  // Step 1: lock row + verify eligibility
  let broadcast: Broadcast | null = null;
  try {
    broadcast = await deps.broadcastsRepo.withTx(async (tx) => {
      const lockedStatus = await deps.broadcastsRepo.lockForUpdate(
        tx,
        deps.tenant.slug,
        input.broadcastId,
      );
      if (lockedStatus === null) return null;
      if (lockedStatus !== 'approved') {
        // Skip — another tick may have moved it on
        return null;
      }
      const row = await deps.broadcastsRepo.findByIdInTx(
        tx,
        deps.tenant.slug,
        input.broadcastId,
      );
      return row;
    });
  } catch (e) {
    return err({
      kind: 'dispatch.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }

  if (broadcast === null) {
    return err({
      kind: 'broadcast_invalid_state_transition',
      observedStatus: 'unknown_or_already_processed',
    });
  }

  // Step 2: re-resolve recipients (segment may have changed since submit)
  const segment = buildSegmentFromBroadcast(broadcast);
  const requestingMember = broadcast.requestedByMemberId;
  const requestingPrimary = await deps.membersBridge.getMemberPrimaryContact(
    deps.tenant,
    requestingMember,
  );

  const resolvedResult = await resolveSegmentRecipients(
    {
      tenant: deps.tenant,
      membersBridge: deps.membersBridge,
      eventAttendees: deps.eventAttendees,
      marketingUnsubscribes: deps.marketingUnsubscribes,
    },
    {
      segment,
      requestingMemberPrimaryEmail: requestingPrimary,
      customRecipients:
        broadcast.customRecipientEmails === null
          ? null
          : broadcast.customRecipientEmails.map((e) =>
              unsafeBrandEmailLower(e.toLowerCase().trim()),
            ),
    },
  );

  if (!resolvedResult.ok) {
    // Audience evaporated post-suppression — transition to
    // failed_to_dispatch + emit audit + member notification at route layer
    try {
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.applyTransition(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          'failed_to_dispatch',
          {
            failedToDispatchAt: now,
            failureReason: 'audience_post_suppression_empty',
          },
        );
        await deps.audit.emit(tx, {
          tenantId: deps.tenant.slug,
          eventType: 'broadcast_failed_to_dispatch',
          actorUserId: 'system:cron',
          summary: `Broadcast ${input.broadcastId} dispatch failed (audience empty post-suppression)`,
          payload: {
            broadcastId: input.broadcastId,
            reason: 'audience_post_suppression_empty',
            failedAt: now.toISOString(),
          },
          requestId: null,
        });
      });
    } catch {
      // best-effort cleanup
    }
    return err({ kind: 'broadcast_audience_post_suppression_empty' });
  }

  // Step 3: Resend Broadcasts API calls (createAudience + addContacts +
  // createBroadcast + sendBroadcast). External calls happen OUTSIDE tx.
  let resendAudienceId: string;
  let resendBroadcastId: string;
  try {
    const audienceResult = await deps.broadcastsGateway.createAudience(
      `broadcast-${input.broadcastId}-${now.getTime()}`,
    );
    resendAudienceId = audienceResult.audienceId;

    const contacts: ReadonlyArray<AudienceContact> = resolvedResult.value.recipients.map(
      (e) => ({ emailLower: e as string }),
    );
    await deps.broadcastsGateway.addContactsToAudience(
      resendAudienceId,
      contacts,
    );

    const createResult = await deps.broadcastsGateway.createBroadcast({
      audienceId: resendAudienceId,
      subject: broadcast.subject,
      htmlBody: broadcast.bodyHtml,
      fromName: broadcast.fromName,
      fromEmail: RESEND_FROM_EMAIL,
      replyToEmail: broadcast.replyToEmail,
      broadcastNameForResendDashboard: `${broadcast.fromName} — ${broadcast.subject.slice(0, 60)}`,
    });
    resendBroadcastId = createResult.broadcastId;

    await deps.broadcastsGateway.sendBroadcast(
      resendBroadcastId,
      buildIdempotencyKey(deps.tenant.slug, input.broadcastId as string),
    );
  } catch (e) {
    const eShape = e as
      | { kind?: string; reason?: string; code?: string }
      | Error;
    if (
      typeof (eShape as { kind?: string }).kind === 'string' &&
      (eShape as { kind?: string }).kind === 'retryable'
    ) {
      return err({
        kind: 'gateway_retryable',
        reason:
          typeof (eShape as { reason?: string }).reason === 'string'
            ? ((eShape as { reason?: string }).reason as string)
            : 'retryable',
      });
    }
    // permanent — transition to failed_to_dispatch
    const reason = e instanceof Error ? e.message : 'unknown gateway error';
    try {
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.applyTransition(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          'failed_to_dispatch',
          { failedToDispatchAt: now, failureReason: reason },
        );
        await deps.audit.emit(tx, {
          tenantId: deps.tenant.slug,
          eventType: 'broadcast_failed_to_dispatch',
          actorUserId: 'system:cron',
          summary: `Broadcast ${input.broadcastId} dispatch failed permanently`,
          payload: {
            broadcastId: input.broadcastId,
            reason,
            failedAt: now.toISOString(),
          },
          requestId: null,
        });
      });
    } catch {
      // best-effort
    }
    return err({ kind: 'broadcast_failed_to_dispatch', reason });
  }

  // Step 4 + 5: attach Resend ids + transition to 'sending' + audit
  try {
    const sentRow = await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachResendIds(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        resendAudienceId,
        resendBroadcastId,
      );
      const transitioned = await deps.broadcastsRepo.applyTransition(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        'sending',
        {
          sendingStartedAt: now,
          estimatedRecipientCount: resolvedResult.value.estimatedCount,
        },
      );
      await deps.audit.emit(tx, {
        tenantId: deps.tenant.slug,
        eventType: 'broadcast_send_started',
        actorUserId: 'system:cron',
        summary: `Broadcast ${input.broadcastId} dispatched to Resend`,
        payload: {
          broadcastId: input.broadcastId,
          resendAudienceId,
          resendBroadcastId,
          recipientCount: resolvedResult.value.estimatedCount,
          sendingStartedAt: now.toISOString(),
        },
        requestId: null,
      });
      return transitioned;
    });
    return ok({
      broadcast: sentRow,
      resendAudienceId,
      resendBroadcastId,
      recipientCount: resolvedResult.value.estimatedCount,
    });
  } catch (e) {
    // DB write failed AFTER Resend success. Next cron tick will re-detect
    // 'approved' status (we never updated) → re-call Resend with same
    // idempotency key → Resend dedupes; eventually the DB write succeeds.
    return err({
      kind: 'gateway_retryable',
      reason: `db_write_after_resend_success: ${
        e instanceof Error ? e.message : 'unknown'
      }`,
    });
  }
}

/**
 * Reconstructs the in-memory `RecipientSegment` discriminated-union from
 * the persisted broadcast row's `segmentType` + `segmentParams` +
 * `customRecipientEmails`.
 */
function buildSegmentFromBroadcast(b: Broadcast) {
  if (b.segmentType === 'all_members') return { kind: 'all_members' as const };
  if (b.segmentType === 'tier') {
    const tierCodes =
      (b.segmentParams as { tierCodes?: string[] } | null)?.tierCodes ?? [];
    return { kind: 'tier' as const, tierCodes };
  }
  if (b.segmentType === 'event_attendees_last_90d') {
    return { kind: 'event_attendees_last_90d' as const };
  }
  return {
    kind: 'custom' as const,
    emails: b.customRecipientEmails ?? [],
  };
}
