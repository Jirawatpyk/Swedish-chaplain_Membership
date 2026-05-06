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
 *   2. F4 webhook-driven path — `f8OnPaidCallbacks(tenantId)` returns
 *      `[]` today; the F8 `markCycleCompleteFromInvoicePaid` use-case
 *      remains deferred (no concrete target phase scheduled — track
 *      via spec backlog, not in-line). When it ships, this factory
 *      returns the actual callback per tenant.
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
 * F4 onPaidCallbacks registration factory. Returns `[]` until the
 * `markCycleCompleteFromInvoicePaid` use-case ships (no concrete target
 * phase scheduled — track via spec backlog FR-006). When the use-case
 * lands the factory will return
 * `[(evt) => markCycleCompleteFromInvoicePaid(ctx, evt)]`.
 *
 * The `_tenantId` parameter is reserved for the eventual per-tenant
 * closure binding.
 */
export function f8OnPaidCallbacks(
  _tenantId: string,
): ReadonlyArray<(evt: F4InvoicePaidEvent) => Promise<void>> {
  return [];
}
