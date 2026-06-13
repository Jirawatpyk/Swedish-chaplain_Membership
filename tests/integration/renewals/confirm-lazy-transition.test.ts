/**
 * F8-completion slice 2 · Task 2.5 (B-lazy) — confirm-renewal lazy
 * self-transition + convergence with the T-0 cron. Live Neon Singapore
 * via .env.local.
 *
 * Until the enter-awaiting cron has run, most cycles are still
 * `upcoming|reminded` when the member lands on the portal. The lazy
 * confirm-transition lets the member renew EARLY: `confirmRenewal`
 * self-transitions the cycle `upcoming|reminded → awaiting_payment`
 * inside its Step-1 tx (under the per-cycle advisory lock acquired as
 * the FIRST statement) before proceeding to issue the §86/4.
 *
 * Three behaviours proven here against real Postgres + RLS:
 *
 *   1. **early-renewal happy path** — confirming an `upcoming` cycle
 *      self-transitions it to `awaiting_payment`, emits
 *      `renewal_entered_awaiting_payment` (source:'confirm'), then
 *      issues + links the §86/4 end-to-end.
 *   2. **already-payable** — confirming an `awaiting_payment` cycle is
 *      unchanged (no self-transition, no second
 *      renewal_entered_awaiting_payment emit) and proceeds.
 *   3. **convergence** — a concurrent cron-flip
 *      (`enterAwaitingPaymentOnExpiry`) + confirm-flip on the SAME
 *      `upcoming` cycle converge to exactly ONE `awaiting_payment` row.
 *      The loser of the `transitionStatus` CAS re-reads cleanly (sees
 *      the cycle is already `awaiting_payment`) and proceeds — it does
 *      NOT surface `cycle_not_payable`, does NOT double-flip, and does
 *      NOT emit a second `renewal_entered_awaiting_payment`. Exactly one
 *      writer's emit lands.
 *
 * Test seam: the REAL `confirmRenewal` use-case driven through a test
 * F4 bridge that mirrors the production `f4InvoicingForRenewalBridge`
 * (real `createInvoiceDraft` + `issueInvoice`) with a mocked PDF
 * render + Blob upload (same seam as confirm-with-plan-change.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  confirmRenewal,
  enterAwaitingPaymentOnExpiry,
  makeRenewalsDeps,
} from '@/modules/renewals';
import type { ConfirmRenewalDeps } from '@/modules/renewals/application/use-cases/confirm-renewal';
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
const FROZEN_THB = '50000.00';

/**
 * Test bridge mirroring `f4InvoicingForRenewalBridge` but with mocked
 * PDF/Blob in the issue step (real createInvoiceDraft + issueInvoice).
 * Identical to the seam used in confirm-with-plan-change.test.ts.
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

describe('F8 confirm-renewal lazy self-transition (B-lazy, Task 2.5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: VAT_RATE });

    planId = `f8-lazy-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Lazy Transition Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 5_000_000,
      }),
    );
  }, 120_000);

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
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  /** Seed one member + a renewal cycle in the given start status. */
  async function seedMemberWithCycle(
    status: 'upcoming' | 'reminded' | 'awaiting_payment',
  ): Promise<{ memberId: string; cycleId: string }> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Lazy Co',
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
        firstName: 'Lazy',
        lastName: 'Renewer',
        email: `lazy-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status,
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
    return { memberId, cycleId };
  }

  function makeConfirmDeps(): ConfirmRenewalDeps {
    const realDeps = makeRenewalsDeps(tenant.ctx.slug);
    return {
      tenant: realDeps.tenant,
      cyclesRepo: realDeps.cyclesRepo,
      auditEmitter: realDeps.auditEmitter,
      clock: realDeps.clock,
      planLookupForRenewal: realDeps.planLookupForRenewal,
      f4InvoicingBridge: makeTestRenewalBridge(),
    };
  }

  /** Count renewal_entered_awaiting_payment audits for a cycle. */
  async function countEnterAudits(cycleId: string): Promise<number> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            // The Drizzle pgEnum TS union lags the DB enum (migration
            // 0215) — cast per the create-next-cycle-on-paid precedent.
            eq(
              auditLog.eventType,
              'renewal_entered_awaiting_payment' as never,
            ),
          ),
        ),
    );
    return rows.filter(
      (r) => (r.payload as { cycle_id?: string }).cycle_id === cycleId,
    ).length;
  }

  it('early-renewal: confirming an `upcoming` cycle self-transitions to awaiting_payment + emits source:confirm + issues §86/4', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle('upcoming');

    const result = await confirmRenewal(makeConfirmDeps(), {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      planYear: 2026,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: `lazy-up-${cycleId}`,
    });
    if (!result.ok) {
      throw new Error(`confirm failed: ${JSON.stringify(result.error)}`);
    }

    // Cycle is now awaiting_payment + linked to the issued invoice.
    const cycleRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(cycleRow[0]?.status).toBe('awaiting_payment');
    expect(cycleRow[0]?.linkedInvoiceId).toBe(result.value.invoiceId);

    // Exactly one renewal_entered_awaiting_payment (source:'confirm').
    const enterAudits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(
              auditLog.eventType,
              'renewal_entered_awaiting_payment' as never,
            ),
          ),
        ),
    );
    const forThisCycle = enterAudits.filter(
      (r) => (r.payload as { cycle_id?: string }).cycle_id === cycleId,
    );
    expect(forThisCycle.length).toBe(1);
    expect(forThisCycle[0]?.payload).toMatchObject({
      cycle_id: cycleId,
      member_id: memberId,
      source: 'confirm',
    });
  }, 120_000);

  it('already-payable: confirming an `awaiting_payment` cycle does NOT re-transition or re-emit', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle('awaiting_payment');

    const result = await confirmRenewal(makeConfirmDeps(), {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      planYear: 2026,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: `lazy-ap-${cycleId}`,
    });
    if (!result.ok) {
      throw new Error(`confirm failed: ${JSON.stringify(result.error)}`);
    }

    const cycleRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(cycleRow[0]?.status).toBe('awaiting_payment');

    // No renewal_entered_awaiting_payment emitted — it was already payable.
    expect(await countEnterAudits(cycleId)).toBe(0);
  }, 120_000);

  it('convergence: concurrent cron-flip + confirm-flip on the same upcoming cycle → ONE awaiting_payment row, loser re-reads cleanly, single emit', async () => {
    const { memberId, cycleId } = await seedMemberWithCycle('upcoming');

    // The cron's eligibility list uses `expires_at <= now`. Seed
    // expires in the FUTURE (2027) → use a `now` past it so the cron
    // picks the cycle up. Both writers race the same `upcoming → awaiting`
    // CAS under the per-cycle advisory lock; exactly one wins, the other
    // sees the cycle already `awaiting_payment` and skips/re-reads.
    const depsCron = makeRenewalsDeps(tenant.ctx.slug);

    const [cronResult, confirmResult] = await Promise.all([
      enterAwaitingPaymentOnExpiry(depsCron, {
        tenantId: tenant.ctx.slug,
        now: new Date('2027-07-01T00:00:00Z'),
        correlationId: `conv-cron-${cycleId}`,
      }),
      confirmRenewal(makeConfirmDeps(), {
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        planYear: 2026,
        actorUserId: user.userId,
        actorRole: 'member',
        correlationId: `conv-confirm-${cycleId}`,
      }),
    ]);

    // Neither path errors out — the member never sees a spurious failure.
    expect(cronResult.ok).toBe(true);
    if (!confirmResult.ok) {
      throw new Error(
        `confirm failed under convergence: ${JSON.stringify(confirmResult.error)}`,
      );
    }

    // Exactly ONE awaiting_payment row (no orphan, no double-flip).
    const cycleRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(cycleRow[0]?.status).toBe('awaiting_payment');
    // Confirm still issued + linked its §86/4 (the member's renewal
    // completed even though it may have lost the transition CAS).
    expect(cycleRow[0]?.linkedInvoiceId).toBe(confirmResult.value.invoiceId);

    // Exactly one renewal_entered_awaiting_payment for this cycle —
    // the winner emitted once; the loser re-read cleanly and did NOT
    // emit a duplicate.
    expect(await countEnterAudits(cycleId)).toBe(1);
  }, 120_000);
});
