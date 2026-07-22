/**
 * Plan-change -> billing remediation (Package A, Step A2 RED) — the seed
 * rewire's HEADLINE regression net. Live Neon Singapore via .env.local.
 *
 * THE BUG: when a member's live `members.plan_id` diverges from a renewal
 * cycle's frozen plan (admin changePlan / F8 tier-upgrade accept / member
 * portal pick), the NEXT cycle is seeded from the PRIOR cycle's plan
 * (`create-next-cycle-on-paid.ts:74` and `resolve-unlinked-membership-
 * payment.ts:614`), never from `members.plan_id` — so the divergence
 * compounds forever and the member is billed the wrong tier indefinitely.
 *
 * This file pins the FIX at BOTH payment rails and asserts they agree:
 *   - ONLINE  — the F4 record-payment webhook rail (`f8OnPaidCallbacks`
 *     chain: callback[0] completes the prior cycle, callback[2] creates
 *     the next cycle).
 *   - OFFLINE — the admin `markPaidOffline` rail (issues the §86/4 for the
 *     paid cycle via the F4 bridge, then creates the next cycle).
 *
 * The existing `create-next-cycle-on-paid.test.ts` seeds member AND cycle on
 * the SAME plan (:280), so it passes under both the buggy and the fixed
 * semantics — it is NOT a regression net for this bug. This test seeds the
 * cycle frozen to plan A while the member's LIVE plan is B, so the next
 * cycle MUST follow B (plan id + frozen price + tier).
 *
 * SCOPE NOTE (Package A): the member's live plan is set to B by a DIRECT
 * `members.plan_id` UPDATE rather than by driving the real `changePlan`
 * use-case. `changePlan` is a MEMBERS use-case owned by a later package;
 * the SEED (this package) reads only `members.plan_id`, so writing that
 * column directly tests exactly the unit under change and keeps this test
 * from coupling to changePlan's advisory-lock + reschedule-listener +
 * scheduled_plan_changes machinery. "changePlan flips members.plan_id" is
 * already covered by tests/integration/members/change-plan-*.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Stub PDF render / Blob upload / email outbox so the OFFLINE rail's F4
// bridge (issueAndMarkPaid -> createInvoiceDraft -> issueInvoice) does not
// touch the real PDF/Blob/email round-trip. Mirrors offline-frozen-price.test.ts.
// The ONLINE rail issues no invoice, so these mocks are inert for it.
vi.mock(
  '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter',
  async () => {
    const { Sha256Hex: S } = await import(
      '@/modules/invoicing/domain/value-objects/sha256-hex'
    );
    return {
      reactPdfRenderAdapter: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: S.ofUnsafe('c'.repeat(64)),
        })),
      },
    };
  },
);
vi.mock(
  '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter',
  () => ({
    vercelBlobAdapter: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      getSignedReadUrl: vi.fn(async () => 'https://blob.test/signed'),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
  }),
);
vi.mock(
  '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter',
  () => ({
    resendEmailOutboxAdapter: {
      enqueue: vi.fn(async () => undefined),
    },
  }),
);

import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { f8OnPaidCallbacks, markPaidOffline, makeRenewalsDeps } from '@/modules/renewals';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Plan A (the cycle's frozen plan) and plan B (the member's LIVE plan after
// the change). Distinct price AND tier so both fields prove the divergence.
const PLAN_A_FEE_MINOR = 2_500_000; // 25,000.00 THB
const PLAN_B_FEE_MINOR = 4_500_000; // 45,000.00 THB
const PLAN_B_PRICE_THB = '45000.00';
const PLAN_B_TIER = 'premium' as const;
const PLAN_A_PRICE_THB = '25000.00';

// Prior cycle expiry MUST be in the future relative to the wall clock (the
// offline rail's 066 §5.2 terminated-gate evaluates isMembershipLapsed
// against clock.now(), NOT the paid cycle). Plan B (2026) still resolves for
// the resulting fiscal-2027 next cycle via the FREEZE most-recent-active
// fallback (B has no 2027 row) — so the next cycle carries B's price + tier.
const PRIOR_PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PRIOR_PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

interface NextCycle {
  readonly planId: string;
  readonly frozenPrice: string;
  readonly tier: string;
}

describe('plan-change reaches the next cycle — ONLINE + OFFLINE rails (Package A)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planA: string;
  let planB: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({
      tenant,
      vatRate: '0.0700',
      registrationFeeSatang: 0n,
    });

    planA = `pc-a-${randomUUID().slice(0, 8)}`;
    planB = `pc-b-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planA,
        planName: { en: 'Plan A (frozen)' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: PLAN_A_FEE_MINOR,
        renewalTierBucket: 'regular',
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: planB,
        planName: { en: 'Plan B (member live)' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: PLAN_B_FEE_MINOR,
        renewalTierBucket: PLAN_B_TIER,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  /**
   * Seed a member frozen-on-A: a member row (initially plan A), a primary
   * contact, a terminal (cancelled, anchored) predecessor so the paying
   * cycle classifies as `renewal` (not `first_payment`), and a prior
   * awaiting_payment cycle on A linked to a just-issued invoice. Then flip
   * the member's LIVE plan to B via a direct UPDATE (the diverged state).
   * Returns { memberId, invoiceId }.
   */
  async function seedMemberFrozenOnADivergedToB(): Promise<{
    memberId: string;
    invoiceId: string;
  }> {
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    // tx1 — member, contact, terminal predecessor, invoice. The predecessor
    // MUST be inserted in an EARLIER tx than the awaiting cycle below: both
    // `renewal_cycles.created_at` default to the transaction timestamp, and
    // `findLatestCycleForMember` orders by `created_at DESC, cycle_id DESC`.
    // Same-tx inserts share created_at, so the random-UUID cycle_id tiebreaker
    // could pick the (lapsed) predecessor as "latest" -> markPaidOffline's
    // wall-clock terminated-gate would then refuse with `member_terminated`.
    // Separate txs make the awaiting cycle deterministically the latest.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `PlanChange Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: planA,
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Plan',
        lastName: 'Change',
        email: `pc-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
      });
      // Terminal predecessor (settled history) so the paying cycle
      // classifies as `renewal` -> completes + creates a next cycle.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'cancelled',
        periodFrom: new Date('2024-01-01T00:00:00.000Z'),
        periodTo: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planA,
        frozenPlanPriceThb: PLAN_A_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-01-01T00:00:00.000Z'),
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
        closedReason: 'cancelled',
      });
      // Invoice for the prior awaiting_payment cycle (FK for linkedInvoiceId).
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: planA,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: user.userId,
        fiscalYear: 2026,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(2_500_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(175_000n),
        totalSatang: asSatang(2_675_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'PlanChange Co',
          country: 'TH',
          legal_name: 'PlanChange Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Plan Change',
          primary_contact_email: 'pc@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
    // tx2 — the prior awaiting_payment cycle (strictly later created_at than
    // the predecessor above) + the plan divergence.
    await runInTenant(tenant.ctx, async (tx) => {
      // Prior awaiting_payment cycle FROZEN on plan A, linked to the invoice.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'awaiting_payment',
        periodFrom: PRIOR_PERIOD_FROM,
        periodTo: PRIOR_PERIOD_TO,
        expiresAt: PRIOR_PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planA,
        frozenPlanPriceThb: PLAN_A_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      });
      // DIVERGE: the member's LIVE plan is now B (post-change state). FK
      // members_plan_tenant_year_fk is satisfied — plan B has a 2026 row.
      await tx
        .update(members)
        .set({ planId: planB })
        .where(eq(members.memberId, memberId));
    });
    return { memberId, invoiceId };
  }

  function buildPaidEvent(invoiceId: string, memberId: string): F4InvoicePaidEvent {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      paidAt: new Date('2026-06-05T09:00:00.000Z').toISOString(),
      amountSatang: asSatang(2_675_000n),
      vatSatang: asSatang(175_000n),
      currency: 'THB',
      paymentMethod: 'stripe_card',
      triggeredBy: 'webhook',
      invoiceSubject: 'membership',
      paymentDate: null,
    };
  }

  async function loadNextCycle(memberId: string): Promise<NextCycle> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
          planId: renewalCycles.planIdAtCycleStart,
          frozenPrice: renewalCycles.frozenPlanPriceThb,
          tier: renewalCycles.tierAtCycleStart,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.memberId, memberId)),
    );
    const next = rows.find((r) => r.status === 'upcoming');
    expect(next, 'a NEW upcoming next cycle must exist after payment').toBeDefined();
    return {
      planId: next!.planId,
      frozenPrice: next!.frozenPrice,
      tier: next!.tier,
    };
  }

  /** ONLINE rail: fire the real f8OnPaidCallbacks chain for the paid invoice. */
  async function runOnlineRail(): Promise<NextCycle> {
    const { memberId, invoiceId } = await seedMemberFrozenOnADivergedToB();
    const callbacks = f8OnPaidCallbacks(tenant.ctx.slug);
    await runInTenant(tenant.ctx, async (tx) => {
      const evt = buildPaidEvent(invoiceId, memberId);
      for (const cb of callbacks) {
        await cb(evt, tx);
      }
    });
    return loadNextCycle(memberId);
  }

  /** OFFLINE rail: admin marks the awaiting cycle paid via markPaidOffline. */
  async function runOfflineRail(): Promise<NextCycle> {
    const { memberId } = await seedMemberFrozenOnADivergedToB();
    // The awaiting_payment cycle for this member is the one to mark paid.
    const openRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ cycleId: renewalCycles.cycleId })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.memberId, memberId),
            eq(renewalCycles.status, 'awaiting_payment'),
          ),
        ),
    );
    const cycleId = openRows[0]!.cycleId;
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: `BT-${memberId.slice(0, 8)}`,
      paymentDate: '2026-06-05',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(`markPaidOffline failed: ${JSON.stringify(r.error)}`);
    }
    expect(r.value.cycleStatus).toBe('completed');
    return loadNextCycle(memberId);
  }

  it(
    'both the ONLINE F4 webhook rail and the OFFLINE mark-paid rail seed the next cycle from members.plan_id (B) — identically',
    async () => {
      const online = await runOnlineRail();
      const offline = await runOfflineRail();

      // Each rail followed the member's LIVE plan (B), NOT the paid cycle's
      // frozen plan (A). Fails today: both seed from prior.planIdAtCycleStart.
      for (const [label, next] of [
        ['online', online],
        ['offline', offline],
      ] as const) {
        expect(next.planId, `${label} planId`).toBe(planB);
        expect(next.frozenPrice, `${label} frozenPrice`).toBe(PLAN_B_PRICE_THB);
        expect(next.tier, `${label} tier`).toBe(PLAN_B_TIER);
      }

      // ...and the two rails produce IDENTICAL next-cycle outcomes.
      expect({
        planId: online.planId,
        frozenPrice: online.frozenPrice,
        tier: online.tier,
      }).toEqual({
        planId: offline.planId,
        frozenPrice: offline.frozenPrice,
        tier: offline.tier,
      });
    },
    180_000,
  );
});
