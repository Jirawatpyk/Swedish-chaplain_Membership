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
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import { resolveSegmentRecipients } from './resolve-segment-recipients';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';

/**
 * FR-021 retry budget — total wall-clock window from `scheduled_for`
 * during which retryable failures keep the row in 'approved' for the
 * cron handler to re-attempt every 5 min. Once the budget is exhausted,
 * the next retryable failure transitions the row to `failed_to_dispatch`
 * + emits the FR-021 / AS2 transactional notification to the member.
 *
 * Slice D (Phase 8 — 2026-05-02): the budget is enforced inside the
 * `gateway_retryable` branch of the dispatch use-case, NOT in a separate
 * "stuck-approved" reconciler. This keeps the dispatch path
 * self-contained (mirrors the F4 outbox dispatcher's per-attempt
 * permanent-fail decision) and avoids a second cron worker. The
 * downside: if Resend stays UP but the cron worker is offline for >1h
 * (cron-job.org outage), the row stays 'approved' until the next tick;
 * the budget only fires when WE attempt and Resend rejects. That edge
 * is acceptable because cron-job.org outages are rare and the next
 * tick will either succeed (budget moot) or fail and trigger terminal
 * transition.
 */
const RETRY_BUDGET_MS = 60 * 60 * 1000;

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
  /**
   * Display name of the dispatching tenant — rendered into the email
   * footer chrome (T147 — F7 US4 / FR-029). Composition root resolves
   * via `resolveTenantDisplayName(...)` and passes per-call.
   */
  readonly tenantDisplayName: string;
  /**
   * Recipient locale used by the email-template renderer to fill the
   * footer's bilingual unsubscribe CTA + receivedBecause line. MVP:
   * tenant default ('th' for SweCham; 'en' for JCC). F12 white-label
   * config will replace this with per-tenant + per-recipient locale.
   */
  readonly locale: 'en' | 'th' | 'sv';
  /**
   * Slice B (Phase 8) — used at successful sending transition to
   * compare originating member's CURRENT plan vs the snapshot taken at
   * submit time (`requestedByMemberPlanIdSnapshot`). On mismatch OR
   * current-plan lookup failure, emit `broadcast_sent_with_expired_member_plan`
   * audit (forensic only — dispatch still proceeds per AS5).
   */
  readonly plansBridge: PlansBridgePort;
  /**
   * Slice E (Phase 8) — used to enqueue the FR-021 / AS2 transactional
   * notification email when dispatch enters a terminal failure state
   * (1-hour budget exhausted OR permanent failure). Best-effort: failures
   * inside the enqueue are logged but do NOT block the terminal-fail
   * transition + audit (mirrors the US5 `enqueueDeliverySummaryEmail`
   * graceful-degrade pattern).
   */
  readonly emailTransactional: EmailTransactionalPort;
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
 *
 * Slice E (Phase 8): when `broadcast` is supplied and the failure
 * eventType is the FR-021 / AS2 terminal-fail kind, enqueue the
 * dispatch-failure transactional notification email AFTER the tx
 * commits (best-effort, failures logged + swallowed so the audit
 * trail remains the source of truth).
 */
async function failDispatchAndAudit(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
  now: Date,
  reason: string,
  eventType: 'broadcast_failed_to_dispatch' | 'broadcast_resend_resource_missing',
  payload: Record<string, unknown>,
  phase: string,
  broadcast: Broadcast | null = null,
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
    return; // Don't enqueue notification if the transition itself failed
  }

  // Slice E (FR-021 / AS2) — enqueue dispatch-failure transactional
  // notification email AFTER the tx commits. Best-effort: any failure
  // (member primary email lookup / outbox INSERT) is logged but does
  // NOT roll back the failed_to_dispatch transition. The audit trail
  // is the source of truth.
  if (broadcast !== null && eventType === 'broadcast_failed_to_dispatch') {
    await enqueueDispatchFailureNotification({
      deps,
      broadcast,
      reason,
      now,
    });
  }
}

/**
 * Slice E (Phase 8) — enqueue the FR-021 / AS2 transactional
 * notification email informing the originating member that their
 * scheduled broadcast did not go out. Quota reservation is preserved;
 * member can re-schedule from the admin queue.
 *
 * Best-effort: member-lookup failures + missing primary contact are
 * logged but skipped (NOT thrown). The terminal-fail transition + audit
 * are already committed by the time this runs. Mirrors the US5
 * `enqueueDeliverySummaryEmail` graceful-degrade pattern.
 */
export async function enqueueDispatchFailureNotification(args: {
  readonly deps: DispatchScheduledBroadcastDeps;
  readonly broadcast: Broadcast;
  readonly reason: string;
  readonly now: Date;
}): Promise<void> {
  const { deps, broadcast, reason, now } = args;

  let memberEmail: string | null;
  try {
    memberEmail = await deps.membersBridge.getMemberPrimaryContact(
      deps.tenant,
      broadcast.requestedByMemberId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch_failure_email.member_lookup_failed',
    );
    return;
  }

  if (memberEmail === null) {
    logger.warn(
      {
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch_failure_email.skipped_no_primary_contact',
    );
    return;
  }

  try {
    await deps.emailTransactional.sendMemberEmail(
      deps.tenant,
      {
        to: memberEmail,
        subject: broadcast.subject,
        templateKey: 'broadcast_failed_to_dispatch',
        payload: {
          broadcastId: broadcast.broadcastId,
          broadcastSubject: broadcast.subject,
          tenantDisplayName: deps.tenantDisplayName,
          scheduledFor:
            broadcast.scheduledFor !== null
              ? broadcast.scheduledFor.toISOString()
              : now.toISOString(),
          reason,
        },
        locale: deps.locale,
      },
      null,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
      },
      'broadcasts.dispatch_failure_email.enqueue_failed',
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
    // failed_to_dispatch + emit audit + Slice E member notification.
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
      broadcast,
    );
    return err({ kind: 'broadcast_audience_post_suppression_empty' });
  }

  // Step 3: Resend Broadcasts API calls (createAudience + addContacts +
  // createBroadcast + sendBroadcast). External calls happen OUTSIDE tx.
  // Empty string sentinel means "not yet assigned" — used by the
  // idempotency_conflict handler to distinguish pre-send vs post-send
  // conflict (the latter is recoverable as success-replay).
  //
  // **Orphan-audience prevention** (post-staff-review polish 2026-05-01):
  // If `broadcast.resendAudienceId` is already set, a prior dispatch
  // attempt's `createAudience` succeeded but a downstream call failed
  // (retryable). REUSE the existing audience instead of creating a
  // duplicate orphan. The audience is persisted via `attachAudienceId`
  // immediately after `createAudience` succeeds (a separate small tx)
  // so a crash between that and `addContactsToAudience` does not leak.
  // Audience name remains stable across retries (no timestamp suffix)
  // for Resend dashboard searchability.
  let resendAudienceId = broadcast.resendAudienceId ?? '';
  let resendBroadcastId = '';
  try {
    if (resendAudienceId === '') {
      const audienceResult = await deps.broadcastsGateway.createAudience(
        `broadcast-${deps.tenant.slug}-${input.broadcastId}`,
      );
      resendAudienceId = audienceResult.audienceId;
      // Persist immediately so a retry after a downstream failure
      // (addContactsToAudience / createBroadcast) reuses this audience
      // instead of creating an orphan one.
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.attachAudienceId(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          resendAudienceId,
        );
      });
    }

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
      tenantDisplayName: deps.tenantDisplayName,
      locale: deps.locale,
    });
    resendBroadcastId = createResult.broadcastId;

    await deps.broadcastsGateway.sendBroadcast(
      resendBroadcastId,
      buildIdempotencyKey(deps.tenant.slug, input.broadcastId as string),
    );
  } catch (e) {
    const shape = classifyThrown(e);

    // ---- Retryable: row stays 'approved' for next tick ---------------
    // Slice D (Phase 8 — FR-021 / AS2 1h retry budget): if the broadcast
    // is past its 1-hour budget from `scheduled_for`, this retryable
    // failure converts to a TERMINAL `broadcast_failed_to_dispatch` —
    // we stop attempting + transition + emit AS2 member notification
    // email. Within budget: original behaviour (row stays 'approved'
    // for the next 5-min cron tick).
    if (shape.kind === 'retryable') {
      const subKind =
        (shape.subKind as 'network' | 'timeout' | 'server_5xx' | 'api') ?? 'api';
      const reason = shape.reason ?? 'retryable';

      const pastBudget =
        broadcast.scheduledFor !== null &&
        now.getTime() - broadcast.scheduledFor.getTime() > RETRY_BUDGET_MS;

      if (pastBudget) {
        logger.error(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            subKind,
            reason,
            scheduledFor: broadcast.scheduledFor!.toISOString(),
            elapsedMs: now.getTime() - broadcast.scheduledFor!.getTime(),
            severity: 'critical',
          },
          'broadcasts.dispatch.retry_budget_exhausted',
        );
        const budgetReason = `retry_budget_exhausted_after_1h:${subKind}:${reason}`;
        await failDispatchAndAudit(
          deps,
          input,
          now,
          budgetReason,
          'broadcast_failed_to_dispatch',
          {
            broadcastId: input.broadcastId,
            reason: budgetReason,
            subKind,
            originalReason: reason,
            scheduledFor: broadcast.scheduledFor!.toISOString(),
            elapsedMs: now.getTime() - broadcast.scheduledFor!.getTime(),
            failedAt: now.toISOString(),
          },
          'retry_budget_exhausted',
          broadcast,
        );
        return err({
          kind: 'broadcast_failed_to_dispatch',
          reason: budgetReason,
        });
      }

      logger.warn(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId as string,
          subKind,
          reason,
        },
        'broadcasts.dispatch.gateway_retryable',
      );
      return err({
        kind: 'gateway_retryable',
        subKind,
        reason,
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
        // F7.1-IMP5 (round-4 follow-up) — idempotency_conflict post-send
        // means Resend accepted a prior attempt's `sendBroadcast`.
        // Recipients DID receive the email IF the prior attempt's
        // `addContactsToAudience` completed in full. Verify by querying
        // the audience contact count and comparing against the expected
        // recipient count; on mismatch, emit
        // `broadcast_resend_audience_drift` audit so ops can confirm
        // partial-delivery scope.
        const expectedCount = resolvedResult.value.estimatedCount;
        let actualCount: number | null = null;
        let countCheckFailed = false;
        try {
          // Discriminated union (review TYPES-2): translate to the
          // legacy `number | null` shape kept by this use-case so the
          // downstream drift / unverifiable audit branches stay
          // unchanged. `audience_missing` maps to null = no count
          // available; `present` maps to the count.
          const outcome =
            await deps.broadcastsGateway.getAudienceContactCount(
              resendAudienceId,
            );
          actualCount =
            outcome.kind === 'present' ? outcome.count : null;
        } catch (countErr) {
          // Round-5 R5-S1 — when the count fetch fails on a non-404
          // (e.g. Resend 5xx, network), we cannot verify drift. Emit a
          // dedicated forensic audit event so ops sees the
          // unverifiable-replay condition (it would otherwise be
          // silently skipped because actualCount stays null).
          countCheckFailed = true;
          logger.error(
            {
              err: countErr instanceof Error ? countErr.message : String(countErr),
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              resendBroadcastId,
              expectedRecipientCount: expectedCount,
              severity: 'critical',
            },
            'broadcasts.dispatch.audience_count_check_failed',
          );
          try {
            await deps.audit.emit(null, {
              tenantId: deps.tenant.slug,
              eventType: 'broadcast_resend_drift_check_unverifiable',
              actorUserId: 'system:cron',
              summary: `Broadcast ${input.broadcastId} idempotency replay — audience count unverifiable`,
              payload: {
                broadcastId: input.broadcastId,
                resendBroadcastId,
                resendAudienceId,
                expectedRecipientCount: expectedCount,
                errorReason:
                  countErr instanceof Error ? countErr.message : String(countErr),
              },
              requestId: null,
            });
          } catch (auditErr) {
            logger.error(
              {
                err: auditErr instanceof Error ? auditErr.message : String(auditErr),
                tenantId: deps.tenant.slug,
                broadcastId: input.broadcastId as string,
              },
              'broadcasts.dispatch.unverifiable_audit_emit_failed',
            );
          }
        }
        if (actualCount !== null && actualCount !== expectedCount) {
          // Audience drift detected — emit audit + log error so ops
          // can investigate. We DO advance to 'sending' because Resend
          // has already accepted the broadcast (idempotency replay);
          // the drift is a forensic record, not a blocker.
          try {
            await deps.audit.emit(null, {
              tenantId: deps.tenant.slug,
              eventType: 'broadcast_resend_audience_drift',
              actorUserId: 'system:cron',
              summary: `Broadcast ${input.broadcastId} audience drift on idempotency replay (expected ${expectedCount}, actual ${actualCount})`,
              payload: {
                broadcastId: input.broadcastId,
                resendBroadcastId,
                resendAudienceId,
                expectedRecipientCount: expectedCount,
                actualRecipientCount: actualCount,
                drift: expectedCount - actualCount,
              },
              requestId: null,
            });
          } catch (auditErr) {
            logger.error(
              {
                err: auditErr instanceof Error ? auditErr.message : String(auditErr),
                tenantId: deps.tenant.slug,
                broadcastId: input.broadcastId as string,
              },
              'broadcasts.dispatch.audience_drift_audit_emit_failed',
            );
          }
          logger.error(
            {
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              expectedRecipientCount: expectedCount,
              actualRecipientCount: actualCount,
              severity: 'critical',
            },
            'broadcasts.dispatch.audience_drift_detected',
          );
        } else if (!countCheckFailed) {
          logger.warn(
            {
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              resendBroadcastId,
              expectedRecipientCount: expectedCount,
              actualRecipientCount: actualCount,
            },
            'broadcasts.dispatch.idempotency_replay',
          );
        }
        // Treat as success — INTENTIONAL fall-through to Step 4
        // (attach + transition). Control flow:
        //   - kind === 'idempotency_conflict' so it skips the
        //     `resource_missing` check below (line ~466).
        //   - The permanent-handler condition at line ~489 is
        //     `shape.kind !== 'idempotency_conflict' || resendBroadcastId === ''`
        //     — both clauses are false here (kind matches AND id is set),
        //     so the permanent handler is intentionally skipped.
        //   - Execution exits the catch block and reaches Step 4.
        //
        // **Maintainer note**: if you add a NEW error kind whose handler
        // sits between this point and line ~489, gate it on
        // `shape.kind === '<new kind>'` to keep the success-replay path
        // intact — DO NOT use `else if` chains that could capture this
        // case by accident.
      }
    }

    // ---- Resource missing: 404 from Resend ---------------------------
    // NOTE: resource_missing emits a different audit event type
    // (`broadcast_resend_resource_missing`) so the dispatch-failure
    // notification email is NOT enqueued here — only `broadcast_failed_to_dispatch`
    // event-type triggers the Slice E email. resource_missing is an
    // ops-side issue (admin manually deleted Resend resource) requiring
    // admin action, not member notification.
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
        broadcast,
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
        broadcast,
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

    // Slice B (Phase 8 — T171 / AS5) — forensic audit when the
    // originating member's CURRENT plan no longer matches the snapshot
    // taken at submit time. The broadcast is dispatched ANYWAY because
    // entitlement was confirmed at submit + approve (per AS5 the tenant
    // accepted the obligation). The audit gives admins observability
    // for the "member upgraded → broadcast went out as if they still
    // had the lower tier" or "member downgraded between approve + send"
    // edge case.
    //
    // Best-effort: lookup failures (Neon outage, plan-bridge throw)
    // are logged but do NOT roll back the successful sending transition.
    await emitExpiredPlanAuditIfApplicable({
      deps,
      broadcast,
      sentBroadcast: sentRow,
      now,
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
 * Slice B (Phase 8 — T171 / AS5) — emit `broadcast_sent_with_expired_member_plan`
 * audit when the originating member's CURRENT plan differs from the
 * snapshot at submit time, OR the current plan no longer entitles
 * (PlansBridge returns error). Forensic only — never throws, never
 * blocks dispatch (lookup failures are swallowed with a logger.error).
 */
async function emitExpiredPlanAuditIfApplicable(args: {
  readonly deps: DispatchScheduledBroadcastDeps;
  readonly broadcast: Broadcast;
  readonly sentBroadcast: Broadcast;
  readonly now: Date;
}): Promise<void> {
  const { deps, broadcast } = args;

  let planLookup;
  try {
    planLookup = await deps.plansBridge.getPlanForMember(
      deps.tenant,
      broadcast.requestedByMemberId,
    );
  } catch (e) {
    // Plan-bridge threw (Neon outage, repository bug). Forensic audit
    // is best-effort; log + skip without blocking the dispatch result.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch.expired_plan_check_threw',
    );
    return;
  }

  const noLongerEntitled = !planLookup.ok;
  const planChanged =
    planLookup.ok &&
    planLookup.value.planId !== broadcast.requestedByMemberPlanIdSnapshot;

  if (!noLongerEntitled && !planChanged) {
    return; // No expired-plan condition; no audit emit
  }

  try {
    await deps.audit.emit(null, {
      tenantId: deps.tenant.slug,
      eventType: 'broadcast_sent_with_expired_member_plan',
      actorUserId: 'system:cron',
      summary: `Broadcast ${broadcast.broadcastId} dispatched despite member plan change since submit`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        planAtSubmit: broadcast.requestedByMemberPlanIdSnapshot,
        planAtDispatch: planLookup.ok ? planLookup.value.planId : null,
        planLookupError: planLookup.ok ? null : planLookup.error.kind,
        currentlyEntitled: planLookup.ok,
      },
      requestId: null,
    });
  } catch (auditErr) {
    logger.error(
      {
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
      },
      'broadcasts.dispatch.expired_plan_audit_emit_failed',
    );
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
