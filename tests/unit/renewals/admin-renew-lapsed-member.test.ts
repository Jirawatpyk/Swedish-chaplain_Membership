/**
 * F8-completion Slice 3 · Task 3.1 — `adminRenewLapsedMember` use-case.
 *
 * Target: 100% branch coverage (security + tax-sensitive mutating path —
 * an admin issues a §86/4 tax document the member then pays).
 *
 * The F4 invoice bridge + the F3 member-plan lookup + the cycle repo are
 * mocked via ports (no real F4/F3 deps). The real tx + atomicity + the
 * renewal-loop-closes-on-payment behaviour are exercised by the live-Neon
 * integration test (`tests/integration/renewals/admin-renew-lapsed-member.test.ts`).
 *
 * Branches asserted:
 *   - happy path: creates an `awaiting_payment` cycle, issues the §86/4 at
 *     the FROZEN price, links the invoice
 *   - `member_has_active_cycle` when the member already holds an active
 *     cycle (createCycleInTx no-ops → skipped_active_exists)
 *   - `member_not_found` when the member lookup returns null
 *   - `plan_not_found` when the frozen-price plan lookup is unresolvable
 *     (createCycleInTx throws)
 *   - `invoice_issue_failed` mapped from a bridge create/issue failure —
 *     and the fresh cycle is NOT left orphaned beyond confirm-renewal's
 *     documented recoverable state (it is created `awaiting_payment` with
 *     no linked invoice, exactly like a member who abandons the pay page)
 *   - invalid input rejected
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { adminRenewLapsedMember } from '@/modules/renewals/application/use-cases/admin-renew-lapsed-member';
import type { AdminRenewLapsedMemberDeps } from '@/modules/renewals/application/use-cases/admin-renew-lapsed-member';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type {
  IssueInvoiceForRenewalInput,
  IssueInvoiceForRenewalResult,
} from '@/modules/renewals/application/ports/f4-invoicing-bridge';
import {
  CycleNotFoundError,
  InvoiceLinkConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asSatang } from '@/lib/money';
import { buildCycle as buildCycleShared } from './_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = '00000000-0000-0000-0000-0000000000a1';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000000c3';
const PLAN_ID = 'plan-regular';
const FROZEN_THB = '50000.00';

// `runInTenant` just runs the callback with a fake tx — the unit test
// asserts the orchestration, not the SQL (covered by the integration test).
vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({ execute: vi.fn(async () => ({ rows: [] })) } as unknown),
}));

function buildCycle(overrides: Record<string, unknown> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_ID,
    status: 'awaiting_payment',
    planIdAtCycleStart: PLAN_ID,
    frozenPlanPriceThb: FROZEN_THB,
    ...overrides,
  });
}

interface DepsResult {
  deps: AdminRenewLapsedMemberDeps;
  loadMemberPlanMock: ReturnType<typeof vi.fn>;
  findActiveMock: ReturnType<typeof vi.fn>;
  insertMock: ReturnType<typeof vi.fn>;
  loadPlanFrozenMock: ReturnType<typeof vi.fn>;
  acquireLockMock: ReturnType<typeof vi.fn>;
  linkInvoiceMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  bridgeMock: ReturnType<typeof vi.fn>;
}

function makeDeps(opts?: {
  memberPlan?: { planId: string } | null;
  activeCycle?: RenewalCycle | null;
  planFrozenStatus?: 'found' | 'not_found' | 'plan_inactive';
  bridgeResult?: IssueInvoiceForRenewalResult;
}): DepsResult {
  const memberPlan =
    opts?.memberPlan === undefined ? { planId: PLAN_ID } : opts.memberPlan;
  const activeCycle = opts?.activeCycle ?? null;
  const planFrozenStatus = opts?.planFrozenStatus ?? 'found';
  const bridgeResult: IssueInvoiceForRenewalResult =
    opts?.bridgeResult ??
    ({
      status: 'issued',
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-2026-000001',
      totalSatang: asSatang(5_350_000n),
    } as const);

  const loadMemberPlanMock = vi.fn(async () => memberPlan);
  const findActiveMock = vi.fn(async () => activeCycle);
  const insertMock = vi.fn(async () =>
    buildCycle({ status: 'awaiting_payment' }),
  );
  const loadPlanFrozenMock = vi.fn(async () =>
    planFrozenStatus === 'found'
      ? {
          status: 'found' as const,
          plan: {
            tierBucket: 'regular' as const,
            priceTHB: FROZEN_THB,
            termMonths: 12,
            currency: 'THB' as const,
          },
        }
      : { status: planFrozenStatus },
  );
  const acquireLockMock = vi.fn(async () => {});
  const linkInvoiceMock = vi.fn(async () => buildCycle());
  const emitInTxMock = vi.fn(async () => {});
  const bridgeMock = vi.fn(
    async (_input: IssueInvoiceForRenewalInput) => bridgeResult,
  );

  const deps: AdminRenewLapsedMemberDeps = {
    tenant: { slug: TENANT_ID } as unknown as AdminRenewLapsedMemberDeps['tenant'],
    cyclesRepo: {
      findActiveForMemberInTx: findActiveMock,
      insert: insertMock,
      acquireCycleLockInTx: acquireLockMock,
      linkInvoice: linkInvoiceMock,
    } as unknown as AdminRenewLapsedMemberDeps['cyclesRepo'],
    auditEmitter: {
      emitInTx: emitInTxMock,
    } as unknown as AdminRenewLapsedMemberDeps['auditEmitter'],
    clock: { now: () => new Date('2026-06-13T00:00:00.000Z') },
    planLookupForRenewal: {
      loadPlanFrozenFields: loadPlanFrozenMock,
    },
    memberPlanLookup: { loadMemberPlanInTx: loadMemberPlanMock },
    f4InvoicingBridge: { issueInvoiceForRenewal: bridgeMock },
    cycleIdFactory: { cycleId: () => asCycleId(CYCLE_UUID) },
  };

  return {
    deps,
    loadMemberPlanMock,
    findActiveMock,
    insertMock,
    loadPlanFrozenMock,
    acquireLockMock,
    linkInvoiceMock,
    emitInTxMock,
    bridgeMock,
  };
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  actorUserId: 'user-admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
  requestId: 'req-1',
};

// The use-case derives plan_year server-side from the fresh cycle's
// period_from (= clock.now()) via the F4 Bangkok-fiscal-year convention.
// The clock mock is fixed at 2026-06-13 → Asia/Bangkok 2026-06-13 →
// fiscal year 2026.
const EXPECTED_DERIVED_PLAN_YEAR = 2026;

describe('adminRenewLapsedMember (Slice 3 / Task 3.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path: creates an awaiting_payment cycle, issues §86/4 at the FROZEN price, links the invoice', async () => {
    const t = makeDeps();
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cycleId).toBe(CYCLE_UUID);
    expect(result.value.invoiceId).toBe('inv-1');
    expect(result.value.cycleStatus).toBe('awaiting_payment');

    // The fresh cycle was inserted with the awaiting_payment start status.
    expect(t.insertMock).toHaveBeenCalledTimes(1);

    // The §86/4 was issued at the FROZEN price from the new cycle — NEVER a
    // request-body price. The cycle's frozenPlanPriceThb is what the bridge
    // bills (VAT-exclusive decimal string).
    expect(t.bridgeMock).toHaveBeenCalledTimes(1);
    const bridgeArg = t.bridgeMock.mock.calls[0]![0] as IssueInvoiceForRenewalInput;
    expect(bridgeArg.frozenPlanPriceThb).toBe(FROZEN_THB);
    expect(bridgeArg.planId).toBe(PLAN_ID);
    // L2: plan_year is server-derived from the fresh cycle's period_from
    // via the F4 Bangkok-fiscal-year convention — NOT a request body.
    expect(bridgeArg.planYear).toBe(EXPECTED_DERIVED_PLAN_YEAR);
    expect(bridgeArg.autoEmailOnIssue).toBe(true);

    // Link ran under the per-cycle advisory lock (orphan-window guard).
    expect(t.acquireLockMock).toHaveBeenCalled();
    expect(t.linkInvoiceMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      asCycleId(CYCLE_UUID),
      'inv-1',
    );
  });

  it('member_has_active_cycle: the member already holds an active cycle (createCycleInTx no-ops) — no invoice issued', async () => {
    const t = makeDeps({ activeCycle: buildCycle({ status: 'awaiting_payment' }) });
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_has_active_cycle');
    // No invoice was issued — we never reach the bridge.
    expect(t.bridgeMock).not.toHaveBeenCalled();
    expect(t.insertMock).not.toHaveBeenCalled();
  });

  it('member_not_found: the member lookup returns null — no cycle, no invoice', async () => {
    const t = makeDeps({ memberPlan: null });
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_not_found');
    expect(t.findActiveMock).not.toHaveBeenCalled();
    expect(t.bridgeMock).not.toHaveBeenCalled();
  });

  it('plan_not_found: the frozen-price plan lookup is unresolvable (createCycleInTx throws) — no invoice', async () => {
    const t = makeDeps({ planFrozenStatus: 'not_found' });
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('plan_not_found');
    expect(t.bridgeMock).not.toHaveBeenCalled();
  });

  it('invoice_issue_failed: bridge issue failure is mapped; the fresh awaiting_payment cycle is left in the same recoverable state as an abandoned member pay page (no link)', async () => {
    const t = makeDeps({
      bridgeResult: {
        status: 'issue_failed',
        errorCode: 'pdf_render_failed',
        detail: 'render timeout',
      },
    });
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invoice_issue_failed');
    if (result.error.kind !== 'invoice_issue_failed') return;
    expect(result.error.stage).toBe('issue');
    expect(result.error.errorCode).toBe('pdf_render_failed');

    // The cycle WAS created (tx1 committed) but NO invoice linked — this is
    // the documented recoverable state (the admin can retry; the cycle is
    // awaiting_payment with no linked invoice, identical to a member who
    // abandons the pay page). We must NOT have called linkInvoice.
    expect(t.insertMock).toHaveBeenCalledTimes(1);
    expect(t.linkInvoiceMock).not.toHaveBeenCalled();
  });

  /** Count `renewal_invoice_created` emit calls (the tx2 link audit). */
  function invoiceCreatedEmits(emitMock: ReturnType<typeof vi.fn>): number {
    return emitMock.mock.calls.filter(
      (c) => (c[1] as { type?: string })?.type === 'renewal_invoice_created',
    ).length;
  }

  it('link race — CycleNotFoundError: cycle vanished between create + link → server_error (orphan invoice logged)', async () => {
    const t = makeDeps();
    t.linkInvoiceMock.mockRejectedValueOnce(new CycleNotFoundError(CYCLE_UUID));
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('server_error');
    // The §86/4 WAS issued (the invoice exists, now orphaned) — the
    // renewal_invoice_created audit never runs because the link failed first.
    expect(t.bridgeMock).toHaveBeenCalledTimes(1);
    expect(invoiceCreatedEmits(t.emitInTxMock)).toBe(0);
  });

  it('link race — InvoiceLinkConflictError: a concurrent link won → server_error (our invoice orphaned)', async () => {
    const t = makeDeps();
    t.linkInvoiceMock.mockRejectedValueOnce(
      new InvoiceLinkConflictError(CYCLE_UUID, 'inv-1', 'inv-other'),
    );
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('server_error');
    expect(invoiceCreatedEmits(t.emitInTxMock)).toBe(0);
  });

  it('link step rethrows an unexpected error → propagates (tx rolls back)', async () => {
    const t = makeDeps();
    t.linkInvoiceMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(adminRenewLapsedMember(t.deps, VALID_INPUT)).rejects.toThrow(
      'connection reset',
    );
  });

  it('audit emit failure inside tx2 (renewal_invoice_created) rethrows (rolls back the link)', async () => {
    const t = makeDeps();
    // Reject ONLY the tx2 link audit — the tx1 renewal_cycle_created emit
    // must still succeed (createCycleInTx shares the same emit mock).
    t.emitInTxMock.mockImplementation(
      async (_tx: unknown, event: { type?: string }) => {
        if (event?.type === 'renewal_invoice_created') {
          throw new Error('audit enum drift');
        }
      },
    );
    await expect(adminRenewLapsedMember(t.deps, VALID_INPUT)).rejects.toThrow(
      'audit enum drift',
    );
    // The link DID run before the audit emit failed.
    expect(t.linkInvoiceMock).toHaveBeenCalledTimes(1);
  });

  it('create-failed bridge result maps to invoice_issue_failed stage=create', async () => {
    const t = makeDeps({
      bridgeResult: {
        status: 'create_failed',
        errorCode: 'plan_inactive',
        detail: 'plan archived',
      },
    });
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invoice_issue_failed');
    if (result.error.kind !== 'invoice_issue_failed') return;
    expect(result.error.stage).toBe('create');
  });

  it('server_error: a non-plan throw in tx1 surfaces as server_error (not plan_not_found)', async () => {
    const t = makeDeps();
    // Force an unexpected throw inside tx1 (e.g. the member lookup blows up
    // with an infra error rather than returning null).
    t.loadMemberPlanMock.mockRejectedValueOnce(new Error('db connection lost'));
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('server_error');
    expect(t.bridgeMock).not.toHaveBeenCalled();
  });

  it('invalid_input: a malformed input is rejected before any side effect', async () => {
    const t = makeDeps();
    const result = await adminRenewLapsedMember(t.deps, {
      ...VALID_INPUT,
      memberId: 'not-a-uuid', // fails the zod uuid()
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(t.loadMemberPlanMock).not.toHaveBeenCalled();
    expect(t.bridgeMock).not.toHaveBeenCalled();
  });

  it('L1: a 23505 on renewal_cycles_active_member_uniq in tx1 (concurrent double-submit) maps to member_has_active_cycle, NOT server_error', async () => {
    const t = makeDeps();
    // Simulate the loser of a concurrent double-submit: the in-tx
    // idempotency guard misses (the winner has not yet committed), so the
    // insert reaches the partial unique index and Postgres raises a 23505.
    // The `cause`-chain shape mirrors Drizzle 0.45+ wrapping (db-errors
    // walks `.cause`).
    const pgUniqueViolation = Object.assign(new Error('Failed query: insert'), {
      cause: Object.assign(
        new Error(
          'duplicate key value violates unique constraint "renewal_cycles_active_member_uniq"',
        ),
        { code: '23505' },
      ),
    });
    t.insertMock.mockRejectedValueOnce(pgUniqueViolation);

    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_has_active_cycle');
    // The loser never reaches the F4 issue step (tx1 rolled back).
    expect(t.bridgeMock).not.toHaveBeenCalled();
  });

  it('L1 narrowing: a 23505 on a DIFFERENT unique constraint surfaces as server_error (not silently swallowed as member_has_active_cycle)', async () => {
    const t = makeDeps();
    const otherViolation = Object.assign(new Error('Failed query: insert'), {
      cause: Object.assign(
        new Error(
          'duplicate key value violates unique constraint "some_other_uniq"',
        ),
        { code: '23505' },
      ),
    });
    t.insertMock.mockRejectedValueOnce(otherViolation);

    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('server_error');
  });

  it('L2: plan_year is derived from the fresh cycle period_from at a fiscal boundary (2026-12-31T17:00Z = 2027-01-01 Bangkok → FY 2027)', async () => {
    const t = makeDeps();
    // The created cycle returned by `insert` anchors at 2026-12-31T17:00Z,
    // which is 2027-01-01 00:00 in Asia/Bangkok → fiscal year 2027. The
    // derivation must follow the cycle's period_from (Bangkok-local), not
    // the raw UTC year (2026).
    t.insertMock.mockResolvedValueOnce(
      buildCycle({ periodFrom: '2026-12-31T17:00:00Z' }),
    );

    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);
    expect(result.ok).toBe(true);
    const bridgeArg = t.bridgeMock.mock.calls[0]![0] as IssueInvoiceForRenewalInput;
    expect(bridgeArg.planYear).toBe(2027);
  });

  it('happy path with requestId omitted: threads null into the bridge + audit (no crash on the optional field)', async () => {
    const t = makeDeps();
    const { requestId: _omit, ...inputNoReq } = VALID_INPUT;
    void _omit;
    const result = await adminRenewLapsedMember(t.deps, inputNoReq);

    expect(result.ok).toBe(true);
    const bridgeArg = t.bridgeMock.mock.calls[0]![0] as IssueInvoiceForRenewalInput;
    expect(bridgeArg.requestId).toBeNull();
  });

  it('server_error on a non-Error throw in tx1 (covers the String(e) fallback)', async () => {
    const t = makeDeps();
    // Throw a non-Error value to exercise the `String(e)` branch.
    t.loadMemberPlanMock.mockRejectedValueOnce('plain string failure');
    const result = await adminRenewLapsedMember(t.deps, VALID_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('server_error');
  });

  it('audit emit failure in tx2 with a NON-Error throw still rethrows (covers the String(e) arm in the tx2 logger)', async () => {
    const t = makeDeps();
    // Reject the tx2 link audit with a NON-Error value so the logger's
    // `e instanceof Error ? e.message : String(e)` takes the String(e) arm.
    t.emitInTxMock.mockImplementation(
      async (_tx: unknown, event: { type?: string }) => {
        if (event?.type === 'renewal_invoice_created') {
          throw 'audit string failure';
        }
      },
    );
    await expect(adminRenewLapsedMember(t.deps, VALID_INPUT)).rejects.toBe(
      'audit string failure',
    );
    expect(t.linkInvoiceMock).toHaveBeenCalledTimes(1);
  });
});
