/**
 * F8-completion Slice 3 · Task 3.1 — `adminRenewLapsedMember` integration.
 * Live Neon Singapore via .env.local. MANDATORY (Constitution Principle I
 * + VIII — tenant isolation + state↔audit atomicity on a tax-document path).
 *
 * The admin "renew / reactivate a lapsed member" reachable path. Proven
 * end-to-end against real Postgres + RLS:
 *
 *   1. **renew a lapsed member** — an admin renews a member with NO active
 *      cycle → a fresh `awaiting_payment` cycle exists, frozen at the
 *      member's CURRENT plan price, with a §86/4 invoice issued at that
 *      frozen price + linked to the cycle. THEN simulate the member paying
 *      (drive the real `f8OnPaidCallbacks` chain like the existing
 *      create-next-cycle-on-paid test) → callback[0] flips the fresh cycle
 *      `→completed` and callback[2] creates the next `upcoming` cycle — the
 *      loop closes, the member is active again.
 *   2. **already-active member** — renewing a member who already holds an
 *      active cycle returns `member_has_active_cycle` and creates NO second
 *      cycle.
 *   3. **cross-tenant probe** — tenant A's admin CANNOT renew tenant B's
 *      member: the member lookup is RLS-scoped → `member_not_found` (no
 *      oracle, no cross-tenant cycle/invoice).
 *
 * Test seam: the REAL `adminRenewLapsedMember` use-case driven through a
 * test F4 bridge that mirrors the production `f4InvoicingForRenewalBridge`
 * (real `createInvoiceDraft` + `issueInvoice`) with a mocked PDF render +
 * Blob upload — the SAME seam as confirm-lazy-transition.test.ts. The
 * member-plan lookup + cycle repo + audit emitter + the on-paid chain are
 * all the production Drizzle adapters.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  adminRenewLapsedMember,
  f8OnPaidCallbacks,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { AdminRenewLapsedMemberDeps } from '@/modules/renewals';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalInput,
  IssueInvoiceForRenewalResult,
} from '@/modules/renewals/application/ports/f4-invoicing-bridge';
import {
  createInvoiceDraft,
  issueInvoice,
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { asSatang, parseThbDecimalToSatang } from '@/lib/money';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const VAT_RATE = '0.0700';
/** F2 catalogue annual fee in minor units → frozen on the cycle as 50000.00. */
const ANNUAL_FEE_MINOR = 5_000_000;
const EXPECTED_FROZEN_THB = '50000.00';

/**
 * Test bridge mirroring `f4InvoicingForRenewalBridge` but with mocked
 * PDF/Blob in the issue step (real createInvoiceDraft + issueInvoice).
 * Identical seam to confirm-lazy-transition.test.ts.
 */
function makeTestRenewalBridge(): F4InvoicingForRenewalBridge {
  return {
    async issueInvoiceForRenewal(
      input: IssueInvoiceForRenewalInput,
    ): Promise<IssueInvoiceForRenewalResult> {
      const frozenUnitPriceSatang = parseThbDecimalToSatang(
        input.frozenPlanPriceThb,
      );
      const createResult = await createInvoiceDraft(
        makeCreateInvoiceDraftDeps(input.tenantId),
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          memberId: input.memberId,
          planId: input.planId,
          planYear: input.planYear,
          autoEmailOnIssue: input.autoEmailOnIssue,
          renewalSignal: { unitPriceSatang: frozenUnitPriceSatang },
          // Task 8 window-parity — forward the bridge's membershipCoverage
          // exactly like the production `f4InvoicingForRenewalBridge`
          // drizzle adapter (exactOptionalPropertyTypes — omit the key
          // rather than assign an explicit `undefined`).
          ...(input.membershipCoverage !== undefined
            ? { membershipCoverage: input.membershipCoverage }
            : {}),
        },
      );
      if (!createResult.ok) {
        return {
          status: 'create_failed',
          errorCode: createResult.error.code,
          detail:
            'reason' in createResult.error
              ? String(createResult.error.reason)
              : createResult.error.code,
        };
      }
      const draft = createResult.value;
      const real = makeIssueInvoiceDeps(input.tenantId);
      const mockedIssueDeps: IssueInvoiceDeps = {
        ...real,
        pdfRender: {
          render: vi.fn(async (_i: PdfRenderInput) => ({
            bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
          })),
        },
        blob: {
          uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
            key,
            url: `https://blob.test/${key}`,
          })),
          uploadLogo: vi.fn(),
          signDownloadUrl: vi.fn(),
          downloadBytes: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
        } as unknown as IssueInvoiceDeps['blob'],
      };
      const issueResult = await issueInvoice(mockedIssueDeps, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        invoiceId: draft.invoiceId,
      });
      if (!issueResult.ok) {
        return {
          status: 'issue_failed',
          errorCode: issueResult.error.code,
          detail:
            'reason' in issueResult.error
              ? String(issueResult.error.reason)
              : issueResult.error.code,
        };
      }
      const issued = issueResult.value;
      return {
        status: 'issued',
        invoiceId: issued.invoiceId,
        invoiceNumber:
          issued.documentNumber !== null ? String(issued.documentNumber) : '',
        totalSatang:
          issued.total !== null
            ? asSatang(BigInt(issued.total.satang))
            : asSatang(0n),
      };
    },
  };
}

describe('adminRenewLapsedMember — integration (Slice 3 / Task 3.1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  /** Build the use-case deps: real Drizzle deps + the test F4 bridge. */
  function makeDeps(tenantSlug: string): AdminRenewLapsedMemberDeps {
    const real = makeRenewalsDeps(tenantSlug);
    return {
      tenant: real.tenant,
      cyclesRepo: real.cyclesRepo,
      auditEmitter: real.auditEmitter,
      clock: real.clock,
      planLookupForRenewal: real.planLookupForRenewal,
      memberPlanLookup: real.memberPlanLookup,
      cycleIdFactory: real.cycleIdFactory,
      f4InvoicingBridge: makeTestRenewalBridge(),
    };
  }

  /** Seed a lapsed member: member + primary contact, NO active cycle. */
  async function seedLapsedMember(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Lapsed Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Lapsed',
        lastName: 'Comeback',
        email: `lapsed-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
      });
    });
    return memberId;
  }

  function buildPaidEvent(
    invoiceId: string,
    memberId: string,
  ): F4InvoicePaidEvent {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      paidAt: new Date().toISOString(),
      amountSatang: asSatang(5_350_000n),
      vatSatang: asSatang(350_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
  }

  /** Fire the real on-paid chain sequentially (mirrors F4 record-payment). */
  async function fireOnPaidChain(
    invoiceId: string,
    memberId: string,
  ): Promise<void> {
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt = buildPaidEvent(invoiceId, memberId);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: VAT_RATE });

    planId = `f8-lapsed-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Lapsed Comeback Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: ANNUAL_FEE_MINOR,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(invoices)
      .where(eq(invoices.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(contacts)
      .where(eq(contacts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('renews a lapsed member: fresh awaiting_payment cycle + §86/4 at the frozen price + linked; then payment closes the loop (next upcoming cycle)', async () => {
    const memberId = await seedLapsedMember();

    // Rolling-anchor refactor (Task 6, migration 0238) — a TERMINAL
    // predecessor cycle (`status:'lapsed'`) so this member has real cycle
    // history, not the shared classifier's `first_payment` shape ("exactly
    // one cycle ever, unanchored"). "Lapsed" means the member's PRIOR cycle
    // expired without renewal — this is exactly that prior cycle, dated to
    // line up with `seedLapsedMember`'s `registrationDate: '2020-01-01'`.
    // Without it, paying the fresh comeback cycle below would re-anchor it
    // instead of completing + creating the next cycle, breaking this test's
    // whole "the loop closes" premise. Mirrors e8da485b's pattern.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'lapsed',
        periodFrom: new Date('2020-01-01T00:00:00Z'),
        periodTo: new Date('2021-01-01T00:00:00Z'),
        expiresAt: new Date('2021-01-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: EXPECTED_FROZEN_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: new Date('2021-01-01T00:00:00Z'),
        closedReason: 'lapsed',
      }),
    );

    const result = await adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      memberId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: `admin-renew-${memberId}`,
      requestId: `req-${memberId.slice(0, 8)}`,
    });
    if (!result.ok) {
      throw new Error(`admin renew failed: ${JSON.stringify(result.error)}`);
    }
    expect(result.value.cycleStatus).toBe('awaiting_payment');

    // The fresh cycle is awaiting_payment, frozen at the member's current
    // plan price, linked to the issued §86/4.
    const freshCycle = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          frozenPrice: renewalCycles.frozenPlanPriceThb,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
          periodFrom: renewalCycles.periodFrom,
          periodTo: renewalCycles.periodTo,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, result.value.cycleId))
        .limit(1),
    );
    expect(freshCycle[0]?.status).toBe('awaiting_payment');
    expect(freshCycle[0]?.frozenPrice).toBe(EXPECTED_FROZEN_THB);
    expect(freshCycle[0]?.linkedInvoiceId).toBe(result.value.invoiceId);

    // The §86/4 was issued at the frozen VAT-exclusive price (subtotal =
    // 50000.00 → 5,000,000 satang). NEVER a request-body price.
    const invoiceRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          subtotalSatang: invoices.subtotalSatang,
          memberId: invoices.memberId,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, result.value.invoiceId))
        .limit(1),
    );
    expect(invoiceRow[0]?.status).toBe('issued');
    expect(invoiceRow[0]?.memberId).toBe(memberId);
    expect(Number(invoiceRow[0]?.subtotalSatang)).toBe(ANNUAL_FEE_MINOR);

    // Task 8 window-parity — the comeback §86/4's membership line prints
    // the EXACT fresh-cycle window (periodFrom → periodTo), not the
    // generic "12 months from month of payment" fallback (which would
    // apply if `membershipCoverage` were never threaded through this
    // bridge call).
    const membershipLine = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ descriptionEn: invoiceLines.descriptionEn })
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, result.value.invoiceId)),
    );
    const fromDate = freshCycle[0]!.periodFrom.toISOString().slice(0, 10);
    const toDate = freshCycle[0]!.periodTo.toISOString().slice(0, 10);
    expect(
      membershipLine.some((l) =>
        l.descriptionEn.includes(`(coverage ${fromDate} to ${toDate})`),
      ),
    ).toBe(true);

    // A renewal_cycle_created audit (from createCycleInTx) landed for the
    // fresh cycle.
    const cycleAudits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            // F8 event types lag the F1 pgEnum TS union — established cast.
            eq(auditLog.eventType, 'renewal_cycle_created' as never),
          ),
        ),
    );
    expect(
      cycleAudits.filter(
        (r) =>
          (r.payload as { cycle_id?: string }).cycle_id === result.value.cycleId,
      ).length,
    ).toBe(1);

    // ---- Simulate the member paying → the loop closes. The on-paid chain
    // flips the fresh cycle →completed (callback[0]) AND creates the next
    // `upcoming` cycle (callback[2]).
    await fireOnPaidChain(result.value.invoiceId, memberId);

    const allCycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          periodFrom: renewalCycles.periodFrom,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    // Exactly 3 cycles: the terminal `lapsed` predecessor (seeded above) +
    // the fresh one (now completed) + the next (upcoming).
    expect(allCycles).toHaveLength(3);
    const fresh = allCycles.find((c) => c.cycleId === result.value.cycleId);
    const next = allCycles.find(
      (c) => c.cycleId !== result.value.cycleId && c.status === 'upcoming',
    );
    expect(fresh?.status).toBe('completed');
    expect(next?.status).toBe('upcoming');
    // Gapless: the next cycle anchors at the fresh cycle's period_to.
    expect(next?.periodFrom.toISOString()).toBe(
      freshCycle[0]!.periodTo.toISOString(),
    );
  }, 180_000);

  it('member_has_active_cycle: renewing a member who already has an active cycle creates NO second cycle', async () => {
    const memberId = await seedLapsedMember();

    // First renew → creates the active awaiting_payment cycle.
    const first = await adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      memberId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: `admin-renew-1-${memberId}`,
    });
    if (!first.ok) {
      throw new Error(`first renew failed: ${JSON.stringify(first.error)}`);
    }

    // Second renew on the SAME member (now has an active cycle) → rejected.
    const second = await adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      memberId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: `admin-renew-2-${memberId}`,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.kind).toBe('member_has_active_cycle');

    // Still exactly one cycle for the member.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ cycleId: renewalCycles.cycleId })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    expect(rows).toHaveLength(1);
  }, 180_000);

  it('L1 concurrent double-submit: two parallel renews on the SAME lapsed member → exactly ONE awaiting_payment cycle + ONE §86/4; the loser returns member_has_active_cycle (NOT server_error)', async () => {
    const memberId = await seedLapsedMember();

    // Fire two admin renews concurrently. One wins the
    // `renewal_cycles_active_member_uniq` partial index; the loser's
    // createCycleInTx insert raises a 23505 that propagates out of tx1.
    // The L1 fix maps that 23505 → member_has_active_cycle (409-class),
    // NOT server_error (500). NOTE: the win can land via TWO paths —
    // either the loser's in-tx `findActiveForMemberInTx` guard sees the
    // winner's committed cycle (→ skipped_active_exists), or it races
    // past the guard and the unique index fires the 23505. Both surface
    // the SAME member_has_active_cycle error; the L1 fix closes the
    // 23505 path that previously fell through to server_error.
    const [a, b] = await Promise.all([
      adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        memberId,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: `race-a-${memberId}`,
      }),
      adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        memberId,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: `race-b-${memberId}`,
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0]!;
    if (loser.ok) throw new Error('unreachable');
    // The crux of L1: the loser is a clean 409-class member_has_active_cycle,
    // NEVER an opaque server_error from an unhandled 23505.
    expect(loser.error.kind).toBe('member_has_active_cycle');

    // Exactly ONE non-terminal (active) cycle exists for the member.
    const activeCycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ cycleId: renewalCycles.cycleId, status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    expect(activeCycles).toHaveLength(1);
    expect(activeCycles[0]?.status).toBe('awaiting_payment');

    // Exactly ONE §86/4 was issued (the loser never reaches the F4 issue
    // step — its tx1 rolled back before invoice issuance).
    const memberInvoices = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.memberId, memberId)),
    );
    expect(memberInvoices).toHaveLength(1);
    expect(memberInvoices[0]?.status).toBe('issued');
  }, 180_000);

  it('archived member: renewing an archived member returns member_archived + creates NO cycle (cluster C, 068)', async () => {
    // Seed a member then ARCHIVE it (status='archived' + archivedAt). The
    // admin renew-lapsed UI affordance is NOT gated on archive status, so an
    // archived member could otherwise reach createCycleInTx (committed cycle
    // in tx1) before createInvoiceDraft later rejects member_archived →
    // orphan cycle + every retry returns member_has_active_cycle (wedged).
    // The cluster-C precheck rejects archived BEFORE the cycle is created.
    const memberId = await seedLapsedMember();
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(eq(members.memberId, memberId)),
    );

    const result = await adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      memberId,
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: `admin-renew-archived-${memberId}`,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('member_archived');

    // CRITICAL: NO cycle was created — no orphan awaiting_payment row.
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ cycleId: renewalCycles.cycleId })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    expect(cycles).toHaveLength(0);

    // And no §86/4 was issued for the archived member.
    const memberInvoices = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(eq(invoices.memberId, memberId)),
    );
    expect(memberInvoices).toHaveLength(0);
  }, 180_000);

  it('cross-tenant probe: tenant A admin cannot renew tenant B member → member_not_found (no cross-tenant cycle/invoice)', async () => {
    // Seed a member in a SEPARATE tenant B.
    const tenantB = await createTestTenant();
    try {
      await seedTenantFiscal({ tenant: tenantB, vatRate: VAT_RATE });
      const planB = `f8-lapsed-b-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenantB.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenantB.ctx.slug,
          planId: planB,
          planName: { en: 'Tenant B Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: user.userId,
          annualFeeMinorUnits: ANNUAL_FEE_MINOR,
        }),
      );
      const memberB = randomUUID();
      await runInTenant(tenantB.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenantB.ctx.slug,
          memberId: memberB,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Tenant B Co',
          country: 'TH',
          planId: planB,
          planYear: 2026,
          registrationFeePaid: true,
          registrationDate: '2020-01-01',
        });
        await tx.insert(contacts).values({
          tenantId: tenantB.ctx.slug,
          contactId: randomUUID(),
          memberId: memberB,
          firstName: 'TenantB',
          lastName: 'Member',
          email: `tenantb-${memberB.slice(0, 8)}@example.com`,
          isPrimary: true,
        });
      });

      // Tenant A's admin (deps scoped to tenant A) attempts to renew
      // tenant B's member id. RLS scopes the member lookup to tenant A →
      // the member is invisible → member_not_found (no oracle).
      const result = await adminRenewLapsedMember(makeDeps(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        memberId: memberB,
        actorUserId: user.userId,
        actorRole: 'admin',
        correlationId: `cross-tenant-${memberB}`,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('member_not_found');

      // NO cycle or invoice was created for tenant B's member.
      const cyclesB = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ cycleId: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(eq(renewalCycles.memberId, memberB)),
      );
      expect(cyclesB).toHaveLength(0);
    } finally {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(invoices)
        .where(eq(invoices.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(contacts)
        .where(eq(contacts.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(members)
        .where(eq(members.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }
  }, 180_000);
});
