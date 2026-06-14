/**
 * 068-f8-completion (code-review fix / cluster A) — offline mark-paid
 * §86/4 frozen-price billing. Live Neon Singapore via .env.local.
 *
 * THE BUG: `markPaidOffline` issues a FRESH §86/4 via the F4 bridge
 * (`f4InvoiceBridge.issueAndMarkPaid` → `createInvoiceDraft`). The
 * online confirm-renewal path (Slice 1.5) threads the cycle's FROZEN
 * price into `renewalSignal`, but the OFFLINE path — the bank-transfer-
 * dominant common path for SweCham/TSCC — did NOT. So the offline §86/4
 * billed the LIVE F2 catalogue price (wrong amount on a tax document) AND
 * re-billed the one-off `registration_fee`.
 *
 * THE FIX: thread `cycle.frozenPlanPriceThb` from `mark-paid-offline.ts`
 * into the bridge, which converts it to VAT-exclusive satang via the
 * shared `parseThbDecimalToSatang` and passes
 * `renewalSignal: { unitPriceSatang }` to `createInvoiceDraft` — mirroring
 * the online `f4-invoicing-for-renewal-bridge-drizzle.ts`.
 *
 * Test seam: drives the REAL `markPaidOffline` end-to-end (NO bridge
 * mock — the bridge IS the unit under test) with the F4 PDF render + Blob
 * upload + email outbox mocked at module level (mirrors
 * `invoicing-bridge-atomicity.test.ts`). Asserts on the persisted issued
 * §86/4 invoice lines:
 *   1. membership line subtotal == frozen × 100 (VAT-exclusive), NOT the
 *      bumped live price.
 *   2. NO `registration_fee` line (suppressed on the renewal path) even
 *      though the member has `registrationFeePaid=false` + a non-zero
 *      tenant registration fee configured.
 *
 * Frozen price carries a NON-ZERO satang remainder ('50000.50') so a
 * `parseFloat`-style drift would surface.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// Stub render/blob/outbox so the bridge's internal makeIssueInvoiceDeps +
// makeRecordPaymentDeps pick up mocked PDF/Blob (same pattern as
// invoicing-bridge-atomicity.test.ts) — the system under test is the
// offline bridge composition + the frozen-price renewalSignal threading,
// not the PDF/email round-trip.
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
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { markPaidOffline, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// '50000.50' THB → 5_000_050 satang. NON-ZERO satang remainder.
const FROZEN_PRICE_THB = '50000.50';
const FROZEN_SUBTOTAL_SATANG = 5_000_050n;
// Tenant registration fee — non-zero so the renewal-suppression assertion
// has a real line to NOT see.
const REGISTRATION_FEE_SATANG = 200_000n; // 2,000.00 THB

describe('F8 offline mark-paid frozen-price §86/4 billing (cluster A)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;
  let cycleId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({
      tenant,
      vatRate: '0.0700',
      registrationFeeSatang: REGISTRATION_FEE_SATANG,
    });

    planId = `f8-offfrozen-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Offline Frozen Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        // Live catalogue STARTS at the frozen value; BUMPED below.
        annualFeeMinorUnits: 5_000_050,
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Offline Frozen Co',
        country: 'TH',
        planId,
        planYear: 2026,
        // registrationFeePaid=false → WITHOUT the renewal-suppression fix a
        // registration_fee line would be re-billed on this renewal §86/4.
        registrationFeePaid: false,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Offline',
        lastName: 'Frozen',
        email: 'offline-frozen@example.com',
        isPrimary: true,
      });
    });

    // Cycle frozen at 50,000.50 THB, payable. periodFrom in 2026 so the
    // §87 fiscal-year bucket is 2026 (matches the member plan_year above).
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );

    // Tenant BUMPS the F2 catalogue price mid-cycle. Billing the LIVE
    // price would now charge 85,000.00 — the offline §86/4 must bill the
    // frozen 50,000.50 instead.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ annualFeeMinorUnits: 8_500_000 })
        .where(eq(membershipPlans.planId, planId)),
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

  it('offline §86/4 bills the cycle FROZEN price (not the bumped live price) + suppresses the reg-fee re-bill (FR-022)', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const r = await markPaidOffline(deps, {
      tenantId: tenant.ctx.slug,
      cycleId,
      paymentMethod: 'bank_transfer',
      paymentReference: 'BT-OFFFROZEN-0001',
      paymentDate: '2026-06-05',
      actorUserId: user.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    if (!r.ok) {
      throw new Error(`markPaidOffline failed: ${JSON.stringify(r.error)}`);
    }
    expect(r.value.cycleStatus).toBe('completed');

    // Read back the issued §86/4 invoice lines.
    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          kind: invoiceLines.kind,
          totalSatang: invoiceLines.totalSatang,
          proRateFactor: invoiceLines.proRateFactor,
        })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, tenant.ctx.slug),
            eq(invoiceLines.invoiceId, r.value.invoiceId),
          ),
        ),
    );

    // (1) Membership line == FROZEN × 100 EXACTLY, VAT-exclusive — NOT the
    // bumped 8_500_000 live price.
    const membershipLine = lineRows.find((l) => l.kind === 'membership_fee');
    expect(membershipLine).toBeDefined();
    expect(BigInt(membershipLine!.totalSatang)).toBe(FROZEN_SUBTOTAL_SATANG);
    // Full cycle on the renewal path.
    expect(membershipLine!.proRateFactor).toBe('1.0000');

    // (2) NO registration_fee line on the renewal path (suppressed) even
    // though registrationFeePaid=false + the tenant has a non-zero reg fee.
    expect(lineRows.some((l) => l.kind === 'registration_fee')).toBe(false);

    // The issued invoice grand-total subtotal equals the frozen membership
    // subtotal (no extra reg-fee added).
    const inv = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ subtotalSatang: invoices.subtotalSatang })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.invoiceId, r.value.invoiceId),
          ),
        )
        .limit(1),
    );
    expect(BigInt(inv[0]!.subtotalSatang as unknown as string)).toBe(
      FROZEN_SUBTOTAL_SATANG,
    );
  }, 120_000);
});
