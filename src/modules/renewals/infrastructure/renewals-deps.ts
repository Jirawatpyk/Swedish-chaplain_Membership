/**
 * F8 composition root — `makeRenewalsDeps(tenantId)`.
 *
 * Per-call factory mirroring the F7 `broadcasts-deps.ts` precedent.
 * Tenant-scoped repos are instantiated per-call; stateless adapters
 * (audit emitter, token signer/verifier, F6 stub) are reused.
 *
 * F8 → F4 cross-module integration is two-pronged:
 *   1. Per-call `onPaid` threading — the F8 `mark-paid-offline`
 *      use-case passes a callback to `f4InvoiceBridge.issueAndMarkPaid`
 *      so the cycle flip + audit emit run inside F4's `recordPayment`
 *      tx (atomic state+audit per Constitution Principle VIII).
 *   2. F4 webhook-driven path — `f8OnPaidCallbacks(tenantId)` (Phase 5
 *      Wave G+H) returns the F8 `markCycleCompleteFromInvoicePaid`
 *      callback (T123) bound to per-tenant deps. When F4 fires a paid
 *      event (webhook or admin offline-mark) the F8 cycle transitions
 *      to `completed` (or `pending_admin_reactivation` per FR-005b
 *      block override) and emits the appropriate audit event.
 *
 * Pure Infrastructure — only `@/lib/db` + tenants barrel imports
 * (Constitution Principle III).
 */
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type { TenantTx } from '@/lib/db';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';

import { eventAttendeesStub } from './event-attendees-stub';
import { f4InvoicingForRenewalBridge } from './ports-adapters/f4-invoicing-for-renewal-bridge-drizzle';
import { f5RefundBridge } from './ports-adapters/f5-refund-bridge-drizzle';
import { makeDrizzlePlanLookupForRenewal } from './ports-adapters/plan-lookup-for-renewal-drizzle';
import { renewalLinkTokenSigner } from './renewal-link-token/hmac-signer';
import { renewalLinkTokenVerifier } from './renewal-link-token/hmac-verifier';
import { makeDrizzleConsumedLinkTokensRepo } from './drizzle/drizzle-consumed-link-tokens-repo';
import { makeDrizzleRenewalCycleRepo } from './drizzle/drizzle-renewal-cycle-repo';
import { makeDrizzleRenewalAuditEmitter } from './drizzle/drizzle-renewal-audit-emitter';
import { makeDrizzleTenantRenewalSchedulePolicyRepo } from './drizzle/drizzle-tenant-renewal-schedule-policy-repo';
import { makeDrizzleAtRiskOutreachReadRepo } from './drizzle/drizzle-at-risk-outreach-read-repo';
import { makeDrizzleRenewalEscalationTaskRepo } from './drizzle/drizzle-renewal-escalation-task-repo';
import { makeDrizzleMemberRenewalFlagsRepo } from './drizzle/drizzle-member-renewal-flags-repo';
import { makeDrizzleDispatchCandidateRepo } from './drizzle/drizzle-dispatch-candidate-repo';
import { makeDrizzleRenewalReminderEventRepo } from './drizzle/drizzle-renewal-reminder-event-repo';
import { resendTransactionalRenewalGateway } from './resend-transactional-renewal-gateway';
import { makeDrizzleBounceEventQuery } from './drizzle/drizzle-bounce-event-query';
import { drizzleReminderAuditQueryRepo } from './drizzle/drizzle-reminder-audit-query-repo';
import { f4InvoiceBridge, type F4InvoiceBridge } from './ports-adapters/f4-invoice-bridge';

import type { ScheduledPlanChangeRepo } from '@/modules/plans/application/ports';
import type { EventAttendeesPort } from '../application/ports/event-attendees-port';
import type {
  AuditContext,
  F8AuditEvent,
  F8AuditEventType,
  RenewalAuditEmitter,
} from '../application/ports/renewal-audit-emitter';
import type { ConsumedLinkTokensRepo } from '../application/ports/consumed-link-tokens-repo';
import type { F4InvoicingForRenewalBridge } from '../application/ports/f4-invoicing-bridge';
import type { F5RefundBridge } from '../application/ports/f5-refund-bridge';
import type { PlanLookupForRenewalPort } from '../application/ports/plan-lookup-for-renewal';
import type { RenewalCycleRepo } from '../application/ports/renewal-cycle-repo';
import type { RenewalLinkTokenSigner } from '../application/ports/renewal-link-token-signer';
import type { RenewalLinkTokenVerifier } from '../application/ports/renewal-link-token-verifier';
import type { TenantRenewalSchedulePolicyRepo } from '../application/ports/tenant-renewal-schedule-policy-repo';
import type { AtRiskOutreachReadRepo } from '../application/ports/at-risk-outreach-read-repo';
import type { RenewalEscalationTaskRepo } from '../application/ports/renewal-escalation-task-repo';
import type { MemberRenewalFlagsRepo } from '../application/ports/member-renewal-flags-repo';
import type { DispatchCandidateRepo } from '../application/ports/dispatch-candidate-repo';
import type { RenewalReminderEventRepo } from '../application/ports/renewal-reminder-event-repo';
import type { RenewalGateway } from '../application/ports/renewal-gateway';
import type { BounceEventQuery } from '../application/ports/bounce-event-query';
import type { ReminderAuditQueryPort } from '../application/ports/reminder-audit-query-repo';

export interface RenewalsDeps {
  readonly tenant: TenantContext;
  /**
   * F2 cross-module scheduled-plan-change repo. The F4 invoice-paid
   * hook consults `getEffectivePlanForRenewal` via this repo when the
   * F4↔F8 paid-cycle bridge fires (see `f4-invoice-bridge.ts`).
   */
  readonly scheduledPlanChangeRepo: ScheduledPlanChangeRepo;
  /**
   * Phase 3 H1 (T060) — Drizzle repo against `renewal_cycles`. Used
   * directly by `load-pipeline`, `load-cycle-detail`, `cancel-cycle`,
   * `mark-paid-offline` use-cases.
   */
  readonly cyclesRepo: RenewalCycleRepo;
  /**
   * Phase 3 H1 (T061) — F8 → F4 cross-module bridge composing
   * `createInvoiceDraft` + `issueInvoice` + `recordPayment` for the
   * `mark-paid-offline` use-case. Threads outer tx + onPaid callback
   * for atomic cycle-flip per Principle VIII.
   */
  readonly f4InvoiceBridge: F4InvoiceBridge;
  /**
   * Drizzle audit emitter persisting to `audit_log`. The runtime list
   * of currently-persistable event types is the `F8_ENUM_SHIPPED` set
   * in `drizzle-renewal-audit-emitter.ts` — events outside that set
   * fall through to pino-logging. Phase 4 migrations 0101–0107 added
   * the dispatch + bounce-threshold + cron-orchestrated event types;
   * counts evolve, so consult `F8_ENUM_SHIPPED` rather than this
   * comment.
   */
  readonly auditEmitter: RenewalAuditEmitter;
  readonly tokenSigner: RenewalLinkTokenSigner;
  readonly tokenVerifier: RenewalLinkTokenVerifier;
  /**
   * Phase 5 Wave A (T119) — Drizzle adapter for `consumed_link_tokens`.
   * Provides atomic single-use enforcement (PK-conflict replay
   * detection) for the F8 renewal-link verifier flow per research.md
   * R1 v2 step 6 + 8.
   */
  readonly consumedLinkTokensRepo: ConsumedLinkTokensRepo;
  /**
   * Phase 5 Wave A.5 (T137) — F8 → F5 refund bridge port. Encapsulates
   * "find succeeded payment for invoice + issue full refund + cascade
   * F4 credit-note" into a single async call. Default factory wires
   * the production drizzle adapter (`f5-refund-bridge-drizzle.ts`).
   */
  readonly f5RefundBridge: F5RefundBridge;
  /**
   * Phase 5 Wave B (T122) — F8 → F4 invoice-creation bridge port for
   * the public renewal-confirm flow. Composes F4 `createInvoiceDraft` +
   * `issueInvoice` into a single call returning the issued invoice id.
   * Default factory wires the stub; production adapter ships alongside
   * the T130 confirm POST route handler.
   */
  readonly f4InvoicingBridge: F4InvoicingForRenewalBridge;
  /**
   * Phase 5 Wave B (T122) — F8 → F2 plan-lookup port for the optional
   * plan-change branch of confirm-renewal. Returns the new plan's
   * frozen-price fields (price + term + currency + tier-bucket).
   */
  readonly planLookupForRenewal: PlanLookupForRenewalPort;
  readonly eventAttendees: EventAttendeesPort;
  /**
   * Phase 4 Wave I1a (T083) — Drizzle adapter for `tenant_renewal_schedule_policies`
   * (5-row-per-tenant tier-bucket → reminder ladder map). Read-dominant
   * hot path for the dispatcher cron (T088); admin schedule editor uses
   * `listAllForTenant` + `upsertSteps` for read/write.
   */
  readonly schedulePolicyRepo: TenantRenewalSchedulePolicyRepo;
  /**
   * Phase 4 Wave I2a — Drizzle read-only adapter for `at_risk_outreach`.
   * Powers the `pauseRemindersAfterOutreach` use-case (T092 / FR-033)
   * which the daily dispatcher cron consults per candidate member to
   * skip email steps within 7 days of an admin's logged outreach.
   * Mutating surface (record outreach) is a future write port —
   * tracked via FR-031 in `specs/011-renewal-reminders/spec.md` rather
   * than a fixed-phase reference (phase numbering shifted across
   * R5–R10 review rounds).
   */
  readonly atRiskOutreachReadRepo: AtRiskOutreachReadRepo;
  /**
   * Phase 4 Wave I2b — Drizzle adapter for `renewal_escalation_tasks`
   * (full surface). Used by T091 reset-email-unverified to close
   * `manual_outreach_required` tasks; reused by Wave I2c+ T088 +
   * T090 for inserting new tasks; reused by Wave I8+ admin task queue
   * for list/transition/reassign.
   */
  readonly escalationTaskRepo: RenewalEscalationTaskRepo;
  /**
   * Phase 4 Wave I2b — F8-internal Drizzle adapter for the F8-owned
   * lifecycle of `members.email_unverified`. F3 owns the schema; F8
   * owns the writes (set on bounce-threshold by T090; cleared on
   * verification-success by T091).
   */
  readonly memberRenewalFlagsRepo: MemberRenewalFlagsRepo;
  /**
   * Phase 4 Wave I2c — Composite-query Drizzle adapter that joins
   * cycles + members + primary contact + tier schedule policy in a
   * single round-trip per page. Powers T088 dispatchRenewalCycle
   * (cron entry) + T089 sendReminderNow (admin entry). Cursor-paginated
   * for SC-005 60s budget @ 5k members.
   */
  readonly dispatchCandidateRepo: DispatchCandidateRepo;
  /**
   * Phase 4 Wave I2c — Drizzle adapter for `renewal_reminder_events`.
   * Idempotency-aware (`insertIfAbsent` against the unique idem index)
   * + `transitionStatus` defends against pending-state TOCTOU.
   */
  readonly reminderEventRepo: RenewalReminderEventRepo;
  /**
   * Production: `resendTransactionalRenewalGateway` (Resend SDK +
   * React Email render). The `stub-renewal-gateway.ts` file remains
   * test-only — wire it manually in unit-test deps composition when
   * a use-case test needs no external network.
   */
  readonly renewalGateway: RenewalGateway;
  /**
   * Production: `makeDrizzleBounceEventQuery` (reads F1's
   * `email_delivery_events.bounce_type` column populated by the F1
   * Resend webhook). The `stub-bounce-event-query.ts` file is
   * test-only.
   */
  readonly bounceEventQuery: BounceEventQuery;
  /**
   * T138 catch-up review-fix: read-only audit_log query so the daily
   * reconcile cron can detect missed reminder rungs (e.g. cron skipped
   * day 23 → day 24 invocation still fires the T-7 reminder because
   * no audit row exists for it).
   */
  readonly reminderAuditQuery: ReminderAuditQueryPort;
}

/**
 * Per-call composition factory. Each invocation binds a fresh
 * `TenantContext` so concurrent requests for different tenants stay
 * isolated. Stateless adapters (audit, signer, verifier, F6 stub)
 * are reused across calls — they don't capture tenant state.
 */
export function makeRenewalsDeps(tenantId: string): RenewalsDeps {
  const tenant = asTenantContext(tenantId);
  return {
    tenant,
    scheduledPlanChangeRepo: drizzleScheduledPlanChangeRepo,
    cyclesRepo: makeDrizzleRenewalCycleRepo(tenant),
    f4InvoiceBridge,
    auditEmitter: makeDrizzleRenewalAuditEmitter(tenant),
    tokenSigner: renewalLinkTokenSigner,
    tokenVerifier: renewalLinkTokenVerifier,
    consumedLinkTokensRepo: makeDrizzleConsumedLinkTokensRepo(tenant),
    f5RefundBridge,
    f4InvoicingBridge: f4InvoicingForRenewalBridge,
    planLookupForRenewal: makeDrizzlePlanLookupForRenewal(tenant),
    eventAttendees: eventAttendeesStub,
    schedulePolicyRepo: makeDrizzleTenantRenewalSchedulePolicyRepo(tenant),
    atRiskOutreachReadRepo: makeDrizzleAtRiskOutreachReadRepo(tenant),
    escalationTaskRepo: makeDrizzleRenewalEscalationTaskRepo(tenant),
    memberRenewalFlagsRepo: makeDrizzleMemberRenewalFlagsRepo(tenant),
    dispatchCandidateRepo: makeDrizzleDispatchCandidateRepo(tenant),
    reminderEventRepo: makeDrizzleRenewalReminderEventRepo(tenant),
    renewalGateway: resendTransactionalRenewalGateway,
    bounceEventQuery: makeDrizzleBounceEventQuery(tenant),
    reminderAuditQuery: drizzleReminderAuditQueryRepo,
  };
}

// Re-export the stub so test composition + early-Phase emit sites can
// fall back to the in-memory pino logger when the real adapter is
// undesirable (e.g. unit tests that don't want to write to audit_log).
export { renewalAuditEmitterStub } from './audit-emitter-stub';
// Re-export AuditContext + F8AuditEvent shapes for use-case consumers.
export type { AuditContext, F8AuditEvent, F8AuditEventType };

/**
 * F4 onPaidCallbacks registration factory. Returns the F8
 * `markCycleCompleteFromInvoicePaid` callback (T123) bound to the
 * tenant's deps so F4's `recordPayment` / `markPaidFromProcessor`
 * fires it inside the same DB tx that flips invoice issued → paid.
 *
 * I3 review-fix (Phase 5 backlog close): F4 now threads its internal
 * tx into the callback (`cb(evt, tx)`), and this wrapper passes that
 * tx through to T123 as `existingTx`. F8 reuses the F4 tx instead of
 * opening a separate `runInTenant`, collapsing the two-tx eventual-
 * consistency window into a single atomic transaction. F4's tx still
 * rolls back on any T123 throw via the onPaidCallback contract.
 *
 * Backward compat: if F4 happens to invoke without the tx parameter
 * (legacy callers), T123 falls through to `runInTenant` so the
 * callback never breaks. The Phase 5+ wiring always threads the tx.
 *
 * Called by F4's record-payment composition on every paid-invoice flip
 * (mark-paid-offline path via f4-invoice-bridge.ts; Stripe-webhook path
 * via `markPaidFromProcessor`, which forwards `onPaidCallbacks` through
 * `makeRecordPaymentDeps`). F4 threads its internal tx into the second
 * parameter so listeners can run atomically — see I3 review-fix below.
 */
export function f8OnPaidCallbacks(
  tenantId: string,
): ReadonlyArray<(evt: F4InvoicePaidEvent, tx?: unknown) => Promise<void>> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    async (evt, txUnknown) => {
      // Lazy-import to break a runtime composition cycle: `@/modules/
      // renewals/index.ts` barrel exports `f8OnPaidCallbacks` (this
      // factory) AND F4's `recordPayment` consumes that array via its
      // own composition root. A static import here would force the
      // T123 use-case module to load before the renewals barrel
      // finishes initialising, which crashes hot-reload + cold-start
      // on Vercel Fluid Compute. The dynamic import defers T123 module
      // resolution to first-callback-invocation, by which point both
      // barrels are fully initialised. (Type-only imports of F4 inside
      // T123 are erased at compile time and never participate in this
      // cycle — see `import type` in mark-cycle-complete-from-invoice-
      // paid.ts for the type-side resolution.)
      // Round 2 (S-11): use-case is now split into:
      //   - markCycleCompleteInTx(deps, evt, tx) — InTx variant
      //   - markCycleCompleteFromInvoicePaid(deps, evt) — wrapper
      // We import both so we can dispatch correctly based on whether
      // F4 threaded a tx (atomic single-tx path) or not (degraded
      // fallback path that opens its own runInTenant).
      let markCycleCompleteInTx: typeof import('../application/use-cases/mark-cycle-complete-from-invoice-paid').markCycleCompleteInTx;
      let markCycleCompleteFromInvoicePaid: typeof import('../application/use-cases/mark-cycle-complete-from-invoice-paid').markCycleCompleteFromInvoicePaid;
      try {
        ({ markCycleCompleteInTx, markCycleCompleteFromInvoicePaid } =
          await import(
            '../application/use-cases/mark-cycle-complete-from-invoice-paid'
          ));
      } catch (e) {
        // I8 review-fix: F8-tagged log so a cold-start module-resolution
        // failure (ENOENT, SyntaxError on hot-reload) is traceable
        // without grepping F4's stack trace. Re-throw so F4's outer
        // `recordPayment` tx rolls back.
        const { logger } = await import('@/lib/logger');
        logger.error(
          {
            err: e instanceof Error ? e : new Error(String(e)),
            tenantId,
            invoiceId: evt.invoiceId,
            memberId: evt.memberId,
          },
          '[f8-onPaid] dynamic import of T123 use-case failed — F4 tx rolling back',
        );
        throw e;
      }
      // I3 + Round 2 (I-2 + S-11): dispatch on tx-presence with
      // runtime brand-check.
      //   - F4 threaded a valid TenantTx → call InTx variant (atomic
      //     single-tx path; closes the eventual-consistency window).
      //   - F4 threaded undefined OR a non-TenantTx shape → call
      //     wrapper variant (opens own runInTenant; degraded mode).
      // The runtime `isTenantTx` brand-check protects against F4
      // contract drift — a refactor that wraps `tx` in instrumentation
      // or a future cross-module wiring that forgets to thread the
      // tx would otherwise either corrupt the tenant scope
      // (Constitution Principle I) or surface as
      // `TypeError: tx.execute is not a function` deep in a query
      // callsite. The structured error log + errorId lets SRE detect
      // and remediate before user-visible state divergence.
      let txForInTx: TenantTx | undefined = undefined;
      if (txUnknown !== undefined) {
        const { isTenantTx } = await import('@/lib/db');
        if (isTenantTx(txUnknown)) {
          txForInTx = txUnknown;
        } else {
          const { logger } = await import('@/lib/logger');
          // Round 3 review-fix (R3-I8): bump dedicated OTel counter so
          // Vercel alert rules (which attach to counters not log strings)
          // page on contract drift instead of waiting for an SRE to
          // grep-discover the warn-log. Any non-zero rate sustained for
          // 5 min indicates the I3 atomic-single-tx invariant is being
          // silently lost. Pattern matches `redisFallback` precedent.
          const { renewalsMetrics } = await import('@/lib/metrics');
          renewalsMetrics.onPaidInvalidTx.add(1, { tenant_id: tenantId });
          logger.error(
            {
              errorId: 'F8.ONPAID.INVALID_TX',
              tenantId,
              invoiceId: evt.invoiceId,
              memberId: evt.memberId,
              txKeys:
                txUnknown !== null && typeof txUnknown === 'object'
                  ? Object.keys(txUnknown as Record<string, unknown>).slice(0, 10)
                  : null,
              txType: typeof txUnknown,
            },
            '[f8-onPaid] F4 threaded non-TenantTx value — falling back to runInTenant; F4 callback contract drift suspected',
          );
        }
      }
      // S-10: use-case now returns MarkCycleCompleteOutcome directly
      // (no Result wrapper — domain failures are non-throws so callers
      // never need to discriminate ok vs err). Infra throws still
      // propagate up so F4's tx rolls back on real DB failures.
      const outcome =
        txForInTx !== undefined
          ? await markCycleCompleteInTx(deps, evt, txForInTx)
          : await markCycleCompleteFromInvoicePaid(deps, evt);

      // Round 3 review-fix (R3-CR2): exhaustive switch on the outcome
      // discriminator restores the compile-time guarantee S-10's drop-
      // the-Result-wrapper claimed: adding a 5th `MarkCycleCompleteOutcome`
      // variant in the use-case (e.g. a future `kill_switch_blocked` or
      // `cross_tenant_probe`) now forces a compile error here instead
      // of being silently discarded by `await`. Each known kind is a
      // no-op — the use-case already emits its own structured log per
      // outcome, and per-kind metrics live inside the use-case. The
      // dispatch site only needs to enforce that every variant is
      // *acknowledged* by F4's onPaid contract.
      switch (outcome.kind) {
        case 'completed':
        case 'held_pending_admin':
        case 'no_cycle_for_invoice':
        case 'cycle_not_payable':
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
    },
  ];
}
