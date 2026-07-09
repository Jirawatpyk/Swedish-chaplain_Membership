/**
 * F8 Phase 5 Wave B · T122 spec — `confirmRenewal`.
 *
 * 100% branch coverage required (Constitution Principle II — security-
 * critical mutating path collecting member payment intent).
 */
import { describe, expect, it, vi } from 'vitest';
import { asSatang, parseThbDecimal } from '@/lib/money';
import {
  confirmRenewal,
  selfServiceFailureReason,
} from '@/modules/renewals/application/use-cases/confirm-renewal';
import type {
  ConfirmRenewalDeps,
  ConfirmRenewalError,
} from '@/modules/renewals/application/use-cases/confirm-renewal';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
} from '@/modules/renewals/application/ports/f4-invoicing-bridge';
import type {
  PlanLookupForRenewalPort,
  PlanLookupForRenewalResult,
} from '@/modules/renewals/application/ports/plan-lookup-for-renewal';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a122';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1220';
const NEW_PLAN_ID = 'plan-premium-2026';

vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix collection error from
  // F8/infra adapter import chain ("No 'db' export defined on mock").
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_UUID,
    status: 'awaiting_payment',
    planIdAtCycleStart: 'plan-regular-2026',
    tierAtCycleStart: 'regular',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  /**
   * B-lazy (slice 2.5) — when the use-case re-reads the cycle after a
   * `transitionStatus` CAS-loss, return THIS instead of `args.cycle`.
   * Defaults to `args.cycle` (the same row). Set to model a concurrent
   * writer that won the flip (re-read sees `awaiting_payment`) or moved
   * the cycle elsewhere (re-read sees a terminal status).
   */
  rereadCycle?: RenewalCycle | null;
  planLookup?: PlanLookupForRenewalResult;
  invoiceResult?: IssueInvoiceForRenewalResult;
  updateFrozenPlanImpl?: () => Promise<RenewalCycle>;
  linkInvoiceImpl?: () => Promise<RenewalCycle>;
  transitionStatusImpl?: () => Promise<RenewalCycle>;
  emitInTxImpl?: () => Promise<void>;
  /**
   * F1 (final-review, 2026-07-09) — feeds the Step-1 classify call
   * (`classifyMembershipPayment`) that gates `membershipCoverage`.
   * Defaults to `2` (member has a predecessor cycle) so the classifier
   * resolves `'renewal'` (NOT `'first_payment'`) by default — preserves
   * every pre-existing test's behaviour (window included), matching the
   * default `buildCycle()`'s `anchoredAt: null` here which, combined
   * with count=1, would otherwise misclassify as `first_payment`.
   */
  cycleCountForMember?: number;
  /**
   * F2 fix (final-review, 2026-07-09) — feeds the SAME Step-1 classify
   * call's `settledCycleCountForMember` (the completed-OR-ever-anchored
   * predecessor count that now discriminates first_payment/renewal, NOT
   * the raw `cycleCountForMember`). Defaults to `1` (the assumed
   * predecessor cycle IS settled) so every pre-existing test stays on
   * `'renewal'` byte-identically.
   */
  settledCycleCountForMember?: number;
  /**
   * FIX-7(d) (PR #173 review, 2026-07-09) — feeds the real
   * `readReactivationGuardsInTx` read that now backs the classify call's
   * `memberErased` flag (was hardcoded `false`). Defaults to `false` so
   * every pre-existing test stays on its intended classification.
   */
  memberErased?: boolean;
}): {
  deps: ConfirmRenewalDeps;
  planLookupMock: ReturnType<typeof vi.fn>;
  invoiceBridgeMock: ReturnType<typeof vi.fn>;
  updateFrozenPlanMock: ReturnType<typeof vi.fn>;
  linkInvoiceMock: ReturnType<typeof vi.fn>;
  transitionStatusMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  countCyclesForMemberInTxMock: ReturnType<typeof vi.fn>;
  countSettledCyclesForMemberInTxMock: ReturnType<typeof vi.fn>;
  readReactivationGuardsInTxMock: ReturnType<typeof vi.fn>;
} {
  // First findByIdInTx call returns the seed cycle; any subsequent call
  // (the CAS-loss re-read) returns `rereadCycle` (defaults to the seed).
  let findByIdCallCount = 0;
  const findByIdInTxMock = vi.fn(async () => {
    findByIdCallCount += 1;
    if (findByIdCallCount === 1) return args.cycle ?? null;
    return args.rereadCycle !== undefined
      ? args.rereadCycle
      : (args.cycle ?? null);
  });
  const transitionStatusMock = vi.fn(
    args.transitionStatusImpl ??
      (async () =>
        ({
          ...args.cycle!,
          status: 'awaiting_payment' as const,
        }) as unknown as RenewalCycle),
  );
  const updateFrozenPlanMock = vi.fn(
    args.updateFrozenPlanImpl ??
      (async () => ({
        ...args.cycle!,
        planIdAtCycleStart: NEW_PLAN_ID,
        tierAtCycleStart: 'premium' as const,
        frozenPlanPriceThb: '180000.00',
      } as unknown as RenewalCycle)),
  );
  const linkInvoiceMock = vi.fn(
    args.linkInvoiceImpl ?? (async () => args.cycle ?? buildCycle()),
  );
  const planLookupMock = vi.fn(
    async (): Promise<PlanLookupForRenewalResult> =>
      args.planLookup ?? {
        status: 'found',
        plan: {
          tierBucket: 'premium',
          priceTHB: parseThbDecimal('180000.00'),
          termMonths: 12,
          currency: 'THB',
        },
      },
  );
  const invoiceBridgeMock = vi.fn(
    async (): Promise<IssueInvoiceForRenewalResult> =>
      args.invoiceResult ?? {
        status: 'issued',
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-2026-0001',
        totalSatang: asSatang(5_000_000n),
      },
  );
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));
  const countCyclesForMemberInTxMock = vi.fn(
    async () => args.cycleCountForMember ?? 2,
  );
  const countSettledCyclesForMemberInTxMock = vi.fn(
    async () => args.settledCycleCountForMember ?? 1,
  );
  const readReactivationGuardsInTxMock = vi.fn(async () => ({
    blocked: false,
    erased: args.memberErased ?? false,
  }));
  const planLookup: PlanLookupForRenewalPort = {
    loadPlanFrozenFields: planLookupMock as never,
  };
  const invoiceBridge: F4InvoicingForRenewalBridge = {
    issueInvoiceForRenewal: invoiceBridgeMock as never,
  };
  const deps: ConfirmRenewalDeps = {
    tenant: { slug: TENANT_ID } as ConfirmRenewalDeps['tenant'],
    cyclesRepo: {
      findByIdInTx: findByIdInTxMock,
      updateFrozenPlan: updateFrozenPlanMock,
      linkInvoice: linkInvoiceMock,
      // B-lazy (slice 2.5) — the Step-1 lazy self-transition flips an
      // `upcoming|reminded` cycle to `awaiting_payment`. Stubbed here;
      // real CAS semantics are exercised by integration tests.
      transitionStatus: transitionStatusMock,
      // I1 review-fix: link-step now acquires the per-cycle advisory
      // lock before the WHERE-IS-NULL guarded UPDATE. B4 fix (slice 2.5)
      // also acquires it as the FIRST Step-1 statement. Stub as a no-op
      // for these unit tests — real serialise-via-pg-advisory-lock
      // semantics are exercised by integration tests.
      acquireCycleLockInTx: vi.fn(async () => {}),
      // F1 (final-review, 2026-07-09) — feeds the Step-1 classify call.
      countCyclesForMemberInTx: countCyclesForMemberInTxMock,
      // F2 fix (final-review, 2026-07-09) — settled-history discriminator.
      countSettledCyclesForMemberInTx: countSettledCyclesForMemberInTxMock,
    } as unknown as ConfirmRenewalDeps['cyclesRepo'],
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    } as unknown as ConfirmRenewalDeps['auditEmitter'],
    // Round-5 M6 ClockPort — deterministic instant for the
    // `renewal_entered_awaiting_payment.entered_at` payload (B-lazy).
    clock: { now: () => new Date('2026-06-13T00:00:00.000Z') },
    f4InvoicingBridge: invoiceBridge,
    planLookupForRenewal: planLookup,
    memberRenewalFlagsRepo: {
      readReactivationGuardsInTx: readReactivationGuardsInTxMock,
    } as unknown as ConfirmRenewalDeps['memberRenewalFlagsRepo'],
  };
  return {
    deps,
    planLookupMock,
    invoiceBridgeMock,
    updateFrozenPlanMock,
    linkInvoiceMock,
    transitionStatusMock,
    emitInTxMock,
    countCyclesForMemberInTxMock,
    countSettledCyclesForMemberInTxMock,
    readReactivationGuardsInTxMock,
  };
}

// 070 — `planYear` is NO LONGER part of ConfirmRenewalInput (the §86/4
// fiscal year is server-derived from the cycle). The base input carries no
// year; tests that want to prove the server IGNORES a client-supplied year
// inject it via `withClientPlanYear` (a cast that simulates an over-the-wire
// field the schema drops).
const baseInput = {
  tenantId: TENANT_ID,
  cycleId: CYCLE_UUID,
  memberId: MEMBER_UUID,
  actorUserId: 'user-1',
  actorRole: 'member' as const,
  correlationId: 'corr-1',
};

/**
 * Simulate a malicious/stale client smuggling a `planYear` into the input.
 * `ConfirmRenewalInput` no longer declares the field, so we cast through
 * `unknown` — the production route's non-strict zod schema would drop such a
 * key entirely; here we hand it straight to the use-case to prove the
 * use-case itself never reads it (it derives the year from the cycle).
 */
function withClientPlanYear(
  input: typeof baseInput & { newPlanId?: string },
  planYear: number,
): Parameters<typeof confirmRenewal>[1] {
  return { ...input, planYear } as unknown as Parameters<
    typeof confirmRenewal
  >[1];
}

describe('confirmRenewal (T122) — happy paths', () => {
  it('happy path no plan-change — issues invoice + links + emits invoice_created', async () => {
    const cycle = buildCycle();
    const {
      deps,
      invoiceBridgeMock,
      planLookupMock,
      linkInvoiceMock,
      emitInTxMock,
    } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.invoiceId).toBe('inv-1');
      // `?pay=1` auto-opens the F5 PaySheet on the invoice detail page
      // (FR-025c) — the same deep-link the F4/F5 invoice emails use.
      expect(r.value.payUrl).toBe('/portal/invoices/inv-1?pay=1');
      // Regression guard (2026-06-22 /verify): the member PAY surface is the
      // invoice detail PAGE `/portal/invoices/[invoiceId]` (hosts the in-page
      // F5 PaySheet via <PayNowButton>). There is NO `/pay` sub-route page —
      // a trailing `/pay` (the prior bug) or any extra PATH segment 404s the
      // member right after a successful confirm. A query string (`?pay=1`) is
      // fine; an extra path segment is not. Pin the shape so a future
      // re-append to a non-existent sub-route is caught at this assertion.
      expect(r.value.payUrl).toMatch(/^\/portal\/invoices\/[^/]+$/);
      expect(r.value.planChanged).toBe(false);
    }
    expect(planLookupMock).not.toHaveBeenCalled();
    expect(invoiceBridgeMock).toHaveBeenCalledOnce();
    // FR-022 — the bridge is handed the cycle's FROZEN price (server-
    // sourced from the Step-1 cycle row), not a live catalogue lookup.
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      frozenPlanPriceThb: '50000.00',
      planId: 'plan-regular-2026',
      planYear: 2026,
    });
    expect(linkInvoiceMock).toHaveBeenCalledOnce();
    // Two emits: cross_member_probe is skipped (matches), so only the
    // invoice_created emit fires from the link tx (the planChange emits
    // would also be in the state tx if a plan change occurred).
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_invoice_created',
    });
  });

  it('happy path plan-change — updates frozen plan + emits 3 audits', async () => {
    const cycle = buildCycle();
    const { deps, planLookupMock, updateFrozenPlanMock, invoiceBridgeMock, emitInTxMock } =
      fakeDeps({ cycle });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.planChanged).toBe(true);
    expect(planLookupMock).toHaveBeenCalledOnce();
    // 070 §86/4 — the plan-change resolves the NEW plan by THIS cycle's
    // fiscal year (period_from 2026-06-01 → FY 2026) with
    // mode 'offer' (a plan-OFFER check, not a freeze).
    expect(planLookupMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      planId: NEW_PLAN_ID,
      fiscalYear: 2026,
      mode: 'offer',
    });
    expect(updateFrozenPlanMock).toHaveBeenCalledOnce();
    expect(updateFrozenPlanMock.mock.calls[0]?.[3]).toMatchObject({
      planIdAtCycleStart: NEW_PLAN_ID,
      frozenPlanPriceThb: '180000.00',
    });
    // FR-022 — after a plan-change the §86/4 bills the NEW plan's frozen
    // price (the re-snapshotted cycle row), never the old frozen value
    // nor either live catalogue price.
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      frozenPlanPriceThb: '180000.00',
      planId: NEW_PLAN_ID,
    });
    // Three emits: with_plan_change + cycle_price_frozen + invoice_created
    const emittedTypes = emitInTxMock.mock.calls.map(
      (c) => (c?.[1] as { type: string })?.type,
    );
    expect(emittedTypes).toContain('renewal_with_plan_change');
    expect(emittedTypes).toContain('renewal_cycle_price_frozen');
    expect(emittedTypes).toContain('renewal_invoice_created');
  });

  it('newPlanId equal to current plan — no plan-change branch fires', async () => {
    const cycle = buildCycle();
    const { deps, planLookupMock, updateFrozenPlanMock } = fakeDeps({
      cycle,
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: cycle.planIdAtCycleStart, // same as current
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.planChanged).toBe(false);
    expect(planLookupMock).not.toHaveBeenCalled();
    expect(updateFrozenPlanMock).not.toHaveBeenCalled();
  });
});

describe('confirmRenewal (F1, final-review 2026-07-09) — membershipCoverage gated by shared classifier', () => {
  // A NEVER-PAID member's only-ever cycle (`cycleCountForMember: 1`,
  // `anchoredAt: null`) classifies as `first_payment` — the bridge must
  // be called WITHOUT `membershipCoverage` (falls back to F4's own
  // `{ kind: 'from_payment' }` default), because `mark-cycle-complete-
  // from-invoice-paid.ts`'s linked-path re-anchor moves the period to the
  // actual payment month once the member pays — the exact window isn't
  // knowable yet at invoice-issue time.
  it('first-payment shape (count=1, unanchored) — bridge called WITHOUT membershipCoverage', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const { deps, invoiceBridgeMock, countCyclesForMemberInTxMock } =
      fakeDeps({ cycle, cycleCountForMember: 1, settledCycleCountForMember: 0 });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(countCyclesForMemberInTxMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      MEMBER_UUID,
    );
    expect(invoiceBridgeMock).toHaveBeenCalledOnce();
    const bridgeInput = invoiceBridgeMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(bridgeInput).not.toHaveProperty('membershipCoverage');
  });

  // F2 fix (final-review, 2026-07-09) — a predecessor cycle that was
  // cancelled/lapsed WITHOUT ever anchoring (genuinely never paid) must
  // NOT count as "renewal history" — the member's first real payment is
  // still first_payment even though a predecessor cycle row exists.
  it('cancelled-only-history shape (predecessor exists but NEVER settled) — still first_payment, bridge called WITHOUT membershipCoverage', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const { deps, invoiceBridgeMock } = fakeDeps({
      cycle,
      cycleCountForMember: 2, // a predecessor row exists (e.g. cancelled)...
      settledCycleCountForMember: 0, // ...but it was NEVER settled/anchored
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    const bridgeInput = invoiceBridgeMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(bridgeInput).not.toHaveProperty('membershipCoverage');
  });

  // FIX-7(d) (PR #173 review, 2026-07-09) — memberErased now reads the
  // REAL guard (was hardcoded `false`). An erased member classifies
  // `not_applicable(erased)`, not `renewal` — the §86/4 must NOT print an
  // exact window it cannot vouch for, even though the shape otherwise
  // looks like a normal renewal (predecessor history, anchored cycle).
  it('erased member (real guard, not hardcoded) — classification not_applicable, bridge called WITHOUT membershipCoverage', async () => {
    const cycle = buildCycle({ anchoredAt: '2025-06-01T00:00:00Z' });
    const { deps, invoiceBridgeMock, readReactivationGuardsInTxMock } = fakeDeps({
      cycle,
      cycleCountForMember: 2,
      settledCycleCountForMember: 1,
      memberErased: true,
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(readReactivationGuardsInTxMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      MEMBER_UUID,
    );
    const bridgeInput = invoiceBridgeMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(bridgeInput).not.toHaveProperty('membershipCoverage');
  });

  // A renewal-classified cycle (either already anchored, or the member
  // has a predecessor cycle) keeps the EXACT next-period window text —
  // unchanged from the pre-fix behaviour.
  it('renewal shape (anchored) — membershipCoverage window UNCHANGED', async () => {
    const cycle = buildCycle({ anchoredAt: '2025-06-01T00:00:00Z' });
    const { deps, invoiceBridgeMock } = fakeDeps({
      cycle,
      cycleCountForMember: 1,
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      membershipCoverage: {
        kind: 'window',
        fromIso: cycle.periodTo,
        toIso: '2028-06-01T00:00:00.000Z', // periodTo + 12 months
      },
    });
  });

  it('renewal shape (predecessor cycle exists, unanchored) — membershipCoverage window UNCHANGED', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const { deps, invoiceBridgeMock } = fakeDeps({
      cycle,
      cycleCountForMember: 2, // predecessor cycle exists...
      settledCycleCountForMember: 1, // ...and it WAS settled → not first_payment
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      membershipCoverage: { kind: 'window' },
    });
  });
});

describe('confirmRenewal (070 FR-022) — plan_year is server-derived, NOT client-supplied', () => {
  // 070 security fix — the §86/4 fiscal year (the "Membership {year}" label
  // + the §87 numbering bucket) MUST be derived SERVER-SIDE from the
  // authoritative cycle the use-case re-reads, never the request body.
  // Mirrors admin-renew-lapsed-member's `deriveFiscalYear(cycle.periodFrom)`.
  // The canonical value is the fiscal year of the cycle's `periodFrom`
  // (Asia/Bangkok), the SAME convention the F4 §87 allocator + the admin
  // renew path use — so a renewal invoice buckets identically regardless
  // of which portal/admin path issued it.

  it('issues with the cycle-derived year (periodFrom fiscal year), ignoring a WRONG client planYear', async () => {
    // Cycle period 2026-06-01 → 2027-06-01 (the shared buildCycle default).
    // deriveFiscalYear('2026-06-01') = 2026 (Bangkok, Jan-start FY == CE).
    // A malicious/stale client posts 2099 — the server must ignore it.
    const cycle = buildCycle({
      periodFrom: '2026-06-01T00:00:00Z',
      periodTo: '2027-06-01T00:00:00Z',
      expiresAt: '2027-06-01T00:00:00Z',
    });
    const { deps, invoiceBridgeMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, withClientPlanYear(baseInput, 2099));
    expect(r.ok).toBe(true);
    // The bridge receives the server-derived 2026 — NOT the client's 2099,
    // and NOT the period-END year (2027). This is the off-by-one the portal
    // page's `expiresAt`-based derivation previously sent.
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      planYear: 2026,
      planId: 'plan-regular-2026',
    });
  });

  it('derives the periodFrom fiscal year even when it differs from the period-END year', async () => {
    // Period END (2027) ≠ period START (2026). The page used to send 2027
    // (period-END getUTCFullYear). The membership the catalogue prices is the
    // 2026 one — the §86/4 must say Membership 2026, keyed on (planId, 2026).
    const cycle = buildCycle({
      periodFrom: '2026-12-15T00:00:00Z',
      periodTo: '2027-12-15T00:00:00Z',
      expiresAt: '2027-12-15T00:00:00Z',
    });
    const { deps, invoiceBridgeMock } = fakeDeps({ cycle });
    // Client sends the (old, wrong) period-END year — server overrides it.
    const r = await confirmRenewal(deps, withClientPlanYear(baseInput, 2027));
    expect(r.ok).toBe(true);
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      planYear: 2026,
    });
  });

  it('after a plan-change, the year still derives from the re-snapshotted cycle period', async () => {
    // The plan-change branch re-snapshots frozen-plan fields but does NOT
    // move periodFrom — so the derived year tracks the cycle period, and the
    // §86/4 year is independent of the client value.
    const cycle = buildCycle({
      periodFrom: '2026-03-01T00:00:00Z',
      periodTo: '2027-03-01T00:00:00Z',
      expiresAt: '2027-03-01T00:00:00Z',
    });
    const { deps, invoiceBridgeMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(
      deps,
      withClientPlanYear({ ...baseInput, newPlanId: NEW_PLAN_ID }, 2050),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.planChanged).toBe(true);
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      planYear: 2026,
      planId: NEW_PLAN_ID,
    });
  });
});

describe('confirmRenewal (T122) — state validation', () => {
  it('cycle_not_found when cycle is null', async () => {
    const { deps } = fakeDeps({ cycle: null });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
  });

  it('cross_member_probe — emits audit + returns error', async () => {
    const cycle = buildCycle({ memberId: '00000000-0000-0000-0000-000000000999' });
    const { deps, emitInTxMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cross_member_probe') {
      expect(r.error.attemptedMemberId).toBe('00000000-0000-0000-0000-000000000999');
    }
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_cross_member_probe',
    });
  });

  it('I10 review-fix: cross_member_probe audit emit failure is fire-and-forget — returns error without rolling back (NOT Principle VIII reverse-direction)', async () => {
    // Locks the contract that the cross-member probe audit emit is
    // log+swallow (different from the linkInvoice + plan-change tx
    // emits which DO throw to roll back). The probe is a forensic
    // breadcrumb on a 404-equivalent path — no state mutation has
    // happened yet, so a missing audit row should NOT escalate to
    // a 500. Test prevents a future refactor that flips it to throw.
    const cycle = buildCycle({ memberId: '00000000-0000-0000-0000-000000000999' });
    const { deps } = fakeDeps({
      cycle,
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cross_member_probe');
  });

  it('cycle_not_payable — status mismatch (terminal)', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, invoiceBridgeMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_payable') {
      expect(r.error.currentStatus).toBe('completed');
    }
    expect(invoiceBridgeMock).not.toHaveBeenCalled();
  });

  it('cycle_not_payable — pending_admin_reactivation is NOT self-renewable (money-hold deferred)', async () => {
    const cycle = buildCycle({
      status: 'pending_admin_reactivation',
      enteredPendingAt: '2026-06-01T00:00:00.000Z',
    } as Partial<RenewalCycle>);
    const { deps, invoiceBridgeMock, transitionStatusMock } = fakeDeps({
      cycle,
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_payable') {
      expect(r.error.currentStatus).toBe('pending_admin_reactivation');
    }
    expect(transitionStatusMock).not.toHaveBeenCalled();
    expect(invoiceBridgeMock).not.toHaveBeenCalled();
  });
});

describe('confirmRenewal (slice 2.5 B-lazy) — early-renewal self-transition', () => {
  it.each(['upcoming', 'reminded'] as const)(
    'flips a %s cycle to awaiting_payment + emits renewal_entered_awaiting_payment(source:confirm) + proceeds',
    async (startStatus) => {
      const cycle = buildCycle({ status: startStatus });
      const { deps, transitionStatusMock, invoiceBridgeMock, emitInTxMock } =
        fakeDeps({ cycle });
      const r = await confirmRenewal(deps, baseInput);
      expect(r.ok).toBe(true);
      // The flip went through transitionStatus with the right edge.
      expect(transitionStatusMock).toHaveBeenCalledOnce();
      expect(transitionStatusMock.mock.calls[0]?.[3]).toMatchObject({
        from: startStatus,
        to: 'awaiting_payment',
      });
      // The renewal_entered_awaiting_payment audit fired with source:confirm.
      const enterEmit = emitInTxMock.mock.calls.find(
        (c) =>
          (c?.[1] as { type?: string })?.type ===
          'renewal_entered_awaiting_payment',
      );
      expect(enterEmit).toBeDefined();
      expect(enterEmit?.[1]).toMatchObject({
        type: 'renewal_entered_awaiting_payment',
        payload: { source: 'confirm', entered_at: expect.any(String) },
      });
      // Proceeded to issue the §86/4.
      expect(invoiceBridgeMock).toHaveBeenCalledOnce();
    },
  );

  it('idempotent CAS-loss: a concurrent writer won the flip → re-read sees awaiting_payment → proceeds WITHOUT a duplicate renewal_entered_awaiting_payment emit', async () => {
    const cycle = buildCycle({ status: 'upcoming' });
    const reread = buildCycle({ status: 'awaiting_payment' });
    const { deps, invoiceBridgeMock, emitInTxMock } = fakeDeps({
      cycle,
      rereadCycle: reread,
      transitionStatusImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'upcoming',
          'awaiting_payment',
        );
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    // We did NOT emit a second renewal_entered_awaiting_payment — the
    // winner already emitted its own (single-emit guarantee).
    const enterEmits = emitInTxMock.mock.calls.filter(
      (c) =>
        (c?.[1] as { type?: string })?.type ===
        'renewal_entered_awaiting_payment',
    );
    expect(enterEmits.length).toBe(0);
    // Still proceeds to issue the §86/4 — the member sees no failure.
    expect(invoiceBridgeMock).toHaveBeenCalledOnce();
  });

  it('CAS-loss then re-read finds a non-payable status (winner cancelled/lapsed it) → cycle_not_payable', async () => {
    const cycle = buildCycle({ status: 'upcoming' });
    const reread = buildCycle({
      status: 'cancelled',
      closedAt: '2026-06-13T00:00:00.000Z',
      closedReason: 'cancelled',
    } as Partial<RenewalCycle>);
    const { deps, invoiceBridgeMock } = fakeDeps({
      cycle,
      rereadCycle: reread,
      transitionStatusImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'upcoming',
          'cancelled',
        );
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_payable') {
      expect(r.error.currentStatus).toBe('cancelled');
    }
    expect(invoiceBridgeMock).not.toHaveBeenCalled();
  });

  it('CAS-loss then the cycle vanished on re-read → cycle_not_found', async () => {
    const cycle = buildCycle({ status: 'upcoming' });
    const { deps, invoiceBridgeMock } = fakeDeps({
      cycle,
      rereadCycle: null,
      transitionStatusImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'upcoming',
          'cancelled',
        );
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
    expect(invoiceBridgeMock).not.toHaveBeenCalled();
  });

  it('non-conflict transitionStatus throw propagates (not swallowed as cycle_not_payable)', async () => {
    const cycle = buildCycle({ status: 'upcoming' });
    const { deps } = fakeDeps({
      cycle,
      transitionStatusImpl: async () => {
        throw new Error('connection reset');
      },
    });
    await expect(confirmRenewal(deps, baseInput)).rejects.toThrow(
      /connection reset/,
    );
  });
});

describe('confirmRenewal (T122) — plan-change error paths', () => {
  it('plan_not_found when plan-lookup returns not_found', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      planLookup: { status: 'not_found' },
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('plan_not_found');
  });

  it('plan_inactive when plan-lookup returns plan_inactive', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      planLookup: { status: 'plan_inactive' },
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('plan_inactive');
  });

  it('TransitionConflict during plan-change → cycle_not_payable', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      updateFrozenPlanImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'awaiting_payment',
          'cancelled',
        );
      },
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_payable');
  });
});

describe('confirmRenewal (T122) — F4 invoice creation failures', () => {
  it('create_failed → invoice_creation_failed stage=create', async () => {
    const cycle = buildCycle();
    const { deps, linkInvoiceMock } = fakeDeps({
      cycle,
      invoiceResult: {
        status: 'create_failed',
        errorCode: 'plan_not_found',
        detail: 'F4 plan lookup empty',
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invoice_creation_failed') {
      expect(r.error.stage).toBe('create');
      expect(r.error.errorCode).toBe('plan_not_found');
    }
    expect(linkInvoiceMock).not.toHaveBeenCalled();
  });

  it('issue_failed → invoice_creation_failed stage=issue', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      invoiceResult: {
        // Real issue-stage F4 code (IssueInvoiceError['code']) — the closed
        // RenewalInvoiceErrorCode union rejects fabricated codes (was
        // 'sequence_allocator_locked', which the bridge can never emit). The
        // test only asserts stage='issue', so the exact code is not
        // load-bearing.
        status: 'issue_failed',
        errorCode: 'overflow',
        detail: 'F4 §87 sequence overflow',
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invoice_creation_failed') {
      expect(r.error.stage).toBe('issue');
    }
  });
});

describe('confirmRenewal (T122) — link / audit failure paths', () => {
  it('CycleNotFoundError on linkInvoice — returns server_error (orphan F4 invoice)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      linkInvoiceImpl: async () => {
        throw new CycleNotFoundError(CYCLE_UUID);
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('Principle VIII — audit emit failure throws to roll back linkInvoice', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    await expect(confirmRenewal(deps, baseInput)).rejects.toThrow(
      /audit_log: insert failed/,
    );
  });

  it('C4 review-fix: Principle VIII — plan-change emit failure rolls back updateFrozenPlan', async () => {
    // Locks the contract that the plan-change branch (FR-021b atomic
    // frozen-price update) wraps `updateFrozenPlan` + the two audit
    // emits (`renewal_with_plan_change` + `renewal_cycle_price_frozen`)
    // in a single tx whose audit failure propagates to rollback.
    // Without this assertion, a regression that moves
    // `updateFrozenPlan` outside the audit-tx would silently corrupt
    // frozen-price data on the next reviewer's polish PR.
    const cycle = buildCycle();
    let emitCount = 0;
    const { deps, updateFrozenPlanMock } = fakeDeps({
      cycle,
      emitInTxImpl: async () => {
        emitCount += 1;
        // Fail on the FIRST emit inside the state tx (with_plan_change)
        // — i.e., after updateFrozenPlan landed but before audit
        // committed. Mock-tx vi.mock('@/lib/db') means the throw
        // propagates back through the simulated tx wrapper (no real
        // rollback happens at the mock layer, but the throw IS the
        // observable contract that locks Principle VIII).
        if (emitCount === 1) throw new Error('audit_log: insert failed');
      },
    });
    await expect(
      confirmRenewal(deps, { ...baseInput, newPlanId: NEW_PLAN_ID }),
    ).rejects.toThrow(/audit_log: insert failed/);
    // updateFrozenPlan was called before the failing emit — that's the
    // mutation the Principle VIII rollback is meant to undo.
    expect(updateFrozenPlanMock).toHaveBeenCalledOnce();
  });
});

describe('confirmRenewal (T122) — input validation', () => {
  it('invalid_input on malformed cycleId', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('070 — a smuggled out-of-range client planYear is IGNORED (not validated), server derives a valid year from the cycle', async () => {
    // Before 070 this returned `invalid_input` (the schema validated a
    // client `planYear`). Now the field is server-derived, so an
    // over-the-wire 1999 is simply dropped — the use-case proceeds and
    // issues with the cycle-derived year. This pins that removing the
    // client field did NOT open a path to an out-of-range §86/4 year.
    const cycle = buildCycle({
      periodFrom: '2026-06-01T00:00:00Z',
      periodTo: '2027-06-01T00:00:00Z',
      expiresAt: '2027-06-01T00:00:00Z',
    });
    const { deps, invoiceBridgeMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, withClientPlanYear(baseInput, 1999));
    expect(r.ok).toBe(true);
    expect(invoiceBridgeMock.mock.calls[0]?.[0]).toMatchObject({
      planYear: 2026,
    });
  });
});

describe('selfServiceFailureReason — error → SelfServiceFailureReason mapping', () => {
  // Constitution Principle II coverage closure (R11) — pin the
  // ConfirmRenewalError → SelfServiceFailureReason mapping explicitly so
  // any future variant added to ConfirmRenewalError without a mapper
  // case fails the test suite (typecheck `_exhaustive: never` is the
  // first line of defence; this test is the second).

  it.each([
    [
      { kind: 'invoice_creation_failed', stage: 'create', errorCode: 'X', detail: 'Y' },
      'f4_invoice_create_failed',
    ],
    [{ kind: 'cycle_not_found' }, 'cycle_terminal'],
    [{ kind: 'cycle_not_payable', currentStatus: 'completed' }, 'cycle_terminal'],
    [{ kind: 'plan_not_found' }, 'plan_inactive'],
    [{ kind: 'plan_inactive' }, 'plan_inactive'],
    [{ kind: 'invalid_input', message: 'bad' }, 'invalid_input'],
    [{ kind: 'cross_member_probe', attemptedMemberId: 'mid' }, 'cross_member'],
    [{ kind: 'server_error', message: 'boom' }, 'server_error'],
  ] as const)('maps %j → %s', (errorVariant, expectedReason) => {
    const reason = selfServiceFailureReason(errorVariant as ConfirmRenewalError);
    expect(reason).toBe(expectedReason);
  });

  it('throws on unmapped variant (exhaustiveness runtime guard)', () => {
    // Cast through `unknown` to bypass the compile-time `never` check —
    // the runtime throw exists for post-typecheck divergence (e.g.
    // production polyfill bundle skew).
    const rogue = { kind: 'rogue_variant_post_compile' } as unknown as ConfirmRenewalError;
    expect(() => selfServiceFailureReason(rogue)).toThrow(/unmapped ConfirmRenewalError variant/);
  });
});
