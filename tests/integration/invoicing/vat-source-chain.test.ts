/**
 * T123 integration test — VAT source chain end-to-end pin.
 *
 * Proves that a tenant with `tenant_invoice_settings.vat_rate = '0.0850'`
 * produces an ISSUED invoice with `invoices.vat_rate_snapshot = '0.0850'`.
 * Catches any future refactor that reintroduces `tenant_fee_config` as
 * the VAT source (pre-R9 behaviour) or double-reads from another table.
 *
 * Context: R9 (2026-04) consolidated VAT into `tenant_invoice_settings`
 * as the single authoritative source and DROPPED `tenant_fee_config`.
 * This is a light-weight regression pin — the risk is low (one source
 * table) but the cost of silent drift on VAT would be severe (every
 * invoice wrong, regulator correspondence).
 *
 * Runs on live Neon (real issue flow, mocked PDF/Blob to stay fast).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

const CORPORATE_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

describe('T123 — VAT source chain pin (tenant_invoice_settings → invoice row)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('invoice issued under vat_rate=0.0850 snapshots 0.0850 into invoices.vat_rate_snapshot', async () => {
    const planId = 't123-plan';
    const planYear = 2026;
    const memberId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'T123 VAT Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: CORPORATE_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });

      // The key seed: VAT = 8.50% (NOT the default 7%).
      // Proves the issue path picks this up rather than a hardcoded
      // 0.0700 or a stale tenant_fee_config value.
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0850',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'T123',
        creditNoteNumberPrefix: 'T123C',
      });

      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'VAT Source Co',
        country: 'TH',
        planId,
        planYear,
      });
    });

    // Create draft + issue it with a minimal membership_fee line.
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 1_000_000n,
        totalSatang: 1_000_000n,
        position: 1,
      });
    });

    const deps: IssueInvoiceDeps = {
      invoiceRepo: makeDrizzleInvoiceRepo(tenant.ctx.slug),
      // REAL tenant-settings repo — this is the core of the pin.
      // If a refactor swaps the source to `tenant_fee_config` the
      // `getForIssue` call below would either throw (table dropped)
      // or return stale data.
      tenantSettingsRepo: drizzleTenantSettingsRepo,
      memberIdentity: {
        getForIssue: vi.fn(async (_tx, _t, mid) => ({
          memberId: mid,
          isActive: true,
          isArchived: false,
          memberTypeScope: 'company' as const, // S1-P1-16 (snapshot has tax_id → gate passes)
          registrationFeePaid: true,
          registrationDate: '2026-01-01',
          snapshot: {
            legal_name: 'VAT Source Co',
            tax_id: '1234567890123',
            address: 'Bangkok',
            primary_contact_name: 'n',
            primary_contact_email: 'test@example.com',
            member_number: null,
            member_number_display: null,
          },
        })),
        markRegistrationFeePaid: vi.fn(async () => {}),
      },
      // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
      eventRegistrationLookup: eventRegistrationLookupAdapter,
      sequenceAllocator: postgresSequenceAllocator,
      pdfRender: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
        })),
      },
      blob: {
        uploadPdf: vi.fn(async ({ key }) => ({
          key,
          url: `https://blob.test/${key}`,
        })),
        uploadLogo: vi.fn(),
        signDownloadUrl: vi.fn(),
        downloadBytes: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      },
      audit: f4AuditAdapter,
      clock: { nowIso: () => '2026-04-18T10:00:00Z' },
      outbox: resendEmailOutboxAdapter,
      currentTemplateVersion: 1,
      taxAtPayment: 'off',
    };

    const result = await issueInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `t123-${invoiceId}`,
      invoiceId,
    });
    expect(result.ok).toBe(true);

    // THE pin: the issued invoice's vat_rate_snapshot column contains
    // EXACTLY the value we seeded on tenant_invoice_settings, not a
    // hardcoded 0.0700 or a drifted copy from another table.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ vatRateSnapshot: invoices.vatRateSnapshot, status: invoices.status })
        .from(invoices)
        .where(
          and(
            eq(invoices.invoiceId, invoiceId),
            eq(invoices.tenantId, tenant.ctx.slug),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('issued');
    // 4-dp decimal — the allocator + repo round-trip preserves the raw
    // string. If a refactor converts to number and back we'd see
    // '0.085' or '0.08500' and this assertion would fire.
    expect(rows[0]!.vatRateSnapshot).toBe('0.0850');

    // Sanity: VAT satang should = subtotal × 0.0850 = 100000 × 0.0850 = 8500
    // (1_000_000 satang subtotal * 0.085 = 85_000 satang VAT).
    const full = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ vatSatang: invoices.vatSatang, subtotalSatang: invoices.subtotalSatang })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(full[0]!.subtotalSatang?.toString()).toBe('1000000');
    expect(full[0]!.vatSatang?.toString()).toBe('85000');
  }, 60_000);
});
