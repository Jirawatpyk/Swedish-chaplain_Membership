/**
 * L3 hardening (renewals-coverage-window-hardening) — the ONLINE confirm-renewal
 * path stamps `invoices.coverage_from/to` (the mig-0281 duplicate-coverage
 * EXCLUDE window) CLASSIFICATION-GATED:
 *   - a RENEWAL bill covers the NEXT period `[periodTo, periodTo + frozenTerm)`;
 *   - a FIRST-PAYMENT bill covers the cycle's OWN CURRENT period
 *     `[periodFrom, periodTo)` (the L3 fix — was the next-period window, which
 *     FALSE-REFUSED the member's first renewal; see
 *     `.superpowers/sdd/coverage-hardening-report.md` § L2/L3 and the pure
 *     property `tests/unit/renewals/domain/first-payment-coverage-overblock.prop.test.ts`).
 *
 * Both windows are NON-NULL — the renewal bridge requires a coverage window by
 * design (a NULL row escapes both the pre-flight guard and the DB
 * `blocks_coverage` EXCLUDE), so confirm-renewal never stamps NULL. The
 * first-payment window is ADJACENT (half-open) to the member's next renewal
 * `[periodTo, periodTo+term)` → no over-block; and a duplicate first-payment
 * would stamp the SAME window → the DB EXCLUDE rejects it at issue.
 *
 * Test seam: drives the REAL `confirmRenewal` + the REAL F4 issue bridge
 * end-to-end (NO bridge mock — the coverage-window stamp IS the unit under test)
 * with the F4 PDF render + Blob upload + email outbox mocked at module level
 * (mirrors `offline-mark-paid-coverage-window.test.ts`, the L1 sibling).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Stub render/blob/outbox so the bridge's internal makeIssueInvoiceDeps /
// makeIssueMembershipBillDeps pick up mocked PDF/Blob — the system under test is
// the coverage-window stamp, not the PDF/email round-trip. Same pattern as
// offline-mark-paid-coverage-window.test.ts.
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
import { addMonthsUtc } from '@/lib/dates';
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
// Cycle period + term. periodFrom's fiscal year (Asia/Bangkok, Jan-start) is
// 2026 → matches the seedF8MembershipPlan default plan_year, so the F4
// getAnnualFeeSatang(planId, 2026) lookup resolves for both cases.
const PERIOD_FROM_ISO = '2026-06-01T00:00:00.000Z';
const PERIOD_TO_ISO = '2027-06-01T00:00:00.000Z';
const TERM_MONTHS = 12;

// RENEWAL bill → the NEXT period: [periodTo, periodTo + term) = [2027-06-01, 2028-06-01).
const RENEWAL_COVERAGE_FROM = PERIOD_TO_ISO;
const RENEWAL_COVERAGE_TO = addMonthsUtc(PERIOD_TO_ISO, TERM_MONTHS);
// FIRST-PAYMENT bill (L3 fix) → the CURRENT period: [periodFrom, periodTo) = [2026-06-01, 2027-06-01).
const FIRST_PAY_COVERAGE_FROM = PERIOD_FROM_ISO;
const FIRST_PAY_COVERAGE_TO = PERIOD_TO_ISO;

describe('F8 online confirm-renewal — coverage_from/to window stamp (mig 0281, L3)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberRenewalId: string;
  let cycleRenewalId: string;
  let memberFirstPayId: string;
  let cycleFirstPayId: string;

  async function readCoverage(
    invoiceId: string,
  ): Promise<{ from: Date | null; to: Date | null }> {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ from: invoices.coverageFrom, to: invoices.coverageTo })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, invoiceId),
          ),
        )
        .limit(1),
    );
    return { from: row?.from ?? null, to: row?.to ?? null };
  }

  async function seedMemberWithContact(
    memberId: string,
    companyName: string,
  ): Promise<void> {
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
        firstName: 'Coverage',
        lastName: 'Window',
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

    planId = `f8-onl-covwin-${randomUUID().slice(0, 8)}`;
    memberRenewalId = randomUUID();
    cycleRenewalId = randomUUID();
    memberFirstPayId = randomUUID();
    cycleFirstPayId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Online Coverage Window Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 5_000_000,
      }),
    );

    await seedMemberWithContact(memberRenewalId, 'Online Renewal Coverage Co');
    await seedMemberWithContact(memberFirstPayId, 'Online First-Pay Coverage Co');

    // RENEWAL member — a TERMINAL, ANCHORED predecessor (settled history) so the
    // classifier resolves `renewal` (settledCycleCountForMember >= 1), plus the
    // payable open cycle confirm-renewal drives. The bill covers the NEXT period.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId: memberRenewalId,
        status: 'cancelled',
        periodFrom: new Date('2024-06-01T00:00:00Z'),
        periodTo: new Date('2025-06-01T00:00:00Z'),
        expiresAt: new Date('2025-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: new Date('2024-06-01T00:00:00Z'),
        closedAt: new Date('2025-06-01T00:00:00Z'),
        closedReason: 'cancelled',
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: cycleRenewalId,
        memberId: memberRenewalId,
        status: 'awaiting_payment',
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

    // FIRST-PAYMENT member — the member's ONLY-EVER cycle, never anchored
    // (`anchored_at` NULL) + no settled predecessor → classifier `first_payment`.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: cycleFirstPayId,
        memberId: memberFirstPayId,
        status: 'awaiting_payment',
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

  it('a confirm-renewal RENEWAL bill stamps coverage_from/to = [periodTo, periodTo + frozenTerm)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: cycleRenewalId,
      memberId: memberRenewalId,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(`confirmRenewal (renewal) failed: ${JSON.stringify(r.error)}`);
    }

    const cov = await readCoverage(r.value.invoiceId);
    expect(cov.from, 'renewal coverage_from must be stamped').not.toBeNull();
    expect(cov.to, 'renewal coverage_to must be stamped').not.toBeNull();
    expect(cov.from?.toISOString()).toBe(RENEWAL_COVERAGE_FROM);
    expect(cov.to?.toISOString()).toBe(RENEWAL_COVERAGE_TO);
  }, 120_000);

  it('a confirm-renewal FIRST-PAYMENT bill stamps coverage_from/to = [periodFrom, periodTo) — NOT the next period, NOT NULL', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await confirmRenewal(deps, {
      tenantId: tenant.ctx.slug,
      cycleId: cycleFirstPayId,
      memberId: memberFirstPayId,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(
        `confirmRenewal (first-payment) failed: ${JSON.stringify(r.error)}`,
      );
    }

    const cov = await readCoverage(r.value.invoiceId);
    // The L3 fix: CURRENT period, non-null — NOT the next-period window (which
    // would false-refuse this member's first renewal).
    expect(cov.from, 'first-payment coverage_from must be stamped').not.toBeNull();
    expect(cov.to, 'first-payment coverage_to must be stamped').not.toBeNull();
    expect(cov.from?.toISOString()).toBe(FIRST_PAY_COVERAGE_FROM);
    expect(cov.to?.toISOString()).toBe(FIRST_PAY_COVERAGE_TO);
    // Decisively NOT the next-period window the old code stamped.
    expect(cov.from?.toISOString()).not.toBe(RENEWAL_COVERAGE_FROM);
  }, 120_000);
});
