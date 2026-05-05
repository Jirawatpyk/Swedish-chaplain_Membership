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
 *   2. Future global registration on F4 webhook-driven `recordPayment`
 *      for the dispatcher cron path — `f8OnPaidCallbacks` factory is
 *      pre-staged to return `[]` today; the dispatcher cron will
 *      register `markCycleCompleteFromInvoicePaid` once that use-case
 *      ships.
 *
 * Pure Infrastructure — only `@/lib/db` + tenants barrel imports
 * (Constitution Principle III).
 */
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';

import { eventAttendeesStub } from './event-attendees-stub';
import { renewalLinkTokenSigner } from './renewal-link-token/hmac-signer';
import { renewalLinkTokenVerifier } from './renewal-link-token/hmac-verifier';
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
import { f4InvoiceBridge, type F4InvoiceBridge } from './ports-adapters/f4-invoice-bridge';

import type { ScheduledPlanChangeRepo } from '@/modules/plans/application/ports';
import type { EventAttendeesPort } from '../application/ports/event-attendees-port';
import type {
  AuditContext,
  F8AuditEvent,
  F8AuditEventType,
  RenewalAuditEmitter,
} from '../application/ports/renewal-audit-emitter';
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

export interface RenewalsDeps {
  readonly tenant: TenantContext;
  /**
   * F2 cross-module scheduled-plan-change repo (Wave B port + Wave C-1
   * Drizzle adapter). The F4 invoice-paid hook will consult
   * `getEffectivePlanForRenewal` via this repo when it lands in
   * Phase 5+ T183.
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
   * Phase 3 H1 (T062) — Drizzle audit emitter persisting to
   * `audit_log` for the 5 enum-shipped F8 event types; pino-logging
   * fallback for the remaining 49 event types until their respective
   * pgEnum-extension migrations ship in Phase 4+. Stub fallback is
   * NOT used at this composition root — H1 ships the real adapter.
   */
  readonly auditEmitter: RenewalAuditEmitter;
  readonly tokenSigner: RenewalLinkTokenSigner;
  readonly tokenVerifier: RenewalLinkTokenVerifier;
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
   * Mutating surface (record outreach) lands with US4 / Phase 6.
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
   * Phase 4 Wave I2c — Stub Resend gateway (returns mock delivery-id).
   * Wave I3 T100 swaps this for the real
   * `ResendTransactionalRenewalGateway` adapter that wraps F1's
   * `emailSender` + renders React Email templates.
   */
  readonly renewalGateway: RenewalGateway;
  /**
   * Phase 4 Wave I2d — Stub bounce-event query reader (returns zeros).
   * Wave I4 swaps this for the real Drizzle adapter that reads F1's
   * `email_delivery_events` with bounce_type classification, alongside
   * the F1 schema extension that stores bounce_type per event.
   */
  readonly bounceEventQuery: BounceEventQuery;
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
    eventAttendees: eventAttendeesStub,
    schedulePolicyRepo: makeDrizzleTenantRenewalSchedulePolicyRepo(tenant),
    atRiskOutreachReadRepo: makeDrizzleAtRiskOutreachReadRepo(tenant),
    escalationTaskRepo: makeDrizzleRenewalEscalationTaskRepo(tenant),
    memberRenewalFlagsRepo: makeDrizzleMemberRenewalFlagsRepo(tenant),
    dispatchCandidateRepo: makeDrizzleDispatchCandidateRepo(tenant),
    reminderEventRepo: makeDrizzleRenewalReminderEventRepo(tenant),
    renewalGateway: resendTransactionalRenewalGateway,
    bounceEventQuery: makeDrizzleBounceEventQuery(tenant),
  };
}

// Re-export the stub so test composition + early-Phase emit sites can
// fall back to the in-memory pino logger when the real adapter is
// undesirable (e.g. unit tests that don't want to write to audit_log).
export { renewalAuditEmitterStub } from './audit-emitter-stub';
// Re-export AuditContext + F8AuditEvent shapes for use-case consumers.
export type { AuditContext, F8AuditEvent, F8AuditEventType };

/**
 * F4 onPaidCallbacks registration factory. Phase 2 ships a NO-OP
 * empty array — the F8 `markCycleCompleteFromInvoicePaid` use-case
 * lands in Phase 4 alongside the dispatcher cron, at which point the
 * factory returns `[(evt) => markCycleCompleteFromInvoicePaid(ctx, evt)]`.
 *
 * F5 webhook composition currently passes `undefined` for callbacks
 * (functionally equivalent to `[]`); when Phase 4 lands, F5 will start
 * calling `f8OnPaidCallbacks(tenantId)` to thread the F8 hook through.
 *
 * The `_tenantId` parameter is reserved — Phase 4 implementation will
 * use it to build the per-tenant closure that calls the F8 use-case.
 */
export function f8OnPaidCallbacks(
  _tenantId: string,
): ReadonlyArray<(evt: F4InvoicePaidEvent) => Promise<void>> {
  return [];
}
