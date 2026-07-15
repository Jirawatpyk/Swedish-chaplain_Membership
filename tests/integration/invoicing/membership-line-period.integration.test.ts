/**
 * 064 — the §86/4 membership line prints the member's ACTUAL period + the tenant
 * brand, end-to-end against live Neon.
 *
 * The composer builds `{brand} {plan} Membership Fee {year} ({month range})` and
 * STORES it verbatim on the invoice line; this proves the whole path against real
 * data: `getForIssue` reads `brand_name` from `tenant_invoice_settings`, the real
 * `getPlanName` supplies the plan label, and a non-1st-of-month coverage window
 * (the imported-member reality — column G is rarely the 1st) renders as exactly
 * the term of month-labels. Companion to the unit coverage in
 * create-invoice-draft.test.ts; this is the live-Neon guard the pure tests can't
 * give (settings read + persisted line text).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  createInvoiceDraft,
  type CreateInvoiceDraftInput,
} from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { makeCreateInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('064 §86/4 membership line — real period + brand (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: '0.0700' });

    // 064 — set the tenant brand name so the line prints the "SweCham" prefix.
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(tenantInvoiceSettings)
        .set({ brandName: 'SweCham' })
        .where(eq(tenantInvoiceSettings.tenantId, tenant.ctx.slug)),
    );

    planId = `f4-line-period-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Regular Corporate', th: 'สมาชิกองค์กรทั่วไป' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 1_600_000,
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Line Period Co',
        country: 'TH',
        planId,
        planYear: 2026,
        registrationFeePaid: true,
        // Registered in a prior FY → proRate forced to 1.0000 (no pro-rate suffix).
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Line',
        lastName: 'Period',
        email: `line-period-${randomUUID().slice(0, 8)}@example.com`,
        isPrimary: true,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('first-payment window on a NON-1st-of-month start → brand + plan + fee year + month range, stored verbatim', async () => {
    const draftInput: CreateInvoiceDraftInput = {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `line-period-${memberId}`,
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
      // The member's CURRENT period from their open cycle (column G rarely the
      // 1st). toIso is the exclusive next-period start.
      membershipCoverage: { kind: 'window', fromIso: '2026-06-30', toIso: '2027-06-30' },
    };
    const draftResult = await createInvoiceDraft(
      makeCreateInvoiceDraftDeps(tenant.ctx.slug),
      draftInput,
    );
    if (!draftResult.ok) {
      throw new Error(`draft failed: ${JSON.stringify(draftResult.error)}`);
    }

    // Read the PERSISTED membership line back from Neon (stored verbatim).
    const lineRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          kind: invoiceLines.kind,
          descriptionEn: invoiceLines.descriptionEn,
          descriptionTh: invoiceLines.descriptionTh,
        })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, tenant.ctx.slug),
            eq(invoiceLines.invoiceId, draftResult.value.invoiceId),
          ),
        ),
    );
    const line = lineRows.find((l) => l.kind === 'membership_fee');
    expect(line).toBeDefined();
    // Year = window START year (2026), brand from settings, plan from getPlanName,
    // [2026-06-30, 2027-06-30) → "June 2026 - May 2027".
    expect(line!.descriptionEn).toBe(
      'SweCham Regular Corporate Membership Fee 2026 (June 2026 - May 2027)',
    );
    expect(line!.descriptionTh).toBe(
      'ค่าสมาชิก SweCham สมาชิกองค์กรทั่วไป ปี 2569 (มิถุนายน 2569 - พฤษภาคม 2570)',
    );
  }, 120_000);
});
