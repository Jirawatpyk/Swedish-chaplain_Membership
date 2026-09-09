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
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '../ports/broadcasts-repo';
import type {
  BroadcastsGatewayPort,
  AudienceContact,
} from '../ports/broadcasts-gateway-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { AudienceMode } from '../../domain/audience-mode';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { EventAttendeesRepository } from '../ports/event-attendees-repository';
import type { PlansBridgePort } from '../ports/plans-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import { classifyThrown } from './_classify-thrown';
import { emitExpiredPlanAuditIfApplicable } from './_expired-plan-audit';
import { enqueueDispatchFailureNotification } from './_enqueue-dispatch-failure-notification';
import { resolveSegmentRecipients } from './resolve-segment-recipients';
import type { MemberFacingFailureReason } from './build-audience-tick';
import { recipientSegmentFromPersisted } from '../../domain/recipient-segment';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';
import { resendDashboardName } from '../format/resend-dashboard-name';

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
  | {
      readonly kind: 'dispatch.server_error';
      readonly message: string;
      /** Round 4 L3 — the loggable class; see `resolve.server_error`'s docblock. */
      readonly errClass?: string;
    };

export interface DispatchScheduledBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  readonly membersBridge: MembersBridgePort;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
  readonly eventAttendees: EventAttendeesRepository;
  /**
   * 108 PR-C — which resolver leg builds a member-based audience. Set by the
   * composition root from `FEATURE_CONTACT_MARKETING_RECIPIENTS`; see
   * `domain/audience-mode.ts`. Submit and dispatch MUST read the same value
   * so the estimate equals the dispatched set (SC-004).
   */
  readonly audienceMode: AudienceMode;
  /** 108 PR-C T085 — the same `audienceCeiling(batchingEnabled)` submit read. */
  readonly audienceCeiling: number;
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

type DispatchFailureReason =
  | 'resend_5xx'
  | 'resend_429'
  | 'resend_403'
  | 'app_error'
  | 'timeout';

/**
 * Map a free-text dispatch `phase` label to the bounded
 * `broadcasts.failed_to_dispatch.count` failure_reason enum. Round 5
 * simplification — extracted from a 4-level nested ternary. The phase
 * strings come from `classifyThrown` + caller call-sites; the matcher
 * is order-sensitive (more specific Resend HTTP-code phases first,
 * generic timeout next, app_error catch-all last).
 */
function phaseToFailureReason(phase: string): DispatchFailureReason {
  if (phase.includes('429')) return 'resend_429';
  if (phase.includes('403')) return 'resend_403';
  if (phase.includes('5xx') || phase.includes('server')) return 'resend_5xx';
  if (phase.includes('timeout')) return 'timeout';
  return 'app_error';
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
  /**
   * Stored verbatim in `broadcasts.failure_reason` and in the audit payload.
   * Free text on purpose — it carries the forensic detail (the transport class,
   * Resend's own message, the resource type) that an operator needs.
   */
  reason: string,
  eventType: 'broadcast_failed_to_dispatch' | 'broadcast_resend_resource_missing',
  payload: Record<string, unknown>,
  phase: string,
  /**
   * Round 4 L1 — what the MEMBER reads, which is not the same string.
   *
   * `reason` above is free text and reaches the email builder as a LOOKUP KEY;
   * three call sites on this leg passed composites (`retry_budget_exhausted_
   * after_1h:...`, `resend_resource_missing:...`, a raw `Error.message`), every
   * one of which matched nothing and rendered "a technical problem prevented
   * delivery". `tsc` saw two strings and was satisfied.
   *
   * Required and typed, so the compiler enumerates every call site rather than
   * leaving the next one to a reviewer. Deliberately NOT defaulted — a default
   * is how the previous version of this bug stayed invisible.
   */
  memberFacingReason: MemberFacingFailureReason,
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
        // R4 Types-#5 — failDispatchAndAudit is only invoked from the
        // dispatch use-case after `lockForUpdate('approved')` confirmed
        // the row was 'approved' at scan time. If a concurrent admin
        // cancelled in between, the conditional UPDATE returns 0 rows
        // → BroadcastConcurrentMutationError → caught by the outer
        // try/catch + logged as cleanup_failed (acceptable: the cancel
        // succeeded, our terminal-fail intent was correctly skipped).
        'approved',
      );
      await deps.audit.emit(tx, {
        tenantId: deps.tenant.slug,
        eventType,
        actorUserId: 'system:cron',
        summary: `Broadcast ${input.broadcastId} dispatch failed (${phase})`,
        payload,
        requestId: null,
      });
      // T172 — emit-site wiring (Phase 9). failure_reason maps phase
      // strings to the bounded enum used by the
      // broadcasts.failed_to_dispatch.count counter.
      // Round 5 simplification — replace the 4-level nested ternary with
      // a small helper that early-returns. CLAUDE.md forbids nested
      // ternaries; this also gives the helper a name visible in stack
      // traces if the mapping ever throws.
      if (eventType === 'broadcast_failed_to_dispatch') {
        broadcastsMetrics.failedToDispatchCount(
          deps.tenant.slug,
          phaseToFailureReason(phase),
        );
      }
      broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
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
      // Round 4 L1 — the TOKEN, not the free-text `reason` this used to forward.
      reason: memberFacingReason,
      now,
    });
  }
}


// `classifyThrown` moved to `_classify-thrown.ts` in 108 Phase 9 so
// `buildAudienceTick` reads a thrown gateway error the SAME way this path does.
// It had no catch at all, so every Resend failure reached the cron as
// `uncaught_error`. See that file for why one shared reader matters here.

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
      // Round 4 L3 — `message` is REDACTED in logs (it can carry a Neon error's
      // bound parameters, i.e. member addresses). The class is safe and is what
      // separates a DB blip from our own TypeError.
      errClass: errKind(e),
    });
  }

  if (broadcast === null) {
    return err({
      kind: 'broadcast_invalid_state_transition',
      observedStatus: 'unknown_or_already_processed',
    });
  }

  // Step 2: re-resolve recipients (segment may have changed since submit)
  // Review 2026-09-07 round 2 (C1/C2) — a tier row with no codes is refused
  // at the boundary, TERMINALLY. It used to reach the resolver as
  // `{ tier, [] }`: the primary_only read then addressed every active member,
  // and the all_contacts read's throw was retried every tick forever as a
  // "transient" `dispatch.server_error`. It is neither: it is a data defect,
  // so the broadcast fails with an honest reason and the member is told.
  const segmentResult = recipientSegmentFromPersisted(broadcast);
  if (!segmentResult.ok) {
    await failDispatchAndAudit(
      deps,
      input,
      now,
      'malformed_segment',
      'broadcast_failed_to_dispatch',
      {
        broadcastId: input.broadcastId,
        reason: 'malformed_segment',
        detail: segmentResult.error.reason,
        segmentType: segmentResult.error.segmentType,
        failedAt: now.toISOString(),
      },
      'malformed_segment',
      'malformed_segment',
      broadcast,
    );
    return err({ kind: 'broadcast_failed_to_dispatch', reason: 'malformed_segment' });
  }
  const segment = segmentResult.value;
  const requestingMember = broadcast.requestedByMemberId;
  // 108 PR-C (FR-022): the requesting member's PRIMARY email used to be read
  // here (W2-05) only to feed the resolver's email-equality self-exclusion.
  // Self-exclusion is by member id now, so that read — and its throw path —
  // is gone; the reply-to read at Step 1 is untouched.

  // W2-05, extended for 108 PR-D (review errors MEDIUM-5): the resolver has
  // bridge reads that throw by design — the suppression anti-join and the
  // per-contact opt-out filter, both fail-closed. An unhandled throw here
  // escapes to the cron route and lands in `summary.uncaught_error`, the class
  // that means "programming bug, page someone". A Neon blip is not that: it is
  // a typed `dispatch.server_error`, and the next tick retries because the
  // broadcast is still `approved`.
  let resolvedResult: Awaited<ReturnType<typeof resolveSegmentRecipients>>;
  try {
    resolvedResult = await resolveSegmentRecipients(
      {
        tenant: deps.tenant,
        membersBridge: deps.membersBridge,
        eventAttendees: deps.eventAttendees,
        marketingUnsubscribes: deps.marketingUnsubscribes,
        audienceMode: deps.audienceMode,
        audienceCeiling: deps.audienceCeiling,
      },
      {
        segment,
        phase: 'dispatch',
        requestingMemberId: requestingMember,
        customRecipients:
          broadcast.customRecipientEmails === null
            ? null
            : broadcast.customRecipientEmails.map((e) =>
                unsafeBrandEmailLower(e.toLowerCase().trim()),
              ),
      },
    );
  } catch (e) {
    return err({
      kind: 'dispatch.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
      // Round 4 L3 — `message` is REDACTED in logs (it can carry a Neon error's
      // bound parameters, i.e. member addresses). The class is safe and is what
      // separates a DB blip from our own TypeError.
      errClass: errKind(e),
    });
  }

  // 108 PR-C — the member-leg read failing is typed by the resolver
  // (research R8). It is the SAME class as the throw above: no transition,
  // no audit, the broadcast stays `approved` and the next tick retries. It
  // must never fall through to the branches below, which would mark the
  // broadcast failed with a fabricated "empty audience" reason.
  if (!resolvedResult.ok && resolvedResult.error.kind === 'resolve.server_error') {
    return err({
      kind: 'dispatch.server_error',
      message: resolvedResult.error.message,
    });
  }

  if (!resolvedResult.ok) {
    // Bug #13 fix (2026-07-10): distinguish the TWO terminal resolve
    // failures. `resolveSegmentRecipients` returns
    // `broadcast_empty_segment_blocked`, `broadcast_audience_too_large`, or
    // `resolve.server_error` (handled above). The segment is re-resolved here
    // because it can change since submit (e.g. membership grew past the
    // audience ceiling via a bulk import). Hard-coding 'audience_post_suppression_empty' for
    // EVERY error mislabelled the failure_reason, the audit payload, AND the
    // AS2 member-notification email as "empty audience" when the true cause was
    // "too large". Mirror submit-broadcast.ts's switch on error.kind.
    if (resolvedResult.error.kind === 'broadcast_audience_too_large') {
      await failDispatchAndAudit(
        deps,
        input,
        now,
        'audience_too_large',
        'broadcast_failed_to_dispatch',
        {
          broadcastId: input.broadcastId,
          reason: 'audience_too_large',
          count: resolvedResult.error.count,
          cap: resolvedResult.error.cap,
          failedAt: now.toISOString(),
        },
        'audience_too_large',
        'audience_too_large',
        broadcast,
      );
      return err({
        kind: 'broadcast_failed_to_dispatch',
        reason: 'audience_too_large',
      });
    }
    // Empty audience post-suppression — transition to failed_to_dispatch +
    // emit audit + Slice E member notification.
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
      'audience_post_suppression_empty',
      broadcast,
    );
    return err({ kind: 'broadcast_audience_post_suppression_empty' });
  }

  // Step 2b was a hand-off to the batch path when the audience had grown past
  // what one invocation could serially push. `ca51f59a1` deleted that path, so
  // the hand-off had nowhere to go: `DEFERRED_TO_BATCH_PATH` had no case in the
  // cron's switch, fell to `default` -> `unknown_error`, and left the row
  // `approved` with no claimant. Unreachable only because
  // `currentAudienceCeiling()` clamps to exactly `DELIVERABLE_RECIPIENTS_PER_TICK`
  // on this leg, so an over-size audience is already refused upstream as
  // `broadcast_audience_too_large` — which is the honest answer when there is no
  // second path to carry it. Removed in 108 Phase 9 review round 1 (S21) rather
  // than left to re-arm the first time someone raises the ceiling.

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

    // Code-review finding 9: `droppedByPreference` was computed, returned and
    // read by nobody, so "why did broadcast X reach 40 people instead of 55?"
    // had only a tenant-scoped counter behind it — unattributable to a
    // broadcast. Its sibling `orphans` is audited per member; this is the
    // cheaper equivalent while the sender-facing surface waits for PR-C
    // (T088/T089, recorded as an AMENDMENT at FR-022a): one line, with the
    // broadcast id, counts only — never an address (FR-053a).
    // Review 2026-09-07 — dispatch re-resolves, so a member who lost their
    // last eligible contact between submit and this tick surfaces HERE, and
    // this branch used to discard `orphans` entirely. Counts by reason only,
    // with the broadcast id (FR-053a) — the per-member audit stays at submit.
    if (resolvedResult.value.orphans.length > 0) {
      const byReason: Record<string, number> = {};
      for (const o of resolvedResult.value.orphans) {
        byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
      }
      logger.info(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId,
          orphans: resolvedResult.value.orphans.length,
          orphansByReason: byReason,
          estimatedAtSubmit: broadcast.estimatedRecipientCount,
          resolvedAtDispatch: resolvedResult.value.estimatedCount,
        },
        'broadcasts.dispatch.orphans_at_dispatch',
      );
    }
    if (resolvedResult.value.droppedByPreference > 0) {
      logger.info(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId,
          droppedByPreference: resolvedResult.value.droppedByPreference,
          recipientCount: resolvedResult.value.recipients.length,
        },
        'broadcasts.dispatch.marketing_opt_out_dropped',
      );
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
      broadcastNameForResendDashboard: resendDashboardName(broadcast.fromName, broadcast.subject),
      tenantDisplayName: deps.tenantDisplayName,
      locale: deps.locale,
    });
    resendBroadcastId = createResult.broadcastId;

    await deps.broadcastsGateway.sendBroadcast(
      resendBroadcastId,
      buildIdempotencyKey(deps.tenant.slug, input.broadcastId as string),
    );
  } catch (e) {
    // ---- Round 4 L2 — the audience-attach CAS loss, named ------------
    //
    // `attachAudienceId` is the only call in this try that throws
    // `BroadcastConcurrentMutationError`, so reaching here is unambiguous: a
    // sibling tick attached a different audience first. Two overlapping ticks
    // are reachable because `maxDuration` equals the cron cadence.
    //
    // Until now this fell to `classifyThrown`, which reads a `kind` field the
    // error class does not have, so it was classified `unknown` → permanent →
    // an attempt to mark the broadcast `failed_to_dispatch` WHILE THE WINNER WAS
    // SENDING IT. The row survived only because `failDispatchAndAudit`'s
    // transition carries `expectedFromStatus: 'approved'` and the winner had
    // already moved it to `sending`; the loser logged `cleanup_failed` and
    // stopped. Defence in depth held, but nothing here meant to rely on it.
    //
    // The real damage is the audience this tick just minted. Nothing collects
    // it: `reclaim-orphaned-audiences` filters on the broadcast ROW being gone
    // and the row is fine, while `cleanup-orphaned-audiences` deletes only the
    // id the row points at — the winner's. The Resend Free plan allows three
    // audiences, so a couple of these and `createAudience` starts refusing real
    // broadcasts.
    //
    // Delete it here, where the id is still in hand. Then this IS the benign
    // race the cron's `concurrent_skip` bucket calls it, rather than a bucket
    // that is quiet about a permanent leak.
    if (e instanceof BroadcastConcurrentMutationError) {
      if (resendAudienceId !== '') {
        try {
          await deps.broadcastsGateway.deleteAudience(resendAudienceId);
          logger.info(
            {
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              resendAudienceId,
              observedStatus: e.observedStatus,
            },
            'broadcasts.dispatch.audience_attach_lost_reclaimed',
          );
        } catch (reclaimErr) {
          // The one outcome an operator must act on: the audience exists at
          // Resend, no row references it, and no cron will find it. Error
          // severity because this is where the quota actually leaks.
          logger.error(
            {
              err: errKind(reclaimErr),
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              resendAudienceId,
              severity: 'critical',
            },
            'broadcasts.dispatch.audience_attach_lost_leaked',
          );
        }
      }
      // The REAL status from the probe, never a literal.
      return err({
        kind: 'broadcast_invalid_state_transition',
        observedStatus: e.observedStatus,
      });
    }

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

      // Verify-fix R4 (Simplify-#4, 2026-05-02): hoist scheduledFor +
      // elapsedMs locals so subsequent uses don't need `!` non-null
      // assertions (previously 4 instances). pastBudget definition
      // narrows scheduledFor to non-null implicitly, but TS doesn't
      // propagate that narrowing across the if-block boundary.
      //
      // R6 staff-review W-R1 fix — send-now broadcasts (`scheduledFor`
      // is null because the admin hit "Approve & send now") MUST also
      // honor the 1h retry budget. The prior code set
      // `elapsedMs = 0` for null-scheduledFor, making pastBudget
      // permanently false — a stuck send-now would retry forever.
      // Fallback epoch order: scheduledFor → approvedAt → createdAt.
      // approvedAt is the dispatcher-eligibility moment for send-now
      // (status transitions submitted → approved → sending happen
      // synchronously in the admin-approve-send-now use-case so the
      // fallback approximates "time since dispatch attempt began").
      const scheduledFor = broadcast.scheduledFor;
      const epochForBudget =
        scheduledFor ?? broadcast.approvedAt ?? broadcast.createdAt;
      const elapsedMs = now.getTime() - epochForBudget.getTime();
      const pastBudget = elapsedMs > RETRY_BUDGET_MS;

      if (pastBudget) {
        // R6 W-R1 fix — log both the scheduled epoch (if any) and the
        // budget epoch actually used. For send-now, scheduledFor is
        // null and the budget anchors on approvedAt (dispatch-eligibility
        // moment).
        const scheduledForIso = scheduledFor?.toISOString() ?? null;
        const epochForBudgetIso = epochForBudget.toISOString();
        logger.error(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            subKind,
            reason,
            scheduledFor: scheduledForIso,
            epochForBudget: epochForBudgetIso,
            sendMode: scheduledFor === null ? 'send_now' : 'scheduled',
            elapsedMs,
            severity: 'critical',
          },
          'broadcasts.dispatch.retry_budget_exhausted',
        );
        // E2 closure (verify-fix 2026-05-02) — explicit metric counter
        // is the alert-pipeline trigger for AS2 "admin alert is raised".
        // Steady state = 0; any non-zero count in a 15-minute window
        // pages on-call. See `docs/observability.md` § F7 alerts.
        broadcastsMetrics.dispatchBudgetExhausted(deps.tenant.slug, subKind);
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
            scheduledFor: scheduledForIso,
            elapsedMs,
            failedAt: now.toISOString(),
          },
          'retry_budget_exhausted',
          // Round 4 L1, the defect this parameter exists for. `budgetReason`
          // above is `retry_budget_exhausted_after_1h:{subKind}:{reason}` — good
          // forensics, and nothing in the message files. The member used to read
          // "a technical problem prevented delivery" for an hour-long provider
          // outage; they now read the sentence that names it.
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
        // Verify-fix R3 (Errors-C1, 2026-05-02): emit DISTINCT audit
        // event before falling through to the permanent handler so the
        // forensic trail shows "two workers raced through createAudience"
        // explicitly, separate from a generic Resend permanent error.
        // Best-effort emit — the permanent handler below will also
        // emit `broadcast_failed_to_dispatch`; both events together
        // tell the full story.
        try {
          await deps.audit.emit(null, {
            tenantId: deps.tenant.slug,
            eventType: 'broadcast_dispatch_idempotency_conflict_pre_send',
            actorUserId: 'system:cron',
            summary: `Broadcast ${input.broadcastId} hit idempotency conflict BEFORE sendBroadcast — concurrent worker raced through createAudience`,
            payload: {
              broadcastId: input.broadcastId,
              reason: shape.reason,
              resendAudienceId,
              failedAt: now.toISOString(),
            },
            requestId: null,
          });
        } catch (auditErr) {
          logger.error(
            {
              err: errKind(auditErr),
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
            },
            'broadcasts.dispatch.idempotency_conflict_pre_send_audit_emit_failed',
          );
        }
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
              err: errKind(countErr),
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
                // Round 4 (security finding 6) — this is an `audit_log.payload`,
                // not a pino line, and the distinction is the whole point:
                // `REDACT_PATHS` is a pino formatter and never touches a DB
                // write. The row is append-only with 5–10 year retention, is
                // emitted with `emit(null, …)` so it goes through the global
                // `db` as `neondb_owner` (BYPASSRLS) and therefore actually
                // lands, and it is rendered on the staff audit viewer.
                //
                // `countErr` comes from `getAudienceContactCount`, so it is a
                // `NeonDbError` carrying the failed SQL with its bound
                // parameters — on this module, member addresses — or Resend's
                // own message. None of that belongs in a record that cannot be
                // edited or deleted. The class keeps the forensic value: an
                // operator asking "why was the drift check unverifiable?" needs
                // DB-vs-provider, not the statement text.
                errorReason: errKind(countErr),
              },
              requestId: null,
            });
          } catch (auditErr) {
            logger.error(
              {
                err: errKind(auditErr),
                tenantId: deps.tenant.slug,
                broadcastId: input.broadcastId as string,
              },
              'broadcasts.dispatch.unverifiable_audit_emit_failed',
            );
          }
          // Round 3 observability G2 — emit metric so the catalogued
          // alert at observability.md § 22.3 (drift_check_unverifiable
          // > 1 / 1h → alarm) actually has a data source.
          broadcastsMetrics.driftCheckUnverifiable(deps.tenant.slug);
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
                err: errKind(auditErr),
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
          // Round 3 observability G2 — emit metric so the catalogued
          // alert at observability.md § 22.3 (audience_drift_detected
          // > 0 / 24h → page) actually has a data source.
          broadcastsMetrics.audienceDriftDetected(deps.tenant.slug);
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
        //   - `kind === 'idempotency_conflict'` so the next branch
        //     `if (shape.kind === 'resource_missing')` is skipped.
        //   - The permanent-handler condition is
        //     `shape.kind !== 'idempotency_conflict' || resendBroadcastId === ''`
        //     — both clauses are false here (kind matches AND id is set),
        //     so the permanent handler is intentionally skipped.
        //   - Execution exits the catch block and reaches Step 4
        //     (`attachResendIds` + `applyTransition('sending')` + audit).
        //
        // **Maintainer note**: if you add a NEW error kind whose handler
        // sits between this point and the permanent-handler `if`, gate
        // it on `shape.kind === '<new kind>'` to keep the success-replay
        // path intact — DO NOT use `else if` chains that could capture
        // this case by accident.
        // Verify-fix R3 (Comments-C1, 2026-05-02): replaced numeric line
        // refs with structural refs since Slice D + E + G1 added ~250
        // lines mid-file and the original anchors drifted.
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
        // No member email is sent on this arm — the notification is gated on
        // `eventType === 'broadcast_failed_to_dispatch'` and this one is
        // `broadcast_resend_resource_missing`, which the docblock describes as
        // needing an admin to look at the account. The parameter is required
        // anyway, and an unused value is still not licence to state a wrong
        // cause: a resource Resend no longer has IS a permanent gateway refusal.
        'gateway_permanent',
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
        // The token comes from `shape.KIND`, not `shape.reason`.
        //
        // A first draft of this line used `shape.reason ?? 'gateway_unknown'`
        // and a comment calling it "a real token when the classifier supplied
        // one". `tsc` rejected it, and the classifier says why:
        // `_classify-thrown.ts:20` types `reason?: string` and `:37` sets it to
        // `e.message` — it is free text on every path and never a token. (The
        // typed `reason` on `GatewayFailure` belongs to `build-audience-tick`'s
        // own wrapper, which MAPS the classifier's output; different value.)
        //
        // `kind` is the classification, so mirror it: `permanent` is a refusal
        // the adapter recognised, everything else reaching this arm — `unknown`,
        // and the idempotency-conflict fall-through — is honestly unclassified.
        shape.kind === 'permanent' ? 'gateway_permanent' : 'gateway_unknown',
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
      // G1 closure (verify-fix 2026-05-02) — pass `expectedFromStatus:
      // 'approved'` so the UPDATE serializes against any concurrent
      // worker that already transitioned the row to 'sending'.
      // Returning 0 rows → BroadcastConcurrentMutationError thrown →
      // caught below → mapped to broadcast_invalid_state_transition.
      // Recipients are protected from duplicate emails by Resend's
      // own idempotency-key dedup (gateway-level invariant); this
      // closes the DB-side audit/over-emit forensics issue.
      const transitioned = await deps.broadcastsRepo.applyTransition(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        'sending',
        {
          sendingStartedAt: now,
          estimatedRecipientCount: resolvedResult.value.estimatedCount,
        },
        'approved',
      );
      // E1 closure (verify-fix 2026-05-02) — AS1 audit payload now
      // includes the spec-required `scheduledFor` + `actualSendAt` +
      // `delaySeconds` fields. `actualSendAt === sendingStartedAt`
      // (same wall-clock moment, two field names per AS1 wording).
      // `delaySeconds` is the wait between the originator's planned
      // delivery time and the actual cron pickup — surfaces "how
      // late did the cron handler fire" for SC-001 quartile analysis.
      // For "send-now" paths where `scheduledFor === null`,
      // delaySeconds is null (the field is irrelevant).
      const actualSendAt = now;
      const scheduledForIso =
        broadcast.scheduledFor !== null
          ? broadcast.scheduledFor.toISOString()
          : null;
      const delaySeconds =
        broadcast.scheduledFor !== null
          ? Math.round(
              (actualSendAt.getTime() - broadcast.scheduledFor.getTime()) /
                1000,
            )
          : null;
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
          sendingStartedAt: actualSendAt.toISOString(),
          scheduledFor: scheduledForIso,
          actualSendAt: actualSendAt.toISOString(),
          delaySeconds,
        },
        requestId: null,
      });
      // T172 — emit-site wiring (Phase 9). Cron throughput counter +
      // audit-volume per SC-010 dashboards.
      broadcastsMetrics.cronDispatchedCount(deps.tenant.slug);
      broadcastsMetrics.auditEmitCount(
        deps.tenant.slug,
        'broadcast_send_started',
      );
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
    // `sentBroadcast` and `now` were passed here and never read by the callee;
    // dropped when the function moved to `_expired-plan-audit.ts` so both
    // dispatch paths share one implementation of the AS5 rule.
    await emitExpiredPlanAuditIfApplicable({ deps, broadcast });

    return ok({
      broadcast: sentRow,
      resendAudienceId,
      resendBroadcastId,
      recipientCount: resolvedResult.value.estimatedCount,
    });
  } catch (e) {
    // G1 closure (verify-fix 2026-05-02) — concurrent worker won the
    // sending-transition race. The other worker has already committed
    // the transition + audit + email; this worker's Resend external
    // calls were no-ops (idempotency-key dedup). Surface as
    // broadcast_invalid_state_transition for the cron route's bucket
    // counter; do NOT page on-call (no actual failure).
    // R3.6 L-7 — standardised on `instanceof` (matches snapshot use-
    // case + 5+ other broadcasts call-sites). The prior `.name ===`
    // idiom is realm-safer (survives cross-bundle serialization) but
    // we don't cross realm boundaries in F7 — every error origin is
    // in-process. `instanceof` gives compile-time type narrowing on
    // `e.observedStatus` which the string-compare didn't.
    if (e instanceof BroadcastConcurrentMutationError) {
      logger.warn(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId as string,
          resendAudienceId,
          resendBroadcastId,
        },
        'broadcasts.dispatch.concurrent_transition_lost',
      );
      return err({
        kind: 'broadcast_invalid_state_transition',
        // Round 4 L2 — was the literal `'sending_or_later'`, discarding the
        // status `throwConcurrentMutation` had just read from the row. The
        // comment six lines above says `instanceof` "gives compile-time type
        // narrowing on `e.observedStatus`" and then the value was thrown away:
        // the narrowing was obtained and not used.
        //
        // A guessed status in a field an operator reads is the actor-role
        // fabrication class in a different field — which is what
        // `throwConcurrentMutation`'s own docblock says the probe exists to
        // prevent. The import leg (`build-audience-tick.ts`) already read the
        // real value; this is the live leg catching up.
        observedStatus: e.observedStatus,
      });
    }
    // "The row is GONE" — a member-erasure cascade removed it between the claim
    // query and this write — as its own type rather than folded into the
    // concurrent-mutation case. Nothing failed that anyone can act on, and the
    // row it would page about no longer exists.
    //
    // Round 4 L6 — this arm WAS dead code until the commit that wrote this
    // comment. R2-1 added it citing `attachAudienceId`, which is called in a
    // different try block (`:524`, catch `:608`); nothing inside THIS try threw
    // `BroadcastNotFoundError`, because `attachResendIds` still threw a bare
    // `Error` and landed in `db_write_after_resend_success` instead. Making
    // `attachResendIds` use `throwConcurrentMutation` (round 4 F2) is what
    // finally reaches it — so the arm is kept and now genuinely runs, rather
    // than deleted as unreachable.
    if (e instanceof BroadcastNotFoundError) {
      logger.warn(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId as string,
          resendAudienceId,
          resendBroadcastId,
        },
        'broadcasts.dispatch.row_vanished',
      );
      return err({
        kind: 'broadcast_not_found',
        broadcastId: input.broadcastId as string,
      });
    }
    // Review E2 — DB write failed AFTER Resend success. Recipients have
    // (or will) receive the broadcast but the DB row is still
    // 'approved'. Next cron tick will re-detect 'approved' status and
    // re-call Resend with the same idempotency key (Resend dedupes →
    // safe replay). MUST log at error severity so ops alerts fire and
    // operators can confirm the eventual reconciliation.
    logger.error(
      {
        err: errKind(e),
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


