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
// Round 6 S-003 — InvoiceId, MemberIdBrand, renewalsMetrics moved to
// the extracted helper at `_lib/apply-tier-upgrade-on-paid-callback.ts`.
// Round 6 W-008 — route F2 cross-module import through the
// SERVER-ONLY sub-barrel `@/modules/plans/server` (Constitution
// Principle III). The first attempt re-exported from the public
// barrel `@/modules/plans` and broke the client bundle (`postgres`
// package pulled `fs`); the sub-barrel pattern keeps the Drizzle
// adapter visible to server composition roots without leaking it
// into client builds.
import {
  drizzleScheduledPlanChangeRepo,
  planAuditAdapter as f2PlanAuditAdapter,
} from '@/modules/plans/server';
// F2 AuditPort type for the cross-module emit. Imported from the
// public barrel (Domain/Application surface only) — concrete adapter
// comes from the server sub-barrel above.
import type { AuditPort as F2AuditPort } from '@/modules/plans';

import { eventAttendeesStub } from './event-attendees-stub';
// Phase 10 T122 — F6 → F8 bridge: when FEATURE_F6_EVENTCREATE is on,
// swap the stub for the real F6 adapter so the at-risk-scorer can
// consult actual event attendance data. The F6 adapter is shape-
// matched (structural typing) to `EventAttendeesPort` without F6
// importing the F8 port type (avoids backwards module dependency).
//
// **CRITICAL SILENT-FAILURE RISK** (analyze finding U-1): if this
// swap is forgotten, F8 stays on the stub forever in production and
// `eventAttendanceFactorSkipped: true` flags every at-risk score
// invisibly. Verification mitigations:
//   1. Code-level: tests/integration/events/f8-port-wiring.test.ts
//      asserts the flag-on path uses the real adapter.
//   2. Deploy-level: T154a human gate at flag-flip queries F8 at-risk
//      score for a member with seeded event attendance + asserts
//      score reflects real attendance data (NOT empty stub).
import { drizzleEventAttendeesAdapter } from '@/modules/events';
import { env } from '@/lib/env';

/**
 * F6 → F8 bridge selector. Computed once at module load — env vars
 * are read from `src/lib/env.ts` zod-validated cache so a misconfig
 * crashes the boot rather than silently falling back to stub.
 */
const eventAttendeesPort = env.features.f6EventCreate
  ? drizzleEventAttendeesAdapter
  : eventAttendeesStub;
import { f4InvoicingForRenewalBridge } from './ports-adapters/f4-invoicing-for-renewal-bridge-drizzle';
import { f5RefundBridge } from './ports-adapters/f5-refund-bridge-drizzle';
import { benefitConsumptionReaderInsights } from './ports-adapters/benefit-consumption-reader-insights';
import { makeDrizzlePlanLookupForRenewal } from './ports-adapters/plan-lookup-for-renewal-drizzle';
import { makeDrizzleFiscalYearStartMonth } from './ports-adapters/fiscal-year-settings-drizzle';
import type { FiscalYearStartMonthPort } from '../application/ports/fiscal-year-settings-port';
import { memberPlanLookupDrizzle } from './ports-adapters/member-plan-lookup-drizzle';
import { memberPlanWriterDrizzle } from './ports-adapters/member-plan-writer-drizzle';
import { planChangeBillingEffectAuditDrizzle } from './ports-adapters/plan-change-billing-effect-audit-drizzle';
import type { PlanChangeBillingEffectAuditPort } from '../application/ports/plan-change-billing-effect-audit-port';
import { renewalLinkTokenSigner } from './renewal-link-token/hmac-signer';
import { renewalLinkTokenVerifier } from './renewal-link-token/hmac-verifier';
import { makeDrizzleConsumedLinkTokensRepo } from './drizzle/drizzle-consumed-link-tokens-repo';
import { makeDrizzleRenewalCycleRepo } from './drizzle/drizzle-renewal-cycle-repo';
import { makeDrizzleRenewalAuditEmitter } from './drizzle/drizzle-renewal-audit-emitter';
import { makeDrizzleTenantRenewalSchedulePolicyRepo } from './drizzle/drizzle-tenant-renewal-schedule-policy-repo';
import { makeDrizzleAtRiskOutreachReadRepo } from './drizzle/drizzle-at-risk-outreach-read-repo';
import { makeDrizzleAtRiskOutreachWriteRepo } from './drizzle/drizzle-at-risk-outreach-write-repo';
import { makeDrizzleAtRiskScorer } from './drizzle/drizzle-at-risk-scorer';
import { makeDrizzleRenewalEscalationTaskRepo } from './drizzle/drizzle-renewal-escalation-task-repo';
import { makeDrizzleMemberRenewalFlagsRepo } from './drizzle/drizzle-member-renewal-flags-repo';
import { makeDrizzleDispatchCandidateRepo } from './drizzle/drizzle-dispatch-candidate-repo';
import { makeDrizzleRenewalReminderEventRepo } from './drizzle/drizzle-renewal-reminder-event-repo';
import { resendTransactionalRenewalGateway } from './resend-transactional-renewal-gateway';
import { makeDrizzleBounceEventQuery } from './drizzle/drizzle-bounce-event-query';
import { drizzleReminderAuditQueryRepo } from './drizzle/drizzle-reminder-audit-query-repo';
import { makeDrizzleTenantRenewalSettingsRepo } from './drizzle/drizzle-tenant-renewal-settings-repo';
import { makeF5PaymentAttemptsBridgeDrizzle } from './ports-adapters/f5-payment-attempts-bridge-drizzle';
import { makeInvoiceDueBridgeDrizzle } from './ports-adapters/invoice-due-bridge-drizzle';
import { f4InvoiceBridge, type F4InvoiceBridge } from './ports-adapters/f4-invoice-bridge';
import { makeDrizzleTierUpgradeSuggestionRepo } from './drizzle/drizzle-tier-upgrade-suggestion-repo';
import { makeDrizzleTierUpgradeEvalCandidateRepo } from './drizzle/drizzle-tier-upgrade-eval-candidate-repo';
// Round 6 S-001 — switched from singleton `drizzlePlanCatalog` to
// `makeDrizzlePlanCatalog(tenant)` factory so the per-tenant deps
// composition holds an explicitly-bound port instance (matches the
// makeDrizzleTierUpgradeSuggestionRepo / makeDrizzleRenewalCycleRepo
// convention; closes a footgun where the singleton's tenant binding
// was implicit-via-input rather than explicit-via-construction).
import { makeDrizzlePlanCatalog } from './drizzle/drizzle-plan-catalog';
// Round 6 S-003 — extracted apply-pending-tier-upgrade callback
// (was a 125-line inline closure inside f8OnPaidCallbacks; the
// wrapper here keeps the composition root readable).
import { makeApplyTierUpgradeOnPaidCallback } from './_lib/apply-tier-upgrade-on-paid-callback';
import { randomUUID } from 'node:crypto';
import { asSuggestionId } from '../domain/tier-upgrade-suggestion';
import { asCycleId } from '../domain/renewal-cycle';

// PR #24 review-fix — barrel-only import (Constitution Principle III).
// `ScheduledPlanChangeRepo` is type-only and re-exported from the public
// `@/modules/plans` barrel (see plans/index.ts:295-298), so this is a
// pure compile-time symbol — no runtime dep on plans Infrastructure.
// The barrel comment about "deferred sub-barrel" referred to the
// concrete Drizzle adapter (which would pull `postgres-js` into the
// client bundle); the type-only path is safe.
import type { ScheduledPlanChangeRepo } from '@/modules/plans';
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
import type { MemberPlanLookupPort } from '../application/ports/member-plan-lookup-port';
import type { MemberPlanWriterPort } from '../application/ports/member-plan-writer-port';
import type { BenefitConsumptionReader } from '../application/ports/benefit-consumption-reader';
import type { CreateCycleInTxDeps } from '../application/use-cases/create-cycle-in-tx';
import type { RenewalCycleRepo } from '../application/ports/renewal-cycle-repo';
import type { RenewalLinkTokenSigner } from '../application/ports/renewal-link-token-signer';
import type { RenewalLinkTokenVerifier } from '../application/ports/renewal-link-token-verifier';
import type { TenantRenewalSchedulePolicyRepo } from '../application/ports/tenant-renewal-schedule-policy-repo';
import type { AtRiskOutreachReadRepo } from '../application/ports/at-risk-outreach-read-repo';
import type { AtRiskOutreachWriteRepo } from '../application/ports/at-risk-outreach-write-repo';
import type { AtRiskScorer } from '../application/ports/at-risk-scorer';
import type { RenewalEscalationTaskRepo } from '../application/ports/renewal-escalation-task-repo';
import type { MemberRenewalFlagsRepo } from '../application/ports/member-renewal-flags-repo';
import type { DispatchCandidateRepo } from '../application/ports/dispatch-candidate-repo';
import type { RenewalReminderEventRepo } from '../application/ports/renewal-reminder-event-repo';
import type { RenewalGateway } from '../application/ports/renewal-gateway';
import type { BounceEventQuery } from '../application/ports/bounce-event-query';
import type { ReminderAuditQueryPort } from '../application/ports/reminder-audit-query-repo';
import type { F5PaymentAttemptsBridge } from '../application/ports/f5-payment-attempts-bridge';
import type { InvoiceDueBridge } from '../application/ports/invoice-due-bridge';
import type { TenantRenewalSettingsRepo } from '../application/ports/tenant-renewal-settings-repo';
import type { TierUpgradeSuggestionRepo } from '../application/ports/tier-upgrade-suggestion-repo';
import type { TierUpgradeEvalCandidateRepo } from '../application/ports/tier-upgrade-eval-candidate-repo';
import type { PlanCatalogPort } from '../application/ports/plan-catalog-port';
import type { SuggestionId } from '../domain/tier-upgrade-suggestion';
import { type ClockPort, wallClock } from '../application/ports/clock-port';

export interface RenewalsDeps {
  readonly tenant: TenantContext;
  /**
   * F2 cross-module scheduled-plan-change repo. `acceptTierUpgrade` writes a
   * pending `scheduled_plan_changes` row via
   * `supersedeAndInsertPendingAtomically`, and the F4 invoice-paid finaliser
   * (`finaliseF2PlanChangeOnPaid`) flips it pending → applied. The row is a
   * forensic receipt only — nothing reads it to DECIDE a price. The actual
   * plan flip that reaches billing is the `members.plan_id` write in
   * `applyPendingTierUpgradeInTx` (Package B1), picked up by Package A's
   * next-cycle seed. (The never-implemented `getEffectivePlanForRenewal`
   * resolver / `CurrentPlanResolverPort` were removed as dead code in
   * Package B2 — the plans→members dependency inversion they required is
   * moot now that billing reads `members.plan_id` directly.)
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
  /**
   * FIX-3 (PR #173 review, 2026-07-09) — F8 → F4 tenant fiscal-year-
   * start-month lookup. Feeds `reanchorFirstPaymentCycleInTx`'s FY-crossing
   * boundary check so a non-January-start tenant's re-freeze decision
   * matches its OWN configured fiscal year, not a silently-defaulted
   * January boundary. See `fiscal-year-settings-port.ts` docstring.
   */
  readonly fiscalYearSettings: FiscalYearStartMonthPort;
  /**
   * F8-completion Slice 3 (Task 3.1) — F8 → F3 member-plan lookup for the
   * admin lapsed-comeback path. Resolves the member's CURRENT `plan_id`
   * (server-sourced) so the fresh §86/4 is billed at the member's live
   * plan price — never a request body. Default factory wires the Drizzle
   * adapter delegating to F3's `findByIdInTx`.
   */
  readonly memberPlanLookup: MemberPlanLookupPort;
  /**
   * Plan-change -> billing remediation (Package B1) — F8 → F3 member-plan
   * WRITE port. Persists a member's new plan (`members.plan_id` + `plan_year`)
   * inside the caller's tx so Package A's next-cycle seed follows it. Used by
   * `applyPendingTierUpgradeInTx` (tier-upgrade apply) + `confirmRenewal`
   * (portal plan pick). Adapter delegates to the SAME F3 repo method
   * `change-plan.ts` uses (`f3DrizzleMemberRepo.updateFieldsInTx`).
   */
  readonly memberPlanWriter: MemberPlanWriterPort;
  /**
   * Plan-change -> billing remediation (Package A) — narrow renewals-owned
   * audit port for the `member_plan_change_billing_effect` event, emitted
   * by the seed seams' cohort-E fallback. Stateless const adapter (writes
   * `audit_log` via the caller's tx).
   */
  readonly planChangeBillingEffectAudit: PlanChangeBillingEffectAuditPort;
  /**
   * F8 renewal benefit-summary — F8 → F9 bridge that resolves a member's
   * metered benefit consumption (E-Blasts / cultural tickets) for the
   * `loadRenewalSummary` read by REUSING the F9 insights
   * `computeBenefitUsage` use-case. Default factory wires the
   * insights-backed adapter; returns `null` (→ neutral "unavailable"
   * fallback) on member-not-found / compute error. (No metered
   * entitlements → empty array, not `null`.)
   */
  readonly benefitConsumptionReader: BenefitConsumptionReader;
  /**
   * F8-completion Slice 3 (Task 3.1) — cycle-id generator threaded into
   * `createCycleInTx` by the admin lapsed-comeback use-case. Default
   * factory binds `() => asCycleId(randomUUID())`; tests override with a
   * deterministic counter. (The on-paid / onboarding callers compose
   * `idFactory` inline at their call sites; the admin use-case reads it
   * from deps so the route stays a trivial pass-through.)
   */
  readonly cycleIdFactory: CreateCycleInTxDeps['idFactory'];
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
   * Phase 6 Wave B (T157) — F8-internal Drizzle adapter for INSERTs into
   * `at_risk_outreach`. Used by T156 record-at-risk-outreach use-case
   * (admin OR manager records a "Contact" CTA from the at-risk widget).
   * Inserts inside the use-case's outer tx so state + audit emit are
   * atomic (Constitution Principle VIII).
   */
  readonly atRiskOutreachWriteRepo: AtRiskOutreachWriteRepo;
  /**
   * Phase 6 Wave B (T154) — `AtRiskScorer` port. Computes an 8-factor
   * at-risk score per FR-029 + F6-readiness fallback per FR-029a +
   * proportional bands per FR-030 + min-tenure gate per FR-035. Default
   * factory wires the deterministic Wave-B stub
   * (`at-risk-scorer-stub.ts`) which returns `score=0 / band='healthy'`
   * for any input. **Wave C T159 replaces this stub with the real
   * CTE-based Drizzle adapter** that joins F4 invoices + F7 broadcasts
   * + F3 contacts + F6 events in one round-trip. Tests substitute via
   * `makeRenewalsDeps` test-double composition.
   */
  readonly atRiskScorer: AtRiskScorer;
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
  /**
   * T115a Phase 5 wave K24 — `tenant_renewal_settings` repo. Backs the
   * new `lapseCyclesOnGraceExpiry` cron which reads `grace_period_days`
   * to compute the lapse-eligibility cutoff. Drizzle adapter newly
   * added at K24 (was port-only at Phase 2 Wave E T045).
   */
  readonly tenantRenewalSettingsRepo: TenantRenewalSettingsRepo;
  /**
   * T115a Phase 5 wave K24 — F8 → F5 payment-attempts read-only
   * bridge for the `lapseCyclesOnGraceExpiry` decision branch
   * (`grace_expired` vs `payment_failed`). Reads F5 `payments` rows
   * directly via Drizzle; no F5 use-case dependency.
   */
  readonly f5PaymentAttemptsBridge: F5PaymentAttemptsBridge;
  /**
   * 059-membership-suspension Task 12 — F8 → F4 read-only bridge
   * answering "does this member have an unpaid (`status='issued'`),
   * not-yet-past-due membership invoice?". Task 13 consults this
   * BEFORE the advisory-lock tx in `lapseCyclesOnGraceExpiry` (same
   * calling convention as `f5PaymentAttemptsBridge`) to stop the lapse
   * cron from suspending a member who is still inside a fresh
   * invoice's credit window. NOT the Gate 7.5
   * `hasUnreconciledPaidMembershipInvoice` query — that one selects the
   * OPPOSITE (paid/partially_credited) statuses.
   */
  readonly invoiceDueBridge: InvoiceDueBridge;
  /**
   * Round-5 review-finding M6 — deterministic time source. Use
   * `deps.clock.now()` instead of `new Date()` directly so test
   * fixtures can pin a specific instant via
   * `clock: { now: () => FIXED_DATE }`. Mirrors the established Clock
   * pattern in `members`, `invoicing`, `payments`, `broadcasts`. The
   * production composition root binds the `wallClock` adapter; tests
   * can pass `wallClock` (current default behaviour) when they don't
   * care about time.
   */
  readonly clock: ClockPort;
  /**
   * F8 Phase 7 T179-T185 — tier-upgrade suggestion repo + eval-candidate
   * repo + F2 plan catalogue projection. The cron use-case consumes the
   * eval-candidate composite (1 round-trip per page) + the catalogue
   * snapshot (1 round-trip at start) + the suggestion repo for inserts
   * + suppression checks. Admin queue + accept/dismiss/escalate flows
   * also use the suggestion repo.
   */
  readonly tierUpgradeRepo: TierUpgradeSuggestionRepo;
  readonly tierUpgradeEvalCandidateRepo: TierUpgradeEvalCandidateRepo;
  readonly planCatalog: PlanCatalogPort;
  /**
   * Suggestion-id generator — defaults to `randomUUID()` cast through
   * the SuggestionId brand. Test fixtures override with a deterministic
   * counter.
   */
  readonly suggestionIdGenerator: () => SuggestionId;
  /**
   * F2-module audit emitter for the `plan_change_scheduled` +
   * `plan_change_superseded` events that
   * accompany the cross-module `supersedeAndInsertPendingAtomically`
   * call. F8 owns its own `tier_upgrade_*` taxonomy (`auditEmitter`
   * above); the F2-domain audit trail uses this separate emitter so
   * each module remains the source-of-truth for its event union
   * (Constitution Principle III). Default factory wires F2's
   * `planAuditAdapter` from `@/modules/plans/server`; tests substitute
   * an in-memory stub.
   */
  readonly f2AuditEmitter: F2AuditPort;
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
    fiscalYearSettings: makeDrizzleFiscalYearStartMonth(),
    memberPlanLookup: memberPlanLookupDrizzle,
    memberPlanWriter: memberPlanWriterDrizzle,
    planChangeBillingEffectAudit: planChangeBillingEffectAuditDrizzle,
    benefitConsumptionReader: benefitConsumptionReaderInsights,
    cycleIdFactory: { cycleId: () => asCycleId(randomUUID()) },
    eventAttendees: eventAttendeesPort,
    schedulePolicyRepo: makeDrizzleTenantRenewalSchedulePolicyRepo(tenant),
    atRiskOutreachReadRepo: makeDrizzleAtRiskOutreachReadRepo(tenant),
    atRiskOutreachWriteRepo: makeDrizzleAtRiskOutreachWriteRepo(tenant),
    atRiskScorer: makeDrizzleAtRiskScorer({
      tenant,
      eventAttendees: eventAttendeesPort,
      tenantRenewalSettingsRepo: makeDrizzleTenantRenewalSettingsRepo(tenant),
    }),
    escalationTaskRepo: makeDrizzleRenewalEscalationTaskRepo(tenant),
    memberRenewalFlagsRepo: makeDrizzleMemberRenewalFlagsRepo(tenant),
    dispatchCandidateRepo: makeDrizzleDispatchCandidateRepo(tenant),
    reminderEventRepo: makeDrizzleRenewalReminderEventRepo(tenant),
    renewalGateway: resendTransactionalRenewalGateway,
    bounceEventQuery: makeDrizzleBounceEventQuery(tenant),
    reminderAuditQuery: drizzleReminderAuditQueryRepo,
    tenantRenewalSettingsRepo: makeDrizzleTenantRenewalSettingsRepo(tenant),
    f5PaymentAttemptsBridge: makeF5PaymentAttemptsBridgeDrizzle(tenant),
    invoiceDueBridge: makeInvoiceDueBridgeDrizzle(tenant),
    clock: wallClock,
    tierUpgradeRepo: makeDrizzleTierUpgradeSuggestionRepo(tenant),
    tierUpgradeEvalCandidateRepo:
      makeDrizzleTierUpgradeEvalCandidateRepo(tenant),
    // Round 6 S-001 — bind PlanCatalog to the per-call tenant via factory
    // (was singleton `drizzlePlanCatalog` with implicit-via-arg binding).
    planCatalog: makeDrizzlePlanCatalog(tenant),
    suggestionIdGenerator: () => asSuggestionId(randomUUID()),
    // F2 audit emitter for cross-module
    // `plan_change_{scheduled,superseded}` audit events.
    f2AuditEmitter: f2PlanAuditAdapter,
  };
}

/**
 * Lean composition for the members-directory "lapsed" badge read
 * (067 #4 review-fix). `loadMembersMembershipStatus` consumes only
 * `Pick<RenewalsDeps, 'cyclesRepo' | 'clock'>`, so the member-directory
 * hot path must NOT call `makeRenewalsDeps` — that eagerly constructs ~20
 * Drizzle repos/adapters (audit emitter, at-risk scorer, tier-upgrade
 * repo, F5 bridge, …) on every directory render just to read two deps.
 * This factory builds exactly those two (mirrors how `makeRenewalsDeps`
 * wires `cyclesRepo` + `clock`).
 */
export function makeMembersMembershipStatusDeps(
  tenantId: string,
): Pick<RenewalsDeps, 'cyclesRepo' | 'clock'> {
  const tenant = asTenantContext(tenantId);
  return {
    cyclesRepo: makeDrizzleRenewalCycleRepo(tenant),
    clock: wallClock,
  };
}

// Re-export the stub so test composition + early-Phase emit sites can
// fall back to the in-memory pino logger when the real adapter is
// undesirable (e.g. unit tests that don't want to write to audit_log).
export { renewalAuditEmitterStub } from './audit-emitter-stub';
// Re-export AuditContext + F8AuditEvent shapes for use-case consumers.
export type { AuditContext, F8AuditEvent, F8AuditEventType };

/**
 * F4 onPaidCallbacks registration factory.
 *
 * Returns an array of F8 callbacks bound to the tenant's deps:
 *
 *   1. **`markCycleCompleteFromInvoicePaid`** (T123, Phase 5 Wave B)
 *      — flips the F8 `RenewalCycle` to `completed` (or
 *      `pending_admin_reactivation` per FR-005b block override).
 *
 *   2. **`applyPendingTierUpgradeInTx`** (T183, Phase 7 + review-fix
 *      E2/C-ERR-2) — resolves the cycle linked to the paid invoice
 *      then transitions any `accepted_pending_apply` tier-upgrade
 *      suggestion targeting it to `applied` + emits
 *      `tier_upgrade_applied_at_renewal`. Mirrors the same atomic-
 *      single-tx + INVALID_TX-fallback observability pattern as
 *      callback #1 (counter `applyPendingInvalidTx`).
 *
 *      **Round 2 SUG-6 + Round 3 IMP-1/IMP-3 forensic chain**: when
 *      the INVALID_TX fallback path runs (F4 already committed the
 *      paid invoice) AND `applyPendingTierUpgradeInTx` throws, the
 *      callback emits `tier_upgrade_apply_post_invoice_paid_failed`
 *      audit + bumps `tierUpgradeApplyPostPaidFailed{tenant}`
 *      counter. If the audit emit itself throws (production pgEnum
 *      drift triggers `pinoFallback`), the counter still fires and
 *      a structured `logger.fatal` log entry is written with
 *      `errorId: 'F8.APPLY_TIER.POST_PAID_AUDIT_EMIT_FAILED'`. The
 *      reconcile cron T185 will NOT recover this case (cycle isn't
 *      terminal); admin replay is the residual mitigation.
 *
 * Both callbacks honour the F4 tx-threading contract:
 *
 * I3 review-fix (Phase 5 backlog close): F4 threads its internal tx
 * into each callback (`cb(evt, tx)`), and the wrapper passes that tx
 * through to the T123/T183 InTx variants. F8 reuses the F4 tx instead
 * of opening a separate `runInTenant`, collapsing the two-tx eventual-
 * consistency window into a single atomic transaction. F4's tx still
 * rolls back on any callback throw via the onPaidCallback contract.
 *
 * Backward compat: if F4 invokes without a tx (legacy callers) or
 * with a non-TenantTx shape, both callbacks fall through to their
 * own `runInTenant`. Each fallback bumps a dedicated OTel counter
 * (`onPaidInvalidTx` for #1, `applyPendingInvalidTx` for #2) so
 * Vercel alert rules can detect F4 contract drift before it causes
 * silent state divergence.
 *
 * Called by F4's record-payment composition on every paid-invoice flip
 * (mark-paid-offline path via f4-invoice-bridge.ts; Stripe-webhook path
 * via `markPaidFromProcessor`, which forwards `onPaidCallbacks` through
 * `makeRecordPaymentDeps`).
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
      //
      // Rolling-anchor refactor (2026-07-08, migration 0238): the InTx
      // path (atomic — F4's own tx) additionally resolves UNLINKED
      // membership payments (re-anchor / renew / heal) via the hook
      // inside `markCycleCompleteInTx`. The degraded wrapper path below
      // REFUSES that resolution — `markCycleCompleteFromInvoicePaid`
      // forces `allowUnlinkedResolution=false`, so a separately-committed
      // re-anchor followed by an F4 payment rollback is impossible. The
      // dispatcher skip-guard + reconciliation cover the resulting miss.
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
        // Rolling-anchor refactor Task 6 — the linked-path first-payment
        // re-anchor outcome. The use-case already wrote state + emitted
        // `renewal_cycle_reanchored` + the metric; this dispatch site
        // only needs to acknowledge the variant (same no-op contract as
        // every other kind here).
        case 'reanchored':
          break;
        default: {
          // Round 4 review-fix (R4-S1): defence-in-depth for the
          // deploy-skew window — the TS `_exhaustive: never` pin below
          // guarantees compile-time exhaustiveness in steady state, but
          // a deploy where the use-case ships a 5th variant before this
          // dispatch site rebuilds (or a hot-fix bundles only the
          // use-case bundle) would silently swallow the unknown kind.
          // Loud-fail at runtime: log + counter so SRE pages instead
          // of waiting for a member-support ticket about a missed
          // cycle flip. Counter alert rule: any non-zero rate.
          const { logger } = await import('@/lib/logger');
          const { renewalsMetrics } = await import('@/lib/metrics');
          renewalsMetrics.onPaidUnknownOutcomeKind.add(1, {
            tenant_id: tenantId,
          });
          logger.error(
            {
              errorId: 'F8.ONPAID.UNKNOWN_OUTCOME_KIND',
              tenantId,
              invoiceId: evt.invoiceId,
              memberId: evt.memberId,
              kind: (outcome as { kind?: unknown }).kind ?? null,
            },
            '[f8-onPaid] unknown MarkCycleCompleteOutcome.kind — possible deploy-skew between use-case and renewals-deps',
          );
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
    },
    // F8 Phase 7 T183 — apply-pending-tier-upgrade callback. Fires after
    // the cycle-completion callback above. Looks up the cycle linked to
    // the invoice; if it's a renewal cycle with one or more
    // `accepted_pending_apply` tier-upgrade suggestions targeting it,
    // transitions them to `applied` + emits
    // `tier_upgrade_applied_at_renewal` audit. Atomic with the F4 tx
    // when threaded; opens its own runInTenant otherwise (degraded but
    // still correct because the suggestion-tx commits independently).
    //
    // Round 6 S-003 — body extracted to `_lib/apply-tier-upgrade-on-
    // paid-callback.ts` so this composition root stays readable. The
    // unit test (`f8-on-paid-callbacks.test.ts`) is unaffected because
    // its `vi.mock` paths target the use-case + lib modules, not the
    // wrapper closure shape.
    makeApplyTierUpgradeOnPaidCallback(deps, tenantId),
    // F8-completion Slice 1 (Task 1.4) — create-next-cycle-on-paid.
    // Fires LAST, AFTER callback[0] flipped the just-paid prior cycle
    // →completed in THIS tx. Threads the F4 tx so `createCycleInTx`'s
    // in-tx idempotency guard sees that uncommitted completion → the
    // next cycle IS created on the FIRST (non-retry) delivery.
    async (evt, txUnknown) => {
      // Brand-check the threaded tx. UNLIKE callback[0] (which falls back
      // to a connection-fresh runInTenant on a non-TenantTx), this
      // callback MUST THROW — a fallback runInTenant opens its OWN
      // connection and CANNOT see callback[0]'s uncommitted completion
      // (READ COMMITTED), so the idempotency guard would still see the
      // prior cycle as active → no-op → the next cycle would NEVER be
      // created on first delivery (the happy-path-DEAD bug). Throwing
      // rolls the F4 tx back so the Stripe at-least-once retry re-runs
      // the chain (which heals idempotently once consistency allows).
      const { isTenantTx } = await import('@/lib/db');
      if (txUnknown === undefined || !isTenantTx(txUnknown)) {
        const { logger } = await import('@/lib/logger');
        const { renewalsMetrics } = await import('@/lib/metrics');
        renewalsMetrics.onPaidInvalidTx.add(1, { tenant_id: tenantId });
        logger.error(
          {
            errorId: 'F8.ONPAID.CREATE_NEXT.INVALID_TX',
            tenantId,
            invoiceId: evt.invoiceId,
            memberId: evt.memberId,
            txType: typeof txUnknown,
          },
          '[f8-onPaid] create-next-cycle got non-TenantTx — F4 tx must roll back (a fallback runInTenant cannot see callback[0]\'s uncommitted completion)',
        );
        throw new Error(
          'createNextCycleOnPaid: F4 threaded a non-TenantTx — refusing to run (would no-op the first-delivery creation)',
        );
      }
      let createNextCycleOnPaidInTx: typeof import('../application/use-cases/create-next-cycle-on-paid').createNextCycleOnPaidInTx;
      try {
        ({ createNextCycleOnPaidInTx } = await import(
          '../application/use-cases/create-next-cycle-on-paid'
        ));
      } catch (e) {
        // Mirror callback[0]: a cold-start module-resolution failure is
        // F8-tagged + re-thrown so F4's tx rolls back.
        const { logger } = await import('@/lib/logger');
        logger.error(
          {
            err: e instanceof Error ? e : new Error(String(e)),
            tenantId,
            invoiceId: evt.invoiceId,
            memberId: evt.memberId,
          },
          '[f8-onPaid] dynamic import of create-next-cycle-on-paid failed — F4 tx rolling back',
        );
        throw e;
      }
      await createNextCycleOnPaidInTx(
        {
          cyclesRepo: deps.cyclesRepo,
          planLookup: deps.planLookupForRenewal,
          auditEmitter: deps.auditEmitter,
          idFactory: deps.cycleIdFactory,
          // Package A — seed the next cycle from the member's live plan.
          memberPlanLookup: deps.memberPlanLookup,
          planChangeBillingEffectAudit: deps.planChangeBillingEffectAudit,
        },
        evt,
        txUnknown,
      );
    },
  ];
}

/**
 * F4 invoice-paid POST-COMMIT callbacks registration factory.
 *
 * The in-tx `f8OnPaidCallbacks` above run INSIDE the F4 settlement tx (and
 * must — the cycle flip + tier-upgrade apply have to be atomic with the
 * invoice flip). The F2 `scheduled_plan_changes` pending → applied
 * finalisation, by contrast, MUST run AFTER that tx commits: its
 * `plan_change_applied` audit re-fires the member-row `last_activity_at`
 * trigger, which self-deadlocks against the settlement tx's member-row lock
 * if run in-callback (the outer tx is parked in a JS `await`, so Postgres
 * can't detect it; it resolves only at `statement_timeout`).
 *
 * These callbacks are fired by whoever OWNS the settlement commit — the F5
 * webhook `confirmPayment` and the admin F4 manual-pay route — once their tx
 * has committed and the member-row lock is released. The OFFLINE admin
 * mark-paid path finalises inline post-commit itself (it owns its outer tx),
 * so it does NOT consume this array.
 *
 * Each callback takes only the paid invoice id: the finaliser re-resolves the
 * cycle (+ member) from it in a fresh tx, is idempotent, and self-heals on
 * Stripe at-least-once redelivery.
 */
export function f8AfterCommitCallbacks(
  tenantId: string,
): ReadonlyArray<(invoiceId: string) => Promise<void>> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    async (invoiceId: string) => {
      const { finaliseF2PlanChangeForPaidInvoiceOnline } = await import(
        '../application/use-cases/finalise-f2-plan-change-on-paid'
      );
      await finaliseF2PlanChangeForPaidInvoiceOnline(deps, {
        tenantId,
        invoiceId,
      });
    },
  ];
}
