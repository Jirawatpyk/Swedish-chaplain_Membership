/**
 * `dispatch-scheduled-broadcast.ts` — F7 US2 cron worker.
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
 * Gateway error handling (review E3 — 2026-04-30):
 *   - `retryable` → row stays 'approved'; cron re-attempts next tick
 *     with the same idempotency key (Resend dedupes)
 *   - `idempotency_conflict` → success-replay; advance to 'sending'
 *     (Resend already accepted this broadcast on a prior attempt)
 *   - `resource_missing` (404) → emit `broadcast_resend_resource_missing`
 *     audit + transition to `failed_to_dispatch`
 *   - `permanent` → transition to 'failed_to_dispatch' + audit
 *     `broadcast_failed_to_dispatch`
 *
 * From-address (review C1):
 *   `deps.fromEmail` MUST be a verified Resend domain — wired from
 *   `env.broadcasts.fromEmail` in the composition root. The use-case
 *   does NOT carry a default to prevent fake-domain regressions.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
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

export type DispatchScheduledBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | {
      readonly kind: 'broadcast_invalid_state_transition';
      readonly observedStatus: string;
    }
  | { readonly kind: 'broadcast_audience_post_suppression_empty' }
  | {
      readonly kind: 'gateway_retryable';
      readonly subKind: 'network' | 'timeout' | 'server_5xx' | 'api';
      readonly reason: string;
    }
  | {
      readonly kind: 'broadcast_resend_resource_missing';
      readonly resourceType: 'audience' | 'broadcast';
      readonly resourceId: string;
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
  /**
   * From-address used as `from` on Resend `broadcasts.create`. MUST be a
   * verified Resend domain. No default — composition root passes
   * `env.broadcasts.fromEmail` (review C1 — 2026-04-30).
   */
  readonly fromEmail: string;
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

/**
 * Helper: transition a broadcast to `failed_to_dispatch` + emit a
 * matching audit event in a single tx. On cleanup failure, log loudly
 * (review E1) so ops can reconcile manually — silent swallow leaves
 * the row stuck in 'approved' with no audit trail.
 */
async function failDispatchAndAudit(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
  now: Date,
  reason: string,
  eventType: 'broadcast_failed_to_dispatch' | 'broadcast_resend_resource_missing',
  payload: Record<string, unknown>,
  phase: string,
): Promise<void> {
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
        eventType,
        actorUserId: 'system:cron',
        summary: `Broadcast ${input.broadcastId} dispatch failed (${phase})`,
        payload,
        requestId: null,
      });
    });
  } catch (cleanupErr) {
    logger.error(
      {
        err:
          cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        phase,
      },
      'broadcasts.dispatch.cleanup_failed',
    );
  }
}

/**
 * Duck-type a thrown gateway error into the
 * `BroadcastsGatewayError`-compatible shape. The infrastructure adapter
 * throws a `GatewayThrowable` carrying `kind` + `subKind` + `resourceType`
 * fields; we read them via structural typing so the Application layer
 * does not import from Infrastructure (Constitution Principle III).
 */
type GatewayThrownShape = {
  kind?: string;
  subKind?: string;
  reason?: string;
  resourceType?: 'audience' | 'broadcast';
  resourceId?: string;
  code?: string;
};

function classifyThrown(e: unknown): GatewayThrownShape & { kind: string } {
  if (typeof e === 'object' && e !== null && 'kind' in e) {
    const shape = e as GatewayThrownShape;
    if (typeof shape.kind === 'string') {
      return { ...shape, kind: shape.kind };
    }
  }
  return {
    kind: 'unknown',
    reason: e instanceof Error ? e.message : String(e),
  };
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
    // failed_to_dispatch + emit audit + member notification at route layer.
    await failDispatchAndAudit(
      deps,
      input,
      now,
      'audience_post_suppression_empty',
      'broadcast_failed_to_dispatch',
      {
        broadcastId: input.broadcastId,
        reason: 'audience_post_suppression_empty',
        failedAt: now.toISOString(),
      },
      'audience_post_suppression_empty',
    );
    return err({ kind: 'broadcast_audience_post_suppression_empty' });
  }

  // Step 3: Resend Broadcasts API calls (createAudience + addContacts +
  // createBroadcast + sendBroadcast). External calls happen OUTSIDE tx.
  // Empty string sentinel means "not yet assigned" — used by the
  // idempotency_conflict handler to distinguish pre-send vs post-send
  // conflict (the latter is recoverable as success-replay).
  let resendAudienceId = '';
  let resendBroadcastId = '';
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
      fromEmail: deps.fromEmail,
      replyToEmail: broadcast.replyToEmail,
      broadcastNameForResendDashboard: `${broadcast.fromName} — ${broadcast.subject.slice(0, 60)}`,
    });
    resendBroadcastId = createResult.broadcastId;

    await deps.broadcastsGateway.sendBroadcast(
      resendBroadcastId,
      buildIdempotencyKey(deps.tenant.slug, input.broadcastId as string),
    );
  } catch (e) {
    const shape = classifyThrown(e);

    // ---- Retryable: row stays 'approved' for next tick ---------------
    if (shape.kind === 'retryable') {
      const subKind =
        (shape.subKind as 'network' | 'timeout' | 'server_5xx' | 'api') ?? 'api';
      logger.warn(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId as string,
          subKind,
          reason: shape.reason ?? 'retryable',
        },
        'broadcasts.dispatch.gateway_retryable',
      );
      return err({
        kind: 'gateway_retryable',
        subKind,
        reason: shape.reason ?? 'retryable',
      });
    }

    // ---- Idempotency conflict: success-replay ------------------------
    // Resend already accepted this broadcast on a prior attempt. Treat
    // as success and fall through to attachResendIds + transition. We
    // know the resendBroadcastId IFF the conflict happened on `send`
    // (after createBroadcast); on early conflict we cannot recover the
    // ID and must drop to permanent.
    if (shape.kind === 'idempotency_conflict') {
      // If we never reached `createBroadcast` (resendBroadcastId is
      // unset because the conflict surfaced earlier), we cannot
      // safely advance — fall through to permanent so the next cron
      // tick re-resolves the row from scratch.
      if (resendBroadcastId === '') {
        logger.error(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            reason: shape.reason,
          },
          'broadcasts.dispatch.idempotency_conflict_pre_send',
        );
        // Fall through to permanent handler below.
      } else {
        logger.warn(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            resendBroadcastId,
          },
          'broadcasts.dispatch.idempotency_replay',
        );
        // Treat as success — fall through to attach + transition.
        // (No throw — we land in step 4.)
      }
    }

    // ---- Resource missing: 404 from Resend ---------------------------
    if (shape.kind === 'resource_missing') {
      await failDispatchAndAudit(
        deps,
        input,
        now,
        `resend_resource_missing:${shape.resourceType}`,
        'broadcast_resend_resource_missing',
        {
          broadcastId: input.broadcastId,
          resourceType: shape.resourceType,
          resourceId: shape.resourceId,
          failedAt: now.toISOString(),
        },
        'resend_resource_missing',
      );
      return err({
        kind: 'broadcast_resend_resource_missing',
        resourceType: shape.resourceType ?? 'broadcast',
        resourceId: shape.resourceId ?? (input.broadcastId as string),
      });
    }

    // ---- Permanent (and idempotency_conflict_pre_send fall-through) --
    if (shape.kind !== 'idempotency_conflict' || resendBroadcastId === '') {
      const reason =
        shape.reason ??
        (e instanceof Error ? e.message : 'unknown gateway error');
      await failDispatchAndAudit(
        deps,
        input,
        now,
        reason,
        'broadcast_failed_to_dispatch',
        {
          broadcastId: input.broadcastId,
          reason,
          code: shape.code,
          failedAt: now.toISOString(),
        },
        'permanent_failure',
      );
      return err({ kind: 'broadcast_failed_to_dispatch', reason });
    }
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
    // Review E2 — DB write failed AFTER Resend success. Recipients have
    // (or will) receive the broadcast but the DB row is still
    // 'approved'. Next cron tick will re-detect 'approved' status and
    // re-call Resend with the same idempotency key (Resend dedupes →
    // safe replay). MUST log at error severity so ops alerts fire and
    // operators can confirm the eventual reconciliation.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        resendAudienceId,
        resendBroadcastId,
        phase: 'db_write_after_resend_success',
        severity: 'critical',
      },
      'broadcasts.dispatch.db_write_after_resend_success',
    );
    return err({
      kind: 'gateway_retryable',
      subKind: 'api',
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
