/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) —
 * `loadMemberRenewalContext` unit spec.
 *
 * Covers: classification mapping for all 5 classifier outcomes (renewal /
 * first_payment / heal_no_cycle / not_applicable:erased /
 * not_applicable:terminal_only), periodTo+termMonths window derivation
 * (ONLY set for `renewal`), the unpaid-membership-invoice flag (present /
 * absent / event-subject-excluded), and tenant-scoped call shape
 * (`runInTenant` + the repo methods receive `(tx, tenantId, memberId)`).
 *
 * `@/lib/db`'s `runInTenant` is mocked at the seam (same pattern as
 * `events-admin-deps-tin-presence.test.ts`) so no live Neon is needed;
 * `@/modules/renewals`'s `classifyMembershipPayment` is the REAL pure
 * domain function (only `makeRenewalsDeps` is swapped for a fake repo
 * pair) so this test also pins the classifier wiring, not just the mock.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok } from '@/lib/result';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';

const runInTenantMock = vi.hoisted(() => vi.fn());
const countCyclesMock = vi.hoisted(() => vi.fn());
const countSettledCyclesMock = vi.hoisted(() => vi.fn());
const findOpenCycleMock = vi.hoisted(() => vi.fn());
const readGuardsMock = vi.hoisted(() => vi.fn());
const listInvoicesByMemberMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  runInTenant: runInTenantMock,
}));

vi.mock('@/modules/renewals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/renewals')>();
  return {
    ...actual,
    makeRenewalsDeps: () => ({
      cyclesRepo: {
        countCyclesForMemberInTx: countCyclesMock,
        countSettledCyclesForMemberInTx: countSettledCyclesMock,
        findOpenCycleForMemberInTx: findOpenCycleMock,
      },
      memberRenewalFlagsRepo: {
        readReactivationGuardsInTx: readGuardsMock,
      },
    }),
  };
});

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    listInvoicesByMember: (...args: unknown[]) => listInvoicesByMemberMock(...args),
    makeListInvoicesByMemberDeps: () => ({}),
  };
});

import { loadMemberRenewalContext } from '@/app/(staff)/admin/invoices/_lib/member-renewal-context';

const TENANT_SLUG = 'test-swecham';
const MEMBER_ID = '00000000-0000-4000-8000-000000000001';
const SENTINEL_TX = { sentinel: 'tx' } as never;

function buildOpenCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: TENANT_SLUG,
    cycleId: asCycleId('00000000-0000-0000-0000-000000000c01'),
    memberId: MEMBER_ID,
    status: 'upcoming' as const,
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
    anchoredAt: '2026-06-01T00:00:00Z',
    anchorInvoiceId: '00000000-0000-0000-0000-0000000aaaaa',
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

/**
 * No unpaid membership invoice by default — override per test. Uses the
 * PERSISTENT `mockResolvedValue` (not `...Once`) since each test calls
 * `loadMemberRenewalContext` exactly once; re-invoking this helper inside a
 * test body cleanly replaces the `beforeEach` default for that one call.
 */
function stubInvoices(rows: ReadonlyArray<{ invoiceSubject: string }> = []): void {
  listInvoicesByMemberMock.mockResolvedValue(ok({ rows, total: rows.length }));
}

beforeEach(() => {
  vi.clearAllMocks();
  runInTenantMock.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(SENTINEL_TX),
  );
  readGuardsMock.mockResolvedValue({ blocked: false, erased: false });
  countCyclesMock.mockResolvedValue(0);
  // F2 fix (final-review, 2026-07-09) — default 0 (no settled predecessor).
  // Only consulted when an open cycle exists (see the implementation's
  // conditional fetch) — most tests below leave `findOpenCycleMock` at its
  // `null` default and never reach this read at all.
  countSettledCyclesMock.mockResolvedValue(0);
  findOpenCycleMock.mockResolvedValue(null);
  stubInvoices();
});

describe('loadMemberRenewalContext — classification mapping', () => {
  it('heal_no_cycle — zero cycles ever → periodTo/termMonths stay null', async () => {
    countCyclesMock.mockResolvedValue(0);
    findOpenCycleMock.mockResolvedValue(null);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'heal_no_cycle' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });

  it('first_payment — one un-anchored open cycle → periodTo/termMonths stay null', async () => {
    countCyclesMock.mockResolvedValue(1);
    findOpenCycleMock.mockResolvedValue(
      buildOpenCycle({ status: 'upcoming', anchoredAt: null }),
    );

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'first_payment' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });

  it('renewal — 2nd+ cycle already anchored → periodTo + termMonths surfaced from the open cycle', async () => {
    countCyclesMock.mockResolvedValue(2);
    findOpenCycleMock.mockResolvedValue(
      buildOpenCycle({
        status: 'awaiting_payment',
        anchoredAt: '2026-06-01T00:00:00Z',
        periodTo: '2027-06-01T00:00:00Z',
        frozenPlanTermMonths: 12,
      }),
    );

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'renewal' });
    expect(out.periodTo).toBe('2027-06-01T00:00:00Z');
    expect(out.termMonths).toBe(12);
    // R2-FIX-9 — with a known open cycle the dead count-all read is skipped.
    expect(countCyclesMock).not.toHaveBeenCalled();
  });

  // F2 fix (final-review, 2026-07-09) — a predecessor cycle that was
  // cancelled/lapsed WITHOUT ever anchoring (genuinely never paid) must
  // NOT count as "renewal history".
  it('first_payment — predecessor cycle exists but was NEVER settled → still first_payment (not renewal)', async () => {
    countCyclesMock.mockResolvedValue(2);
    countSettledCyclesMock.mockResolvedValue(0);
    findOpenCycleMock.mockResolvedValue(
      buildOpenCycle({ status: 'upcoming', anchoredAt: null }),
    );

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'first_payment' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });

  it('not_applicable:erased — GDPR-erased member, regardless of cycle history', async () => {
    readGuardsMock.mockResolvedValue({ blocked: false, erased: true });
    countCyclesMock.mockResolvedValue(3);
    findOpenCycleMock.mockResolvedValue(buildOpenCycle());

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'not_applicable', reason: 'erased' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });

  it('not_applicable:terminal_only — cycles exist but none open', async () => {
    countCyclesMock.mockResolvedValue(2);
    findOpenCycleMock.mockResolvedValue(null);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'not_applicable', reason: 'terminal_only' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });
});

describe('loadMemberRenewalContext — unpaid-membership-invoice flag', () => {
  it('true — an issued membership invoice exists for the member', async () => {
    stubInvoices([{ invoiceSubject: 'membership' }]);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.hasUnpaidMembershipInvoice).toBe(true);
  });

  it('false — no issued invoices at all', async () => {
    stubInvoices([]);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.hasUnpaidMembershipInvoice).toBe(false);
  });

  it('false — issued invoices exist but are all event-subject (excluded)', async () => {
    stubInvoices([{ invoiceSubject: 'event' }, { invoiceSubject: 'event' }]);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.hasUnpaidMembershipInvoice).toBe(false);
  });

  it('false — the invoicing read errors (Result.err)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({
      ok: false,
      error: { type: 'repo_error', cause: new Error('boom') },
    });

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.hasUnpaidMembershipInvoice).toBe(false);
  });

  it('queries status=issued for this member (call-shape pin)', async () => {
    await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(listInvoicesByMemberMock).toHaveBeenCalledTimes(1);
    const [, input] = listInvoicesByMemberMock.mock.calls[0] as [
      unknown,
      { tenantId: string; memberId: string; status: string },
    ];
    expect(input).toMatchObject({
      tenantId: TENANT_SLUG,
      memberId: MEMBER_ID,
      status: 'issued',
    });
  });
});

describe('loadMemberRenewalContext — tenant-scoped call shape', () => {
  it('threads (tx, tenantId, memberId) into both cyclesRepo reads + the guards read', async () => {
    await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(runInTenantMock).toHaveBeenCalledTimes(1);
    expect(readGuardsMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_SLUG, MEMBER_ID);
    expect(countCyclesMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_SLUG, MEMBER_ID);
    expect(findOpenCycleMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_SLUG, MEMBER_ID);
  });
});
