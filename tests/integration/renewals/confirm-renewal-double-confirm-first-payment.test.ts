/**
 * M-1 hardening (renewals-coverage-window-hardening) — the confirm-renewal
 * duplicate-bill PRE-FLIGHT guard must probe the SAME coverage window it
 * STAMPS. Before the fix, the pre-flight `wNew` was HARDCODED to the
 * next-period renewal window `[periodTo, periodTo + frozenTerm)` for EVERY
 * classification, while a FIRST-PAYMENT bill actually stamps the cycle's OWN
 * current period `[periodFrom, periodTo)` (the L3 fix). On a first-payment
 * DOUBLE-CONFIRM that mismatch made the second confirm's pre-flight MISS the
 * existing bill (probed `[periodTo, +term)` vs stamped `[periodFrom, periodTo)`
 * → no overlap), so it PROCEEDED to mint a rival draft, then `issueMembershipBill`
 * hit the DB EXCLUDE (`invoices_membership_coverage_no_overlap`, 23P01) — money-safe
 * (no duplicate §86/4 at `issued`, no §87 number burned) but leaving a LEFTOVER
 * non-numbered `draft` row behind and returning `invoice_creation_failed` instead
 * of a clean pre-flight refusal.
 *
 * After the fix the classification is computed BEFORE the pre-flight guard and the
 * guard's `wNew` mirrors the stamp, so the second confirm is REFUSED at the
 * pre-flight with `invoice_already_exists` — no mint, no leftover draft.
 *
 * This seeds an `upcoming` cycle (no settled predecessor, `anchored_at IS NULL`)
 * so the FIRST confirm ALSO exercises the lazy `upcoming → awaiting_payment`
 * self-transition — directly validating that the moved classification (computed
 * above the lazy-flip) still resolves `first_payment` (the classifier ignores
 * `openCycle.status`; `anchored_at` is stable across the flip).
 *
 * Test seam: drives the REAL `confirmRenewal` + the REAL F4 issue bridge
 * end-to-end (NO bridge mock — the pre-flight/stamp window IS the unit under test)
 * with the F4 PDF render + Blob upload + email outbox mocked at module level
 * (mirrors `confirm-renewal-coverage-window.test.ts`, the L3 sibling).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Stub render/blob/outbox so the bridge's internal makeIssueMembershipBillDeps
// picks up mocked PDF/Blob — the system under test is the pre-flight/stamp
// coverage window, not the PDF/email round-trip. Same pattern as
// confirm-renewal-coverage-window.test.ts.
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
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { confirmRenewal, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const FROZEN_PRICE_THB = '50000.00';
// periodFrom's fiscal year (Asia/Bangkok, Jan-start) is 2026 → matches the
// seedF8MembershipPlan default plan_year, so getAnnualFeeSatang(planId, 2026)
// resolves.
const PERIOD_FROM_ISO = '2026-06-01T00:00:00.000Z';
const PERIOD_TO_ISO = '2027-06-01T00:00:00.000Z';
const TERM_MONTHS = 12;

// FIRST-PAYMENT bill (L3) stamps the CURRENT period [periodFrom, periodTo).
const FIRST_PAY_COVERAGE_FROM = PERIOD_FROM_ISO;
const FIRST_PAY_COVERAGE_TO = PERIOD_TO_ISO;

describe('F8 confirm-renewal — first-payment double-confirm refuses at pre-flight (M-1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;
  let cycleId: string;

  async function seedMemberWithContact(companyName: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Double',
        lastName: 'Confirm',
        email: `${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
    });
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: '0.0700' });

    planId = `f8-dblconf-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Double-Confirm First-Payment Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 5_000_000,
      }),
    );

    await seedMemberWithContact('Double Confirm First-Pay Co');

    // FIRST-PAYMENT member — the member's ONLY-EVER cycle, never anchored
    // (`anchored_at` NULL) + no settled predecessor → classifier `first_payment`.
    // Seeded `upcoming` so the FIRST confirm also drives the lazy
    // `upcoming → awaiting_payment` self-transition (the moved classification
    // sits above that flip and must still resolve first_payment).
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date(PERIOD_FROM_ISO),
        periodTo: new Date(PERIOD_TO_ISO),
        expiresAt: new Date(PERIOD_TO_ISO),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: TERM_MONTHS,
        frozenPlanCurrency: 'THB',
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
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('mints ONE first-payment bill, then refuses the second confirm at the pre-flight with invoice_already_exists (no leftover draft)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // ---- First confirm — succeeds, issues §86/4 #1, lazy-flips the cycle.
    const r1 = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: randomUUID(),
    });
    if (!r1.ok) {
      throw new Error(`first confirmRenewal failed: ${JSON.stringify(r1.error)}`);
    }
    const bill1Id = r1.value.invoiceId;

    // Bill #1 covers the FIRST-PAYMENT window [periodFrom, periodTo).
    const cov = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ from: invoices.coverageFrom, to: invoices.coverageTo })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, bill1Id),
          ),
        )
        .limit(1),
    );
    expect(cov[0]?.from?.toISOString()).toBe(FIRST_PAY_COVERAGE_FROM);
    expect(cov[0]?.to?.toISOString()).toBe(FIRST_PAY_COVERAGE_TO);

    // The lazy self-transition ran — cycle is now awaiting_payment, linked to #1,
    // still un-anchored (anchoring happens at PAY time, not confirm) → the second
    // confirm re-classifies first_payment.
    const cycleRow = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          anchoredAt: renewalCycles.anchoredAt,
          linkedInvoiceId: renewalCycles.linkedInvoiceId,
        })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.cycleId, cycleId),
          ),
        )
        .limit(1),
    );
    expect(cycleRow[0]?.status).toBe('awaiting_payment');
    expect(cycleRow[0]?.anchoredAt).toBeNull();
    expect(cycleRow[0]?.linkedInvoiceId).toBe(bill1Id);

    // ---- Second confirm on the SAME cycle — must be REFUSED at the pre-flight.
    // Before the M-1 fix this MISSED (probed [periodTo, +term) vs #1's
    // [periodFrom, periodTo)) → minted a rival draft → 23P01 at issue →
    // `invoice_creation_failed` + a leftover draft row.
    const r2 = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: randomUUID(),
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) {
      throw new Error('second confirmRenewal unexpectedly succeeded');
    }
    expect(r2.error.kind).toBe('invoice_already_exists');
    if (r2.error.kind === 'invoice_already_exists') {
      expect(r2.error.invoiceId).toBe(bill1Id);
    }

    // ---- EXACTLY ONE invoice row for the member — the issued #1, NO leftover
    // draft #2 (the decisive M-1 assertion: RED before the fix — 2 rows: #1
    // issued + #2 draft; GREEN after — 1 row). Also proves the §87 stream did
    // not advance for a phantom bill (no second numbered/draft bill exists).
    const memberInvoices = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          invoiceId: invoices.invoiceId,
          status: invoices.status,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.memberId, memberId),
          ),
        ),
    );
    expect(memberInvoices).toHaveLength(1);
    expect(memberInvoices[0]?.invoiceId).toBe(bill1Id);
    expect(memberInvoices[0]?.status).toBe('issued');
  }, 120_000);
});
