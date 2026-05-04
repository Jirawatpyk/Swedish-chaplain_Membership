/**
 * F8 Phase 2 Wave G · T054 — F8 composition root.
 *
 * Per-call factory `makeRenewalsDeps(tenantId)` mirroring F7
 * `broadcasts-deps.ts` precedent. Repos that need bound tenant context
 * are instantiated per-call; stateless adapters (audit emitter, token
 * signer/verifier, F6 stub) live as module-level singletons.
 *
 * Phase 2 exit boundary scope:
 *   - `scheduledPlanChangeRepo` — REAL adapter (shipped in Wave C-1
 *     via `drizzle-scheduled-plan-change-repo.ts`)
 *   - `auditEmitter` — STUB (logging only; real adapter Phase 5+
 *     after enum extensions)
 *   - `tokenSigner` + `tokenVerifier` — REAL HMAC adapters (Wave G
 *     part 1+2 with R16 dual-key rotation)
 *   - `eventAttendees` — F6-readiness STUB (Phase 5+ swap to real
 *     F6 bridge when F6 ships)
 *   - All other 8 repos (`renewalCycleRepo`, `reminderEventRepo`,
 *     `tierUpgradeSuggestionRepo`, `escalationTaskRepo`, etc.) —
 *     NOT yet wired; ship in Phase 5+ user-story phases when the
 *     consuming use-cases land. `makeRenewalsDeps` returns deps
 *     limited to the surface that's wired today.
 *
 * F4 onPaidCallbacks registration:
 *   Per research.md R12 + Wave A finding D8, F8's composition root
 *   pushes a `markCycleCompleteFromInvoicePaid` callback into
 *   F4's `RecordPaymentDeps.onPaidCallbacks` when F4 deps are minted.
 *   That use-case (`markCycleCompleteFromInvoicePaid`) ships in
 *   Phase 4 alongside the dispatcher cron + F4 invoice-paid hook
 *   wiring; until then this composition root exposes a NO-OP
 *   placeholder factory `f8OnPaidCallbacks` returning `[]`. F4
 *   composition (`makeRecordPaymentDeps`) currently passes
 *   `undefined` for callbacks, which is functionally equivalent to
 *   the empty array — composition wiring is pre-staged so the Phase
 *   4 hook is a 1-line `[markCycleCompleteFromInvoicePaid(ctx, evt)]`
 *   addition.
 *
 * Pure Infrastructure — only `@/lib/db` runInTenant + tenants barrel
 * imports (Constitution Principle III). Domain types come through
 * the port interfaces.
 */
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';

import { renewalAuditEmitterStub } from './audit-emitter-stub';
import { eventAttendeesStub } from './event-attendees-stub';
import { renewalLinkTokenSigner } from './renewal-link-token/hmac-signer';
import { renewalLinkTokenVerifier } from './renewal-link-token/hmac-verifier';

import type { ScheduledPlanChangeRepo } from '@/modules/plans/application/ports';
import type { EventAttendeesPort } from '../application/ports/event-attendees-port';
import type { RenewalAuditEmitter } from '../application/ports/renewal-audit-emitter';
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
    auditEmitter: renewalAuditEmitterStub,
    tokenSigner: renewalLinkTokenSigner,
    tokenVerifier: renewalLinkTokenVerifier,
    eventAttendees: eventAttendeesStub,
  };
}

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
