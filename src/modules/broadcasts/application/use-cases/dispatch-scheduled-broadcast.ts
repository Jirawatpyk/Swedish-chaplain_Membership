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
 *     with the same idempotency key. **Round 4 F4 — do NOT read that as "so
 *     the duplicate is collapsed".** MEASURED 2026-09-09 against the live
 *     account: two identical `POST /broadcasts` calls carrying the SAME
 *     `Idempotency-Key` created TWO resources. The header is inert on that
 *     endpoint. `/broadcasts/{id}/send` cannot be probed without sending real
 *     mail, so its behaviour is unmeasured — and assuming a provider honours the
 *     header on one endpoint of an API surface where it ignores it on another is
 *     a guess, not a safety property.
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
import { loadBrandChrome } from './_load-brand-chrome';
import type { BrandChromePort } from '../ports/brand-chrome-port';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditEmitInput, AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '../ports/broadcasts-repo';
import { standingRefusalAuditEvent } from './_member-send-standing';
import {
  decideDispatchStanding,
  recordDispatchHold,
  type DispatchStandingDeps,
} from './_dispatch-standing-gate';
import type {
  BroadcastsGatewayPort,
  AudienceContact,
  GatewayRetryableSubKind,
  RetrievedBroadcastResource,
  RetrieveBroadcastOutcome,
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
import {
  resolveSegmentRecipients,
  type ResolveSegmentOutput,
} from './resolve-segment-recipients';
import type { MemberFacingFailureReason } from './build-audience-tick';
import { recipientSegmentFromPersisted } from '../../domain/recipient-segment';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';
import { resendDashboardName } from '../format/resend-dashboard-name';
// FR-021 retry budget — `RETRY_BUDGET_MS` of retryable failures, counted from
// the FIRST retryable failure of the current dispatch attempt (F119 PR-E,
// migration 0311), during which the row stays `approved` for the next 5-min
// tick. Once spent, the next retryable failure moves the row to
// `failed_to_dispatch` and emits the FR-021 / AS2 member notification.
//
// Slice D (Phase 8 — 2026-05-02): enforced inside the `gateway_retryable`
// branch of the dispatch use-case, NOT in a separate "stuck-approved"
// reconciler — the dispatch path stays self-contained (mirrors the F4 outbox
// dispatcher's per-attempt permanent-fail decision). The budget fires only when
// WE attempt and Resend rejects; a paused cron, a hold or the read-only freeze
// never spends it, because nothing failed.
import { dispatchRetryEpoch, resetDispatchRetryClock, RETRY_BUDGET_MS } from './_dispatch-retry-epoch';

/**
 * The transport class a retryable gateway throw carried, or `unclassified`
 * when it carried none this build knows. Round 4 F8 removed the `?? 'api'`
 * default from `build-audience-tick.ts`; this leg kept it until F119 PR-E's
 * whole-branch review. `dispatch_budget_exhausted` pages on-call, so a fault
 * nobody classified must not arrive labelled as a real transport class — and
 * the old `as … ?? 'api'` cast also let a FIFTH string through to the metric
 * raw. Narrowed against the same four literals as `viaGateway` there.
 */
type RetryableSubKind = GatewayRetryableSubKind | 'unclassified';

function retryableSubKind(sub: string | undefined): RetryableSubKind {
  return sub === 'network' || sub === 'timeout' || sub === 'server_5xx' || sub === 'api'
    ? sub
    : 'unclassified';
}

export type DispatchScheduledBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | {
      readonly kind: 'broadcast_invalid_state_transition';
      readonly observedStatus: string;
    }
  | { readonly kind: 'broadcast_audience_post_suppression_empty' }
  | {
      readonly kind: 'gateway_retryable';
      readonly subKind: RetryableSubKind;
      readonly reason: string;
    }
  | {
      readonly kind: 'broadcast_resend_resource_missing';
      readonly resourceType: 'audience' | 'broadcast' | 'import';
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
      /**
       * 2026-09-10 follow-up (5) — WHICH step faulted. The route labels
       * `broadcasts.dispatch_resolve_failed.total` with it: that counter was
       * incremented for every kind of `dispatch.server_error` while its name
       * and runbook (§ C: F3 pages / Neon / opt-out lookup) described one.
       * Required and closed, so a new return site has to say where it is.
       */
      readonly phase: DispatchServerErrorPhase;
    };

/**
 * The six places this leg can answer `dispatch.server_error` (row stays
 * `approved`, next tick retries). `lock` — Step 1 could not read the row;
 * `standing` — the member-standing read (halt list or F8 access) failed, so
 * the gate was not decided (F119 PR-A — fail CLOSED: nothing is sent);
 * `resolve` — Step 2 could not build the audience (the case the counter was
 * named for); `inherited_status` — the probe answered a status this build
 * cannot interpret and the tick REFUSED rather than guess; `persist_broadcast_id`
 * — the pre-send persist faulted; `terminal_write` (F119 PR-A R3) — a terminal
 * `failed_to_dispatch` write did not commit, so nothing was recorded and nobody
 * was told (the import leg's `terminal_write_failed`, same label). The import
 * leg has its own set; the metric's label type is the union.
 */
export type DispatchServerErrorPhase =
  | 'lock'
  | 'standing'
  | 'resolve'
  | 'inherited_status'
  | 'persist_broadcast_id'
  | 'terminal_write';

/** What Step 2 hands Step 3 and Step 4 once a resolve has been ACCEPTED. */
type ResolvedAudience = ResolveSegmentOutput;

export interface DispatchScheduledBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  /**
   * F119 T031 (FR-041c) — the tenant's brand chrome, read LIVE at dispatch
   * and handed to the gateway so the delivered email equals the preview.
   * REQUIRED: a composition that forgot it would ship every E-Blast without
   * the postal address FR-041c requires, silently. The cron composes
   * `brandChromePort` (the seam lives in `src/lib`, so the module's deps
   * factory returns this type without it). A read FAULT degrades to no
   * chrome (fail-soft, metered) — a brand outage must never fail a send.
   */
  readonly brandChrome: BrandChromePort;
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
  /**
   * F119 PR-A — the member-standing reads (the F7 halt list + F8 membership
   * access) re-applied at SEND time, the same reads submit, approve-as-
   * submitted and the promotion make. REQUIRED: a composition that forgot it
   * would send for a halted or ended membership, silently. The cron wires the
   * halt read through its per-tick memo, so a tick reads the list once, and
   * sets `haltReadFresh` to the raw bridge for the re-read before a refusal.
   */
  readonly sendStanding: DispatchStandingDeps;
}

export interface DispatchScheduledBroadcastInput {
  readonly broadcastId: BroadcastId;
}

/**
 * What a tick that did not fail answers. `sent` — the send was handed to
 * Resend (or a prior tick's already was) and the row is `sending`.
 * `dispatch_held_member_suspended` (F119 PR-A R1) — the requesting member's
 * membership is `suspended` (awaiting payment), so NOTHING happened: no Resend
 * call, no write, no audit, no email; the row stays `approved` and the next
 * tick asks again. Not an error — the cron counts it `held`.
 */
export type DispatchScheduledBroadcastOutput =
  | {
      readonly kind: 'sent';
      readonly broadcast: Broadcast;
      readonly resendAudienceId: string;
      readonly resendBroadcastId: string;
      readonly recipientCount: number;
    }
  | { readonly kind: 'dispatch_held_member_suspended' };

function buildIdempotencyKey(tenantId: string, broadcastId: string): string {
  return `broadcast-${tenantId}-${broadcastId}`;
}

type DispatchFailureReason =
  | 'resend_5xx'
  | 'resend_429'
  | 'resend_403'
  | 'app_error'
  | 'timeout'
  /**
   * F119 PR-A — the member was halted or not in good standing at send time. A
   * decision about the MEMBER, not a fault: counted apart so it can never
   * inflate `app_error`, which is what the dispatch-failure alert reads.
   */
  | 'member_ineligible';

/** The `phase` label a standing refusal passes to `failDispatchAndAudit`. */
const MEMBER_STANDING_PHASE = 'member_standing';

/**
 * Map a free-text dispatch `phase` label to the bounded
 * `broadcasts.failed_to_dispatch.count` failure_reason enum. Round 5
 * simplification — extracted from a 4-level nested ternary. The phase
 * strings come from `classifyThrown` + caller call-sites; the matcher
 * is order-sensitive (the exact member-standing phase first, then the more
 * specific Resend HTTP-code phases, generic timeout next, app_error
 * catch-all last).
 */
function phaseToFailureReason(phase: string): DispatchFailureReason {
  if (phase === MEMBER_STANDING_PHASE) return 'member_ineligible';
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
 *
 * F119 PR-A R3 — answers whether the terminal write COMMITTED. It used to
 * return nothing, so every caller answered `broadcast_failed_to_dispatch` —
 * which the cron buckets `permanent_failed`, "finished, nothing to do" — for a
 * row that was still `approved`. On `false` the caller answers
 * `terminalWriteFailed()` instead (the import leg's `terminal_write_failed`):
 * the next tick retries, and if a concurrent cancel is what won, that tick
 * reads a non-`approved` row and reports `concurrent_skip`.
 *
 * R4 — the counters move only AFTER the commit. They sat inside the tx, before
 * the second audit INSERT, so a refusal whose own audit row failed (rolling the
 * whole tx back) still counted a failure and an audit row that never existed.
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
  /**
   * F119 PR-A — a second audit row that must commit WITH the terminal
   * transition or not at all (the standing refusal's own event). In the same
   * tx on purpose: written separately, a lost transition (a concurrent cancel
   * won) would still leave a refusal row for a broadcast that was cancelled.
   */
  extraAudit: AuditEmitInput | null = null,
): Promise<boolean> {
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
      if (extraAudit !== null) {
        await deps.audit.emit(tx, extraAudit);
      }
    });
  } catch (cleanupErr) {
    logger.error(
      {
        // FINAL round H-3. The sweep that claimed "genuinely none in a touched
        // file" missed this one because it is the MULTI-LINE form — which round 4
        // had explicitly warned would raise the count. `cleanupErr` is an
        // audit-INSERT failure, i.e. a `NeonDbError` carrying the statement and
        // its bound parameters, and on this module a bound parameter is a member's
        // email address. Neither `err` nor `message` is in `REDACT_PATHS`.
        err: errKind(cleanupErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        phase,
      },
      'broadcasts.dispatch.cleanup_failed',
    );
    return false; // Don't enqueue notification if the transition itself failed
  }

  // Committed — only now count it (R4). T172 — failure_reason maps phase
  // strings to the bounded enum used by the broadcasts.failed_to_dispatch.count
  // counter; Round 5 replaced a 4-level nested ternary with the named helper.
  if (eventType === 'broadcast_failed_to_dispatch') {
    broadcastsMetrics.failedToDispatchCount(deps.tenant.slug, phaseToFailureReason(phase));
  }
  broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
  if (extraAudit !== null) {
    broadcastsMetrics.auditEmitCount(deps.tenant.slug, extraAudit.eventType);
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
  return true;
}

/**
 * F119 PR-A R3 — what a caller answers when `failDispatchAndAudit` reports that
 * its terminal write did not commit: nothing was recorded and nobody was told,
 * so the tick is a transient server error (the row stays `approved`), never a
 * `permanent_failed`. Mirrors the import leg's `failTerminally`.
 */
function terminalWriteFailed(): Result<DispatchScheduledBroadcastOutput, DispatchScheduledBroadcastError> {
  return err({ kind: 'dispatch.server_error', message: 'terminal_write_failed', phase: 'terminal_write' });
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
      phase: 'lock',
    });
  }

  if (broadcast === null) {
    return err({
      kind: 'broadcast_invalid_state_transition',
      observedStatus: 'unknown_or_already_processed',
    });
  }

  // Step 1b (2026-09-10 follow-up 3): the inherited-id probe, BEFORE Step 2.
  //
  // It sat inside the Step-3 try, i.e. AFTER Step 2's terminal refusals. A row
  // carrying an id already handed to `/send` — mail out, status flip lost —
  // could therefore be marked `failed_to_dispatch` by THIS tick's re-resolve
  // (a bulk import pushed the segment past the ceiling in the five minutes
  // since), releasing the quota slot and emailing the member that a delivered
  // broadcast had failed. Step 2 now knows the answer first. It also means a
  // probe that cannot be answered returns before the F3 page walk runs.
  let resendAudienceId = broadcast.resendAudienceId ?? '';
  // F4 — read from the ROW, not a fresh ''. This was the whole bug: the audience
  // id was inherited from a prior tick and the broadcast id never was, so every
  // re-entered tick called `createBroadcast` again.
  let resendBroadcastId = broadcast.resendBroadcastId ?? '';
  // Frozen at entry so the send gate below can tell "a prior tick minted this"
  // from "I minted it a few lines ago" — `resendBroadcastId` is reassigned in
  // between, and after that the two are indistinguishable.
  const inheritedBroadcastId = resendBroadcastId;
  // Whether THIS tick actually called `sendBroadcast`. The success-replay arm
  // below used to gate on `resendBroadcastId !== ''`, which was exact only while
  // the id could not be inherited: a non-empty id then implied this tick had
  // passed `createBroadcast`, after which the send was the only call left. F4
  // broke that — `addContactsToAudience` and the probe both run BEFORE the send
  // with an inherited id in hand, and `classifyResendError` maps every 409 from
  // ANY endpoint to `idempotency_conflict`. So a pre-send 409 could advance the
  // row to `sending` with nothing ever sent.
  let sendAttempted = false;
  /**
   * Set by the probe below when an INHERITED resource was already handed to
   * `/send` by an earlier tick. Declared out here because `advanceToSending`
   * (Step 4 — reached from TWO places: after the Step-3 catch, and directly
   * from Step 2's replay-refusal return) needs all three to write a truthful
   * record: without them
   * its audit payload stamped `actualSendAt = now` for a send that happened up
   * to an hour earlier, and the value was already in hand and discarded.
   */
  let alreadyHandedToSend = false;
  let observedResendStatus: RetrievedBroadcastResource['status'] | null = null;
  let resendSentAt: string | null = null;
  // ---- The probe runs FIRST, before Step 2 and before anything touches Resend
  //
  // An INHERITED id means a prior tick minted the resource and we do not know
  // whether its send was accepted. Everything about this file refuses to guess
  // at Resend's replay semantics -- `Idempotency-Key` is MEASURED inert on
  // `POST /broadcasts`, and `/send` cannot be probed without sending real mail
  // -- so ask instead of assuming a 409 will come back.
  //
  // **Position is the fix, not just the question.** This sat AFTER
  // `addContactsToAudience`, and `withRetry` short-circuits a non-retryable
  // GatewayThrowable immediately -- so a 409 from the first duplicate contact
  // threw before the probe ever ran.
  //
  // **ASSUMED, NOT MEASURED:** that `POST /contacts` answers 409 for a duplicate
  // address. Every other provider claim on this branch carries a MEASURED date;
  // this one does not, and it is worth naming because it cuts both ways — if it
  // were true, the file's own 1-hour FR-021 budget could only ever have fired
  // ONCE, since the second tick would 409 and go terminal. Prod could not settle
  // it (checked 2026-09-10: 1 `broadcast_send_started` row in total, 0
  // `broadcast_dispatch_idempotency_conflict_pre_send`, `broadcasts` empty after
  // the June wipe). The guard below is keyed off our own write ordering instead,
  // so nothing here depends on the answer. A tick re-entering after a successful send
  // therefore re-pushed every contact, took the 409, found `sendAttempted`
  // false, and terminated the row with the FR-021 email telling the member
  // their broadcast had FAILED. It had not. Asking first also skips the
  // re-push entirely, which is ~72 s of a 300 s budget for a 150-member
  // audience at the measured 2.08 req/s.
  if (inheritedBroadcastId !== '') {
    let probe: RetrieveBroadcastOutcome;
    try {
      probe = await deps.broadcastsGateway.retrieveBroadcast(resendBroadcastId);
    } catch (e) {
      const shape = classifyThrown(e);
      // F119 PR-E (review M1) — a RETRYABLE probe throw is retried and never
      // budgeted (nor stamped). Follow-up (4) put it on the FR-021 budget as
      // "just another gateway call", but a probe that cannot be answered says
      // nothing about whether this inherited resource was already handed to
      // `/send` — the same reason the `unknown` arm below refuses without a
      // clock. The sequence that made it concrete: first blip stamped at T0 →
      // the send SUCCEEDS at T0+5 but the `sending` flip hits a DB fault that
      // lasts an hour (the post-send clock reset in `advanceToSending` fails
      // with it) → the next tick's probe throws one blip → budget from T0 →
      // `failed_to_dispatch`, a false member email and a released quota slot
      // for mail that went out. The budget still bounds the SEND: once the
      // probe answers `draft`, a failing send is measured from the row's stamp.
      // The operator signal for a probe that never answers is the same as the
      // `unknown` arm's: `broadcasts_approved_overdue_count`.
      if (shape.kind === 'retryable') {
        const subKind = retryableSubKind(shape.subKind);
        logger.warn(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            resendBroadcastId,
            subKind,
          },
          'broadcasts.dispatch.inherited_probe_retryable',
        );
        return err({ kind: 'gateway_retryable', subKind, reason: shape.reason ?? 'retryable' });
      }
      // Every other class follows the rules of every other gateway throw. This
      // is not the Step-3 try, so it cannot borrow that catch; it borrows the
      // function the catch calls.
      return await settleGatewayThrow(deps, input, broadcast, now, e, shape);
    }
    if (probe.kind === 'present') {
      observedResendStatus = probe.resource.status;
      // POSITIVE, and that is the whole lesson of this gate's first version. It
      // was `status !== 'draft'`, a negative test over a provider string that
      // `normaliseStatus` used to close by fabricating `'queued'` -- so
      // `'cancelled'` and every status this build had never seen read as
      // "already sent", the send was SKIPPED, the row still advanced to
      // `sending`, and `reconcile-stuck-sending` later stamped `sent` and burned
      // the member's annual quota for mail that never went out.
      if (
        probe.resource.status === 'queued' ||
        probe.resource.status === 'sending' ||
        probe.resource.status === 'sent'
      ) {
        alreadyHandedToSend = true;
        // Carried into Step 4's audit row. `null` for `queued`/`sending` is the
        // honest answer -- "accepted, not yet reported sent" -- and Step 4 must
        // then omit `delaySeconds` rather than compute one from `now`.
        resendSentAt = probe.resource.sentAt;
        logger.warn(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            resendBroadcastId,
            observedResendStatus: probe.resource.status,
          },
          'broadcasts.dispatch.inherited_broadcast_already_handed_to_send',
        );
      } else if (probe.resource.status === 'unknown') {
        // FAIL CLOSED. Re-sending on a status we cannot interpret risks a second
        // delivery to the whole audience, and skipping the send risks recording a
        // dispatch that never happened -- and BOTH directions are unmeasured.
        // Refusing keeps the row `approved` and fires the route's counter with
        // `phase: 'inherited_status'`, which ALARMS (not pages) at ≥15 min
        // sustained; `observability.md` § 22.3 and `broadcast-audience-build.md`
        // § C step 1 route that phase to a human, not to the F3 triage tree.
        //
        // **NOT bounded by FR-021, on purpose.** The budget lives in
        // `applyRetryBudget` and is applied to gateway THROWS; this is a
        // deliberate refusal, and a clock on it would turn "we do not know
        // whether this was sent" into "it failed, member told" after an hour —
        // the guess the refusal exists to avoid. If Resend renamed a status we
        // already know, every inherited-id tick would refuse every 5 minutes
        // until someone acts; `broadcasts_approved_overdue_count` is what
        // eventually notices. Recovery is either adding the status to
        // `normaliseStatus` and deploying, or deleting the resource at Resend so
        // the probe answers `not_found`.
        //
        // Still the right trade: a stuck broadcast is recoverable by a human; a
        // duplicate send to 150 real members is not.
        logger.error(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            resendBroadcastId,
            // The adapter logs the RAW status on its own line but carries no
            // broadcast id; this line carries the ids but not the raw value.
            // Neither is joinable alone, so name what we mapped it to.
            observedResendStatus: probe.resource.status,
            severity: 'critical',
          },
          'broadcasts.dispatch.inherited_resource_unrecognised_status',
        );
        return err({
          kind: 'dispatch.server_error',
          message: 'inherited_resource_unrecognised_status',
          errClass: 'gate',
          phase: 'inherited_status',
        });
      } else {
        // `'draft'` (never sent -- the case this whole gate exists for) and
        // `'cancelled'`. Both proceed to the send, where a genuine refusal
        // reaches the permanent / `resource_missing` arms and is reported as
        // what it is. Logged HERE because the fall-through is a decision, and
        // the only other signal for `cancelled` is the absence of one.
        logger.warn(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            resendBroadcastId,
            observedResendStatus: probe.resource.status,
          },
          'broadcasts.dispatch.inherited_broadcast_send_attempted',
        );
      }
    }
    // `not_found` deliberately falls through: the send 404s into the
    // `resource_missing` arm, which exists for exactly that.
  }

  // Step 1c (F119 PR-A): the member's standing, re-read at SEND time.
  //
  // Submit, approve-as-submitted and the promotion read it; nothing after them
  // did, so an E-Blast approved days ahead went out after its member was
  // halted, suspended, terminated or refunded (0306 ends coverage at once).
  //
  // After the probe, and gated on it exactly as the Step-2 refusals are: mail a
  // prior tick already handed to `/send` is out, and refusing it would record
  // `failed_to_dispatch`, free the quota slot and email the member that a
  // delivered broadcast failed. Outside every transaction: the Step-1 lock tx
  // has committed, and these reads take their own pool connections (the R-L3
  // rule approve and confirm-schedule follow).
  //
  // The decision is `_dispatch-standing-gate.ts`'s, shared with the import
  // leg: a `suspended` membership (awaiting payment) is HELD — nothing sent, the
  // only write the FR-021 retry-clock reset, the row stays `approved`, the next
  // tick asks again (R1); a halt
  // (re-read uncached first, R2) or an ENDED membership is a PERMANENT
  // refusal; a read that fails decides nothing — fail CLOSED, nothing is sent.
  if (!alreadyHandedToSend) {
    const standing = await decideDispatchStanding(
      deps.sendStanding,
      deps.tenant,
      broadcast.requestedByMemberId,
    );
    if (standing.kind === 'hold') {
      recordDispatchHold(deps.tenant.slug, input.broadcastId as string, 'live');
      // F119 PR-E (review H1) — the one write a hold makes: reset the FR-021
      // clock, so a failure → a two-day hold → the member pays → one blip is
      // not `retry_budget_exhausted`. Own tx, no row lock held (the Step-1 tx
      // committed); a stamped row only, and best-effort — still held on failure.
      await resetDispatchRetryClock(deps, input.broadcastId, 'broadcasts.dispatch.retry_clock_clear_failed');
      return ok({ kind: 'dispatch_held_member_suspended' });
    }
    if (standing.kind === 'refuse') {
      const { reason } = standing;
      const recorded = await failDispatchAndAudit(
        deps,
        input,
        now,
        reason,
        'broadcast_failed_to_dispatch',
        {
          broadcastId: input.broadcastId,
          reason,
          failedAt: now.toISOString(),
        },
        MEMBER_STANDING_PHASE,
        reason,
        broadcast,
        standingRefusalAuditEvent({
          refusal: standing.refusal,
          surface: 'dispatch',
          tenantSlug: deps.tenant.slug,
          memberId: broadcast.requestedByMemberId,
          broadcastId: input.broadcastId as string,
          actorUserId: 'system:cron',
          actorRole: null,
          requestId: null,
        }),
      );
      if (!recorded) return terminalWriteFailed();
      return err({ kind: 'broadcast_failed_to_dispatch', reason });
    }
    // Anything but an explicit `send` is not a send (fail CLOSED): the
    // compiler narrows this to `undecided`, and a kind it does not know would
    // land here too rather than fall through to Step 2.
    if (standing.kind !== 'send') {
      return err({
        kind: 'dispatch.server_error',
        message: standing.message,
        errClass: standing.errClass,
        phase: 'standing',
      });
    }
  }

  // Step 2: re-resolve recipients (segment may have changed since submit)
  // Review 2026-09-07 round 2 (C1/C2) — a tier row with no codes is refused
  // at the boundary, TERMINALLY. It used to reach the resolver as
  // `{ tier, [] }`: the primary_only read then addressed every active member,
  // and the all_contacts read's throw was retried every tick forever as a
  // "transient" `dispatch.server_error`. It is neither: it is a data defect,
  // so the broadcast fails with an honest reason and the member is told.
  const segmentResult = recipientSegmentFromPersisted(broadcast);
  //
  // 2026-09-10 follow-up (3): gated on the probe. With an inherited id already
  // handed to `/send`, a refusal here is about THIS tick's audience, not the
  // one that was sent; it is recorded below and the row advances on the frozen
  // estimate. (Unreachable in practice on that path — the segment is immutable
  // after submit, so a row that reached `/send` had a well-formed one — but the
  // gate is uniform with the two refusals below rather than special-cased.)
  if (!segmentResult.ok && !alreadyHandedToSend) {
    const recorded = await failDispatchAndAudit(
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
    if (!recorded) return terminalWriteFailed();
    return err({ kind: 'broadcast_failed_to_dispatch', reason: 'malformed_segment' });
  }
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
  //
  // `resolvedOrNull` is what Step 3 and Step 4 read. `null` means "refused, on
  // the replay path" — the ONE combination that does not return from this
  // block — and it is settled before Step 3 so the rest of the function reads
  // a non-null audience.
  let resolvedOrNull: ResolvedAudience | null = null;
  let replayRefusal: string | null = segmentResult.ok ? null : 'malformed_segment';
  if (segmentResult.ok) {
    const segment = segmentResult.value;
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
        phase: 'resolve',
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
        phase: 'resolve',
      });
    }
    if (!resolvedResult.ok) {
      if (alreadyHandedToSend) {
        replayRefusal = resolvedResult.error.kind;
      } else {
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
          const recorded = await failDispatchAndAudit(
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
          if (!recorded) return terminalWriteFailed();
          return err({
            kind: 'broadcast_failed_to_dispatch',
            reason: 'audience_too_large',
          });
        }
        // Empty audience post-suppression — transition to failed_to_dispatch +
        // emit audit + Slice E member notification.
        const recorded = await failDispatchAndAudit(
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
        if (!recorded) return terminalWriteFailed();
        return err({ kind: 'broadcast_audience_post_suppression_empty' });
      }
    } else {
      resolvedOrNull = resolvedResult.value;
    }
  }
  if (resolvedOrNull === null) {
    // Only reachable with `alreadyHandedToSend`: every refusal without it
    // returned above. The audience that was SENT is the one the prior tick
    // pushed; this tick's refusal describes a different audience. Record it,
    // and advance the row on the frozen estimate so the webhook and the
    // reconciler can complete a send that has already happened.
    logger.warn(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        resendBroadcastId,
        observedResendStatus,
        refusal: replayRefusal,
        frozenEstimate: broadcast.estimatedRecipientCount,
      },
      'broadcasts.dispatch.replay_resolve_refused',
    );
    return await advanceToSending({
      deps,
      input,
      now,
      broadcast,
      resendAudienceId,
      resendBroadcastId,
      recipientCount: broadcast.estimatedRecipientCount,
      alreadyHandedToSend,
      observedResendStatus,
      resendSentAt,
    });
  }
  const resolved: ResolvedAudience = resolvedOrNull;

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
  // Empty string sentinel on `resendAudienceId` / `resendBroadcastId` means
  // "not yet assigned"; the pre-send vs post-send 409 distinction is keyed on
  // `sendAttempted` since #353, not on the sentinel (both locals are declared
  // up at Step 1b now, because the probe reads them first).
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
    if (resolved.orphans.length > 0) {
      const byReason: Record<string, number> = {};
      for (const o of resolved.orphans) {
        byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
      }
      logger.info(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId,
          orphans: resolved.orphans.length,
          orphansByReason: byReason,
          estimatedAtSubmit: broadcast.estimatedRecipientCount,
          resolvedAtDispatch: resolved.estimatedCount,
        },
        'broadcasts.dispatch.orphans_at_dispatch',
      );
    }
    if (resolved.droppedByPreference > 0) {
      logger.info(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId,
          droppedByPreference: resolved.droppedByPreference,
          recipientCount: resolved.recipients.length,
        },
        'broadcasts.dispatch.marketing_opt_out_dropped',
      );
    }

    const contacts: ReadonlyArray<AudienceContact> = resolved.recipients.map(
      (e) => ({ emailLower: e as string }),
    );
    // Skipped when the resource was already handed to `/send`: re-pushing every
    // contact is what produced the 409 that used to mislabel a completed send as
    // a permanent failure, and it buys nothing -- the audience is already built.
    // Keyed off the INHERITED id, not `alreadyHandedToSend`, and that difference
    // is the point. On this leg the push precedes `createBroadcast` which precedes
    // `attachBroadcastId`, all in this try — so **a persisted broadcast id proves
    // the push completed**, whatever the probe then reports. Keying off the probe
    // left `'draft'`, `'cancelled'` and `not_found` re-pushing an audience that is
    // already built, which is the case this gate exists for.
    //
    // It also makes the fix independent of an ASSUMPTION. Whether Resend answers
    // 409 to a duplicate contact is unmeasured (see the note at the probe); this
    // guard is correct either way, because it rests on our own write ordering
    // rather than on the provider's behaviour.
    if (inheritedBroadcastId === '') {
      await deps.broadcastsGateway.addContactsToAudience(
        resendAudienceId,
        contacts,
      );
    }

    // F4 — the same reuse shape as the audience above, one step later. Skipping
    // this when the row already carries an id is what stops a tick that died
    // before the status flip from minting a SECOND Resend resource and sending
    // to the whole audience again.
    if (resendBroadcastId === '') {
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
        brand: await loadBrandChrome(deps.brandChrome, deps.tenant, 'dispatch'),
      });
      resendBroadcastId = createResult.broadcastId;
      // Persist BEFORE the send, in its own tx. The window this closes is the
      // one between `sendBroadcast` returning and the transition tx committing:
      // mail is out, and until this write existed nothing on our side knew which
      // resource sent it.
      //
      // **Its own try/catch, and that is the point.** The enclosing `try` is for
      // GATEWAY errors: its catch reads a `kind` field off the throw, and its
      // `BroadcastConcurrentMutationError` arm deletes `resendAudienceId` on the
      // stated premise that `attachAudienceId` is the only thrower in scope. A DB
      // write in there breaks both. Five reviewers found the same consequence
      // independently: on a CAS loss here the audience is the row's canonical one
      // — the WINNER is sending into it — and the arm deleted it, at INFO, under
      // a bucket the cron calls benign. Handling it here restores that premise
      // instead of patching around it.
      try {
        await deps.broadcastsRepo.withTx(async (tx) => {
          await deps.broadcastsRepo.attachBroadcastId(
            tx,
            deps.tenant.slug,
            input.broadcastId,
            resendBroadcastId,
          );
        });
      } catch (persistErr) {
        if (persistErr instanceof BroadcastConcurrentMutationError) {
          // A sibling tick attached first — or (F119 T166 R-H1) the row left
          // `approved` since Step 1: the member withdrew their approval, the
          // schedule was cancelled, a new working copy was opened, or an admin
          // cancelled. Either way this tick must not send. We touch nothing of
          // a sibling's — and reclaim the resource we just minted, which
          // nothing else references: the CAS refused OUR id, so ours is
          // orphaned by construction.
          // (2026-09-10 follow-up 2: this used to log "we leak … because the
          // gateway has no deleteBroadcast" at critical, every tick.)
          await reclaimMintedBroadcast(deps, input, resendBroadcastId, resendAudienceId, {
            why: 'attach_lost',
            observedStatus: persistErr.observedStatus,
          });
          return err({
            kind: 'broadcast_invalid_state_transition',
            observedStatus: persistErr.observedStatus,
          });
        }
        // The row vanishing under us is NOT a fault. Every other sink in this
        // module calls it `broadcast_not_found` and buckets it `concurrent_skip`
        // at warn — the cron's own comment says "normal, self-healing, and NOT a
        // failure of any kind".
        //
        // This comment used to justify the arm with "an erasure cascade can remove
        // the row". It cannot: the cascade calls
        // `cancelInFlightBroadcastsForMember` — cancel, not delete. The only
        // DELETEs on `broadcasts` are the member draft route and the prune cron
        // (both `status = 'draft'`, and this row is `approved`), and
        // `scripts/reset-broadcast-quota.ts`, which skips rows whose audience is
        // still live — and a row in THIS window is `approved` with a live
        // audience, so that script cannot reach it either.
        //
        // So: **no code path in `src/` produces this today.** The arm is pure
        // defence-in-depth, kept because routing a vanished row into the DB-fault
        // arm would page at critical for something that can never be retried. The
        // previous wording named that script as the reachable path, in the same
        // sentence that said the script skips this row — a correction that
        // refuted itself. The port docblock promises this class;
        // routing it into the DB-fault arm below would page an operator at
        // critical for a row that can never be retried.
        if (persistErr instanceof BroadcastNotFoundError) {
          // The row is gone, so nothing will ever reference the resource we
          // minted seconds ago: reclaim it. Same call, same grading, as the CAS
          // sibling above (2026-09-10 follow-up 6 — the two arms used to grade the
          // same leak critical and warn respectively).
          await reclaimMintedBroadcast(deps, input, resendBroadcastId, resendAudienceId, {
            why: 'row_vanished',
          });
          return err({
            kind: 'broadcast_not_found',
            broadcastId: input.broadcastId as string,
          });
        }
        // Anything else is a DB fault — a Neon blip, a pooler drop, a timeout.
        // **No mail has gone out yet.** Falling through to the gateway classifier
        // made this `unknown` → non-retryable BY DESIGN → the permanent arm: the
        // row went terminal, a raw driver message landed in an append-only audit
        // row, and the member was emailed that their broadcast had FAILED. Before
        // the send the safe direction is the opposite one — stay `approved` and
        // let the next tick retry, which is the whole reason this write exists.
        //
        // `dispatch.server_error`, not `gateway_retryable`: the route logs
        // `subKind` as a class of the RESEND transport (`network`/`timeout`/
        // `server_5xx`/`api`), and none of those four is honest about Neon. This
        // kind carries `errClass` instead and the route already buckets it
        // `retryable` with its own counter.
        //
        // **NOT bounded by FR-021, on purpose.** A DB fault is not budgeted on
        // either leg: round 4 F3 removed exactly that, because a budget measured
        // from `scheduled_for` killed a row already an hour late on its FIRST
        // blip. What made unbounded retry costly HERE was that each tick minted
        // a fresh Resend resource and leaked it — the port had no
        // `deleteBroadcast`. It does now (2026-09-10 follow-up 2), so the
        // retry is bounded by `dispatch_resolve_failed.total{phase=
        // "persist_broadcast_id"}` alarming, not by a clock.
        //
        // **The reclaim reads the row back FIRST.** This throw cannot say whether
        // the write landed: a commit whose acknowledgement was lost on the pooler
        // surfaces exactly like one that never reached the server. If the row
        // now carries our id, deleting the resource would destroy the id the
        // next tick inherits — it would probe `not_found`, send, 404, and fail
        // the broadcast terminally for an admin to look at. So: id landed → keep
        // it (the next tick inherits and sends); id absent → reclaim; read-back
        // itself failed → keep it, because a junk draft in the dashboard is the
        // cheaper wrong.
        const persistFailureReason =
          (persistErr as { code?: string } | null)?.code === '23505'
            ? // Needs Resend to reissue an id, so it is the least likely member of
              // this class — but the one an operator cannot otherwise name.
              'duplicate_resend_broadcast_id'
            : 'attach_broadcast_id_failed';
        logger.error(
          {
            tenantId: deps.tenant.slug,
            broadcastId: input.broadcastId as string,
            resendBroadcastId,
            err: errKind(persistErr),
            // NOT `reason` — that key is in `REDACT_PATHS`, so this line printed
            // `reason:"[REDACTED]"` and the token added specifically so an
            // operator could name a 23505 reached no one. `logger.ts` prescribes
            // exactly this: rename a safe operational field to a non-`reason` key.
            // Proven by running the suite, not by reading the redact list.
            persistFailureKind: persistFailureReason,
            severity: 'critical',
          },
          'broadcasts.dispatch.attach_broadcast_id_failed',
        );
        let idLanded: boolean | null = null;
        try {
          const readBack = await deps.broadcastsRepo.findById(
            deps.tenant.slug,
            input.broadcastId,
          );
          idLanded = readBack?.resendBroadcastId === resendBroadcastId;
        } catch (readErr) {
          logger.warn(
            {
              err: errKind(readErr),
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              resendBroadcastId,
            },
            'broadcasts.dispatch.persist_read_back_failed_resource_kept',
          );
        }
        if (idLanded === false) {
          await reclaimMintedBroadcast(deps, input, resendBroadcastId, resendAudienceId, {
            why: 'persist_failed',
          });
        } else if (idLanded === true) {
          logger.warn(
            {
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              resendBroadcastId,
            },
            'broadcasts.dispatch.persist_ack_lost_id_kept',
          );
        }
        return err({
          kind: 'dispatch.server_error',
          message: persistFailureReason,
          errClass: errKind(persistErr),
          phase: 'persist_broadcast_id',
        });
      }
    }

    if (!alreadyHandedToSend) {
      sendAttempted = true;
      await deps.broadcastsGateway.sendBroadcast(
        resendBroadcastId,
        buildIdempotencyKey(deps.tenant.slug, input.broadcastId as string),
      );
    }
    // Follow-up (7) asked for `verifyAudienceOnReplay` HERE too, on the
    // probe-positive path, and for one commit it ran. It was REFUTED by the
    // whole-branch review of that commit, and the refutation holds on this
    // file's own invariant: an inherited id proves the prior tick's push
    // completed (push precedes `createBroadcast` precedes `attachBroadcastId`,
    // all in one try — the same fact the contact-push guard above rests on).
    // So the question the check answers — "did the prior push reach Resend in
    // full?" — is already answered YES here, structurally, and the only thing
    // a count comparison can add is a FALSE `broadcast_resend_audience_drift`
    // row (append-only, pages at § 22.3) when membership changed between the
    // two ticks. Delivery truth for a sent broadcast is the webhook-fed
    // `broadcast_deliveries` aggregate, not an audience count. The 409 arm
    // keeps its check (pre-existing, and that arm can also be reached by a
    // resource this tick minted).
  } catch (e) {
    // ---- Round 4 L2 — the audience-attach CAS loss, named ------------
    //
    // `attachAudienceId` is the only call in this try that throws
    // `BroadcastConcurrentMutationError`, so reaching here is unambiguous: a
    // sibling tick attached a different audience first (two overlapping ticks
    // are reachable because `maxDuration` equals the cron cadence), or — F119
    // T166 R-H1 — the row left `approved` since Step 1 (the CAS carries the
    // status too). Either way the audience in hand is this tick's own mint.
    //
    // **That premise is load-bearing and it has to be RE-EARNED on every
    // change.** F4 briefly broke it: `attachBroadcastId` throws the same class,
    // and for one commit it sat in this try. On that path the audience is the
    // row's canonical one -- the WINNER is sending into it -- so the reclaim
    // below deleted a live audience and reported it at INFO as a benign skip.
    // Five reviewers found it independently. It is handled at its own call site
    // now, so this arm's `resendAudienceId` is once again always this tick's
    // own mint. Anything else added here that can throw this class must be
    // handled there, not by widening this arm.
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

    // ---- Idempotency conflict: success-replay ------------------------
    // Resend already accepted this broadcast on a prior attempt. Treat
    // as success and fall through to attachResendIds + transition.
    //
    // F4 widened when we can do that. `resendBroadcastId` is now seeded from the
    // ROW, not from `''`, so it is known whenever THIS tick reached
    // `createBroadcast` **or any prior tick did** — which is the common case for
    // a conflict, since a conflict means someone got further than us. Before F4
    // an inherited id was invisible here and a replay that could have advanced
    // dropped to permanent instead.
    if (shape.kind === 'idempotency_conflict' && sendAttempted) {
      // A post-send 409: Resend already accepted a prior attempt's send.
      // Verify the audience for the record, then FALL THROUGH to Step 4 —
      // exactly as before; only the check moved into a function so the
      // probe-positive path could run the same one.
      await verifyAudienceOnReplay(
        deps,
        input,
        resendAudienceId,
        resendBroadcastId,
        resolved.estimatedCount,
      );
    } else {
      if (shape.kind === 'idempotency_conflict') {
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
            summary: `Broadcast ${input.broadcastId} hit an idempotency conflict BEFORE any send was attempted this tick — the 409 came from an earlier call, not from /send, so there is nothing of ours to replay`,
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
      }
      return await settleGatewayThrow(deps, input, broadcast, now, e, shape);
    }
  }

  // Step 4 + 5 live in `advanceToSending` below — the replay path that could
  // not re-resolve (Step 2) reaches it too, which is why it is a function.
  return await advanceToSending({
    deps,
    input,
    now,
    broadcast,
    resendAudienceId,
    resendBroadcastId,
    recipientCount: resolved.estimatedCount,
    alreadyHandedToSend,
    observedResendStatus,
    resendSentAt,
  });
}

/**
 * Step 4 + 5: attach Resend ids + transition to `sending` + audit. Extracted
 * on 2026-09-10 (follow-up 3) because a SECOND caller appeared: the replay path
 * whose re-resolve was refused. Everything below is the body that used to sit
 * at the end of `dispatchScheduledBroadcast`, with `recipientCount` in place of
 * the resolved count, because on that second path there is no resolved count
 * and the row's frozen estimate is what gets written.
 */
async function advanceToSending(ctx: {
  readonly deps: DispatchScheduledBroadcastDeps;
  readonly input: DispatchScheduledBroadcastInput;
  readonly now: Date;
  readonly broadcast: Broadcast;
  readonly resendAudienceId: string;
  readonly resendBroadcastId: string;
  readonly recipientCount: number;
  readonly alreadyHandedToSend: boolean;
  readonly observedResendStatus: RetrievedBroadcastResource['status'] | null;
  readonly resendSentAt: string | null;
}): Promise<
  Result<DispatchScheduledBroadcastOutput, DispatchScheduledBroadcastError>
> {
  const {
    deps,
    input,
    now,
    broadcast,
    resendAudienceId,
    resendBroadcastId,
    recipientCount,
    alreadyHandedToSend,
    observedResendStatus,
    resendSentAt,
  } = ctx;
  // F119 PR-E (review M1) — every caller reaches here with the provider holding
  // the mail: this tick's `sendBroadcast` succeeded, a post-send 409 replayed
  // it, or the probe saw an earlier tick's send. Nothing is left to budget, so
  // reset the FR-021 clock FIRST, before the write below that may fail. Own tx,
  // best-effort (never throws). It cannot close M1 alone — in a DB fault it
  // fails with that write — which is why the probe's retryable throw is not
  // budgeted either.
  await resetDispatchRetryClock(deps, input.broadcastId, 'broadcasts.dispatch.retry_clock_clear_failed');
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
      // Round 4, whole-branch review #3 — this said "recipients are protected
      // from duplicate emails by Resend's own idempotency-key dedup
      // (gateway-level invariant)". THAT INVARIANT DOES NOT EXIST: measured
      // 2026-09-09, two identical `POST /broadcasts` calls carrying the same
      // `Idempotency-Key` create two resources. What this CAS actually closes is
      // the DB-side audit/over-emit forensics issue, which is real; the
      // duplicate-email protection was never here to claim. F4's remedy — persist
      // the id before the send — **landed above** in this same function, so a tick
      // that dies in that window no longer mints a second resource. This CAS keeps
      // its own, narrower job.
      const transitioned = await deps.broadcastsRepo.applyTransition(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        'sending',
        {
          // On a REPLAY this is later than the provider's `sent_at` — the mail
          // went out on an earlier tick, this is when the row's status caught
          // up. `sent_at < sending_started_at` is therefore possible on such a
          // row and is the truth, not a defect (reliability review L-2,
          // 2026-09-10); the `broadcast_send_started` payload below says which
          // rows are replays (`handedToSendOnPriorTick`). No CHECK constraint
          // orders the two columns, on purpose.
          sendingStartedAt: now,
          estimatedRecipientCount: recipientCount,
        },
        'approved',
      );
      // E1 closure (verify-fix 2026-05-02) — AS1 audit payload now
      // includes the spec-required `scheduledFor` + `actualSendAt` +
      // `delaySeconds` fields. `actualSendAt === sendingStartedAt`
      // (same wall-clock moment, two field names per AS1 wording).
      // `delaySeconds` is the wait between the originator's planned
      // delivery time and the actual cron pickup — surfaces "how
      // late did the cron handler fire".
      //
      // This used to say "for SC-001 quartile analysis". SC-001 is a QUOTA RATE
      // (sends per quarter), not a latency measure, and nothing reads these keys
      // out of the payload — the consumer named here was never built.
      // For "send-now" paths where `scheduledFor === null`,
      // delaySeconds is null (the field is irrelevant).
      // Round 7 M-1. `now` is right only when THIS tick sent. On the
      // probe-positive path the send happened in an earlier tick -- up to an hour
      // earlier -- and `probe.resource.sentAt` was already in hand and discarded.
      // That is the round-4 L2 class exactly: a narrowing obtained and not used,
      // written into a table with 5-year retention that cannot be corrected.
      //
      // Only `'sent'` carries a meaningful `sent_at`. Reading it on `'queued'` or
      // `'sending'` would stamp a send time for something Resend has accepted but
      // not yet reported as gone — the over-claim this field was fixed to stop.
      //
      // And it is PARSED, not trusted: the adapter passes `sent_at` through
      // verbatim and `?? null` does not catch `""`. An unparseable value made
      // `.toISOString()` throw a RangeError INSIDE this tx, rolling back
      // `attachResendIds` + `applyTransition` + the audit emit together — after
      // the mail had already gone out — and surfacing as "DB write after Resend
      // success", which sends an operator to Neon rather than to a date parse.
      const providerSentAt =
        alreadyHandedToSend &&
        observedResendStatus === 'sent' &&
        resendSentAt !== null
          ? new Date(resendSentAt)
          : null;
      const actualSendAt =
        providerSentAt !== null && !Number.isNaN(providerSentAt.getTime())
          ? providerSentAt
          : alreadyHandedToSend
            ? null
            : now;
      const scheduledForIso =
        broadcast.scheduledFor !== null
          ? broadcast.scheduledFor.toISOString()
          : null;
      // Unknown send time means unknown delay. Computing it from `now` on a replay
      // would inflate any delay report by however long the row sat between ticks.
      const delaySeconds =
        broadcast.scheduledFor !== null && actualSendAt !== null
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
          recipientCount: recipientCount,
          // Mirrors the COLUMN this same tx just wrote (`applyTransition` above),
          // and it is deliberately NOT the nullable one. Round 7 fixed
          // `actualSendAt` over-claiming `now` and, by aliasing both names to one
          // variable, made this under-claim `null` — for a column
          // `one-active-broadcast-state.ts` requires to be non-null whenever the
          // status is `sending`. An append-only row contradicting the column it is
          // named after, written in the same transaction. Only `actualSendAt`
          // carries the narrowing.
          sendingStartedAt: now.toISOString(),
          // The row says for itself whether this tick sent, so a reader never has
          // to infer it from a timestamp. `observedResendStatus` is what Resend
          // actually answered -- previously read, acted on, and then dropped.
          handedToSendOnPriorTick: alreadyHandedToSend,
          observedResendStatus,
          scheduledFor: scheduledForIso,
          actualSendAt: actualSendAt !== null ? actualSendAt.toISOString() : null,
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
      kind: 'sent',
      broadcast: sentRow,
      resendAudienceId,
      resendBroadcastId,
      recipientCount: recipientCount,
    });
  } catch (e) {
    // G1 closure (verify-fix 2026-05-02) — concurrent worker won the
    // sending-transition race. The other worker has already committed
    // the transition + audit + email. **Round 4 #3 — this said this worker's
    // Resend calls "were no-ops (idempotency-key dedup)". They were not:
    // the header is measured inert, and this worker minted its OWN broadcast
    // resource, so its send is a second real send.** The routing below is still
    // right — the losing worker has nothing left to do and must not page — but
    // the reason is "the other worker owns the row", not "our calls did
    // nothing". Surface as
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
    // "The row is GONE" — the row was deleted between the claim and this write.
    // (It is NOT the member-erasure cascade: that calls
    // `cancelInFlightBroadcastsForMember`, which cancels rather than deletes. The
    // three DELETE sites in `src/` cannot reach an `approved` row with a live
    // audience, so no code path produces this today — defence-in-depth.)
    //
    // Surfaced as its own type rather than folded into the
    // concurrent-mutation case. Nothing failed that anyone can act on, and the
    // row it would page about no longer exists.
    //
    // Round 4 L6 — this arm WAS dead code until the commit that wrote this
    // comment. R2-1 added it citing `attachAudienceId`, which is called in a
    // different try block (Step 3's, with its own catch); nothing inside THIS try threw
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
    // (or will) receive the broadcast but the DB row is still 'approved', so the
    // next cron tick re-detects it and re-calls Resend with the same idempotency
    // key.
    //
    // **Round 4 F4 — this said "(Resend dedupes -> safe replay)" and that is not
    // a property we have.** MEASURED 2026-09-09 on the live account: two
    // IDENTICAL `POST /broadcasts` calls with the same `Idempotency-Key`
    // returned two different ids. The header is inert there. The send endpoint
    // could not be probed without sending real mail, so it is unmeasured —
    // which is the point: "safe replay" was resting on an assumption nobody had
    // checked, and the half that WAS checkable came back negative.
    //
    // Worse for this particular path: the retry does not even reuse the same
    // resource. `resend_broadcast_id` was never persisted (that write is what
    // failed), so the next tick mints a NEW broadcast and sends THAT — a
    // different URL, which no idempotency scheme would collapse anyway.
    //
    // Logged at error severity, and **F4 is now FIXED above**: the id is
    // persisted in its own tx immediately after `createBroadcast` returns, so a
    // tick that dies in this window leaves the resource recorded and the next
    // tick reuses it instead of minting a second one. What remains here is the
    // narrower residual -- this write failing means the STATUS did not advance,
    // so the row is retried with the same resource rather than a new one.
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

/**
 * FR-021 / AS2 — the 1-hour retry budget for a RETRYABLE gateway throw, in one
 * place. 2026-09-10 follow-up (4): the budget lived inline in the Step-3 catch,
 * and when the inherited-id probe moved out of that try (follow-up 3) it needed
 * the same rule. Two copies of a budget drift; this is the one.
 *
 * Within budget → `gateway_retryable` (row stays `approved`). Past it → terminal
 * `failed_to_dispatch` with the member told (`retry_budget_exhausted`).
 *
 * Deliberately NOT applied to the two `dispatch.server_error` returns that sit
 * inside the Step-3 try / the probe: the unknown-status refusal (a budget would
 * turn "we do not know whether this was sent" into "it failed" after an hour,
 * with the member told so — the guess the refusal exists to avoid) and the
 * persist fault (a DB fault is not budgeted on either leg — round 4 F3 removed
 * exactly that, because it measured from `scheduled_for` and killed a row an
 * hour late on its FIRST blip; the leak that made unbounded retry costly there
 * is closed by `reclaimMintedBroadcast`).
 *
 * Nor to a RETRYABLE throw of the inherited-id probe (F119 PR-E, review M1): an
 * unanswered probe cannot say whether the mail already went out, so it is
 * retried without a clock (see the probe's catch).
 *
 * F119 PR-E — the budget now counts from the first retryable failure
 * (`dispatchRetryEpoch`), which removes the "an hour late on its first blip"
 * defect for THIS arm. It does not by itself make the DB-fault arms above safe
 * to budget: a DB fault is not a provider fault, and the member email names the
 * provider.
 */
async function applyRetryBudget(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
  broadcast: Broadcast,
  now: Date,
  subKind: RetryableSubKind,
  reason: string,
): Promise<
  Result<DispatchScheduledBroadcastOutput, DispatchScheduledBroadcastError>
> {
  // ---- Retryable: row stays 'approved' for next tick ---------------
  // Slice D (Phase 8 — FR-021 / AS2 1h retry budget): past the budget, this
  // retryable failure converts to a TERMINAL `broadcast_failed_to_dispatch` —
  // stop attempting, transition, emit the AS2 member notification. Within it:
  // the row stays 'approved' for the next 5-min cron tick.
  //
  // F119 PR-E (migration 0311) — the budget counts from the FIRST retryable
  // failure of this dispatch attempt (`dispatchFirstFailedAt`), stamped here on
  // that failure. It used to count from `scheduledFor ?? approvedAt ??
  // createdAt`, which killed a row resumed more than an hour late (a hold, the
  // read-only freeze) on its first blip. The send-now fallback that epoch
  // needed (R6 W-R1) went with it: every row's clock starts at its failure.
  // See `_dispatch-retry-epoch.ts`.
  const scheduledFor = broadcast.scheduledFor;
  const epochForBudget = await dispatchRetryEpoch(
    deps,
    input.broadcastId,
    broadcast,
    now,
    'broadcasts.dispatch.retry_epoch_stamp_failed',
  );
  if (epochForBudget === null) {
    // Review L3 — the stamp matched no `approved` row: another writer moved it
    // since Step 1 (a cancel, a withdrawal, another tick). No attempt is left
    // to fail, so no terminal write and nobody told — the Step-1 answer.
    return err({
      kind: 'broadcast_invalid_state_transition',
      observedStatus: 'unknown_or_already_processed',
    });
  }
  const elapsedMs = now.getTime() - epochForBudget.getTime();
  const pastBudget = elapsedMs > RETRY_BUDGET_MS;

  if (pastBudget) {
    // Both instants on the record: the schedule (if any) for context, and the
    // first failure the budget actually counted from.
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
    const recorded = await failDispatchAndAudit(
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
        // F119 PR-E — what `elapsedMs` counts from.
        dispatchFirstFailedAt: epochForBudgetIso,
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
    if (!recorded) return terminalWriteFailed();
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

/**
 * Where a classified gateway throw goes when it is NOT the audience-attach CAS
 * loss and NOT a post-send 409 (the two arms the Step-3 catch keeps for itself).
 * 2026-09-10 follow-ups (3)/(4): the inherited-id probe moved ahead of Step 2
 * into its own try, and its throws must be settled by the SAME rules as the
 * rest of the gateway — one reader, as `_classify-thrown.ts` says. (Except a
 * RETRYABLE probe throw, which the probe's catch keeps off the budget — F119
 * PR-E, review M1.)
 */
async function settleGatewayThrow(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
  broadcast: Broadcast,
  now: Date,
  e: unknown,
  shape: ReturnType<typeof classifyThrown>,
): Promise<
  Result<DispatchScheduledBroadcastOutput, DispatchScheduledBroadcastError>
> {
  if (shape.kind === 'retryable') {
    return await applyRetryBudget(
      deps,
      input,
      broadcast,
      now,
      retryableSubKind(shape.subKind),
      shape.reason ?? 'retryable',
    );
  }

  // ---- Resource missing: 404 from Resend ---------------------------
  // NOTE: resource_missing emits a different audit event type
  // (`broadcast_resend_resource_missing`) so the dispatch-failure
  // notification email is NOT enqueued here — only `broadcast_failed_to_dispatch`
  // event-type triggers the Slice E email. resource_missing is an
  // ops-side issue (admin manually deleted Resend resource) requiring
  // admin action, not member notification.
  if (shape.kind === 'resource_missing') {
    const recorded = await failDispatchAndAudit(
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
    if (!recorded) return terminalWriteFailed();
    return err({
      kind: 'broadcast_resend_resource_missing',
      resourceType: shape.resourceType ?? 'broadcast',
      resourceId: shape.resourceId ?? (input.broadcastId as string),
    });
  }


  // ---- Permanent (and idempotency_conflict_pre_send fall-through) --
  // Reached for `permanent`, `unknown`, and the pre-send idempotency conflict
  // (the caller audits that one first, then sends it here).
    const reason =
      shape.reason ??
      (e instanceof Error ? e.message : 'unknown gateway error');
    const recorded = await failDispatchAndAudit(
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
    if (!recorded) return terminalWriteFailed();
    return err({ kind: 'broadcast_failed_to_dispatch', reason });
}

/**
 * A prior tick sent this broadcast; did ITS `addContactsToAudience` reach Resend
 * in full? Count the audience and compare with what we resolved; a shortfall is
 * filed as `broadcast_resend_audience_drift`, an unreadable count as
 * `broadcast_resend_drift_check_unverifiable`. Forensic on both — the row still
 * advances, because Resend already accepted the send.
 *
 * 2026-09-10 follow-up (7) asked for this to run on the probe-positive path as
 * well; it did for one commit and was refuted in review (see the note at the
 * send block in Step 3): with an inherited id the prior push is proven complete
 * by write ordering, so on that path the only possible output of this check is
 * a false drift row for a membership change between ticks. ONE caller, the
 * 409 arm — extracted anyway, because the catch reads better without 200 lines
 * of forensics inline. The comparison here is against THIS tick's re-resolve
 * (the pushed count is not persisted), so the same false-positive exists on the
 * 409 arm in principle; it is bounded by the 5-minute cadence and pre-dates
 * this file's restructure.
 *
 * Never throws: every provider or DB failure inside is caught and recorded.
 */
async function verifyAudienceOnReplay(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
  resendAudienceId: string,
  resendBroadcastId: string,
  expectedCount: number,
): Promise<void> {
  // F7.1-IMP5 (round-4 follow-up) — idempotency_conflict post-send
  // means Resend accepted a prior attempt's `sendBroadcast`.
  // Recipients DID receive the email IF the prior attempt's
  // `addContactsToAudience` completed in full. Verify by querying
  // the audience contact count and comparing against the expected
  // recipient count; on mismatch, emit
  // `broadcast_resend_audience_drift` audit so ops can confirm
  // partial-delivery scope.
  let actualCount: number | null = null;
  let countCheckFailed = false;
  // Whether the count Resend gave us was a COMPLETE read. Carried into the
  // drift row so an append-only number is never mistaken for exact when it
  // was a lower bound (FINAL round L-1).
  let countComplete: boolean | null = null;
  try {
    // `{ count, complete }` — a plain record since 2026-09-10. The
    // `not_found` arm this used to branch on was dead: the list endpoint
    // never 404s (MEASURED), so a missing audience arrives as a
    // verified-complete ZERO, which the zero clause below is for.
    const outcome =
      await deps.broadcastsGateway.getAudienceContactCount(
        resendAudienceId,
      );
    // Round 4 (whole-branch review #2) — the `complete` flag landed on the
    // import leg only, which is class 3 in a commit written to fix class 3.
    //
    // `complete` is Resend's own `has_more`, inverted: false means the
    // adapter read only PART of the audience. A truncated count can only
    // UNDERCOUNT, so it is still usable when it EXCEEDS what we expected —
    // that excess is proven. Below or equal, it proves nothing, and the
    // drift comparison further down would file a false
    // `broadcast_resend_audience_drift` row in an append-only table and
    // page on § 22.3. `null` routes it to the unverifiable branch instead,
    // which is what "we could not check" already means here.
    // FINAL round, MEASURED 2026-09-10 — the zero clause is not defensive
    // padding. `GET /audiences/{id}/contacts` on an audience that does not
    // exist answers `200 {"object":"list","has_more":false,"data":[]}`, so a
    // DELETED audience arrives here as `count: 0` with `complete: true` —
    // the one shape that makes the count authoritative. Without this clause
    // the comparison below files "expected 150, actual 0" into an
    // append-only table and pages § 22.3, which reads as "nobody received
    // the mail" when the truth is "the audience was removed after the send".
    //
    // An audience reporting zero contacts moments after we pushed N is far
    // more likely gone than genuinely empty, and either way it is not a
    // verified count.
    const usable =
      (outcome.complete || outcome.count > expectedCount) &&
      !(outcome.count === 0 && expectedCount > 0);
    actualCount = usable ? outcome.count : null;
    countComplete = outcome.complete;
    if (!usable) {
      // A partial read is not a FAILURE, so it gets no append-only row —
      // but it must not fall through to the plain `idempotency_replay`
      // log either, which would read as a completed check. Flagging it
      // here routes it away from that branch and gives the catalogued
      // alert (`drift_check_unverifiable > 1 / 1h`, observability § 22.3)
      // the same data source the throw path already feeds it.
      countCheckFailed = true;
      logger.warn(
        {
          tenantId: deps.tenant.slug,
          broadcastId: input.broadcastId as string,
          resendBroadcastId,
          expectedRecipientCount: expectedCount,
          // An operator needs the two cases separable: a truncated page
          // (pageCount < expected, countComplete false) and a vanished or
          // empty audience (pageCount 0, countComplete true). "No audience
          // at all" is not a third case — it is the second one, by
          // measurement.
          pageCount: outcome.count,
          countComplete: outcome.complete,
        },
        'broadcasts.dispatch.audience_count_incomplete',
      );
      broadcastsMetrics.driftCheckUnverifiable(deps.tenant.slug);
    }
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
          // FINAL round L-1. A row can still reach here on a PARTIAL read:
          // `usable` accepts `complete: false` when the page already exceeds
          // what we expected, because truncation cannot fake an excess. In
          // that case `actualRecipientCount` is a LOWER BOUND and `drift` is
          // a bound too, not a measurement — and this table is append-only,
          // so an operator sizing a partial-delivery investigation off an
          // uncorrectable row needs to know which kind of number it is.
          countComplete,
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
}

/**
 * 2026-09-10 follow-ups (2) + (6). Reclaim a broadcast resource THIS TICK minted
 * and cannot keep. Best-effort, and the grade is decided by whether the reclaim
 * worked — on every arm alike: reclaimed → info; reclaim failed → error at
 * critical, because that is the one an operator has to act on (the resource
 * exists at Resend, no row references it, and no cron will find it —
 * `cleanup-orphaned-audiences` deletes audiences, not broadcasts).
 *
 * The tick's outcome is decided BEFORE this runs; nothing here changes the
 * return. And per the port docblock: never on an id read from the row.
 */
async function reclaimMintedBroadcast(
  deps: DispatchScheduledBroadcastDeps,
  input: DispatchScheduledBroadcastInput,
  resendBroadcastId: string,
  resendAudienceId: string,
  ctx: {
    readonly why: 'attach_lost' | 'row_vanished' | 'persist_failed';
    readonly observedStatus?: string;
  },
): Promise<void> {
  try {
    await deps.broadcastsGateway.deleteBroadcast(resendBroadcastId);
    logger.info(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        resendBroadcastId,
        resendAudienceId,
        why: ctx.why,
        ...(ctx.observedStatus === undefined ? {} : { observedStatus: ctx.observedStatus }),
      },
      'broadcasts.dispatch.minted_broadcast_reclaimed',
    );
  } catch (reclaimErr) {
    logger.error(
      {
        err: errKind(reclaimErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        leakedResendBroadcastId: resendBroadcastId,
        resendAudienceId,
        why: ctx.why,
        ...(ctx.observedStatus === undefined ? {} : { observedStatus: ctx.observedStatus }),
        severity: 'critical',
      },
      'broadcasts.dispatch.minted_broadcast_leaked',
    );
  }
}
