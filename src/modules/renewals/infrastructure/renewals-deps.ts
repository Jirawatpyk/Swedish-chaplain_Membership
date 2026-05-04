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
