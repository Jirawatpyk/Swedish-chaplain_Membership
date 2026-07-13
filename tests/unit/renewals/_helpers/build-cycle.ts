/**
 * Wave J12 S4 — shared cycle + dispatch-candidate builders.
 *
 * Replaces a duplicated 22-line `buildCycle` / `buildHappyCandidate`
 * that appeared (mostly verbatim, sometimes with one-or-two-field
 * overrides) across ~10 unit test files.
 *
 * Both builders accept a `Partial<...>` override object so individual
 * tests can mutate just the field(s) they care about — the spread
 * preserves the existing call-site ergonomics.
 *
 * Co-located under `tests/unit/renewals/_helpers/` (renewals-scoped).
 */
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { DispatchCandidate } from '@/modules/renewals/application/ports/dispatch-candidate-repo';

export const DEFAULT_TENANT_ID = 'tenantA';
export const DEFAULT_CYCLE_UUID =
  '00000000-0000-0000-0000-000000000c01';
export const DEFAULT_MEMBER_ID = 'mem-1';

/**
 * Default cycle: status='awaiting_payment', tier='regular',
 * 12-month period 2026-06-01 → 2027-06-01, frozen-plan THB 50k.
 *
 * Override any field via the partial argument. Tests that need a
 * different cycle ID / tenant ID / status pass them through
 * `overrides`.
 */
// `RenewalCycle` is a status-discriminated union, so a `Partial<RenewalCycle>`
// param distributes across the union and TS picks one branch arbitrarily.
// Tests want to override single fields without committing to a status branch
// up front, so we accept `Record<string, unknown>` and cast at the boundary.
// The runtime shape is still well-typed via the literal defaults below.
export function buildCycle(
  overrides: Record<string, unknown> = {},
): RenewalCycle {
  return {
    tenantId: DEFAULT_TENANT_ID,
    cycleId: asCycleId(DEFAULT_CYCLE_UUID),
    memberId: DEFAULT_MEMBER_ID,
    status: 'awaiting_payment' as const,
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular' as const,
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB' as const,
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    anchoredAt: null,
    anchorInvoiceId: null,
    // F8-RP follow-up (migration 0243) — async reject-with-refund marker
    // (default unmarked; tests exercising the settle path override these).
    rejectRefundInitiatedAt: null,
    rejectRefundId: null,
    rejectActorUserId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

/**
 * Default dispatch candidate: happy-path member (active, opted in,
 * email verified) + EN primary contact + null schedule policy
 * (caller adds policy when the test exercises tier-aware steps).
 *
 * `cycle` override is shallow-merged via `buildCycle(...)` so callers
 * can supply just `{ status: 'grace' }` etc.
 */
export function buildDispatchCandidate(overrides: {
  cycle?: Record<string, unknown>;
  member?: Partial<DispatchCandidate['member']>;
  primaryContact?: DispatchCandidate['primaryContact'];
  schedulePolicy?: DispatchCandidate['schedulePolicy'];
} = {}): DispatchCandidate {
  return {
    cycle: buildCycle(overrides.cycle ?? {}),
    member: {
      memberId: DEFAULT_MEMBER_ID,
      status: 'active',
      companyName: 'Acme',
      preferredLocale: 'en',
      emailUnverified: false,
      renewalRemindersOptedOut: false,
      registrationDate: '2024-01-01',
      ...overrides.member,
    },
    primaryContact:
      overrides.primaryContact !== undefined
        ? overrides.primaryContact
        : {
            contactId: 'c1',
            email: 'a@b.co',
            firstName: 'A',
            lastName: 'B',
            preferredLanguage: 'en',
          },
    schedulePolicy: overrides.schedulePolicy ?? null,
  };
}
