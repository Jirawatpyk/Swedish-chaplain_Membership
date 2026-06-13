/**
 * F8-completion Slice 1 · Task 1.5 — renewal reg-fee suppression +
 * pro-rate=1.0000. Live Neon Singapore via .env.local.
 *
 * FR-022: a renewal §86/4 bills ONLY the frozen membership price. Two
 * invariants beyond the price itself:
 *
 *   (a) The one-off `registration_fee` re-bill line is SUPPRESSED on
 *       the renewal path — even when the member's `registration_fee_paid
 *       = false` AND the tenant has a non-zero `registration_fee_satang`
 *       configured (the exact predicate that would add the line on a
 *       fresh membership draft). The entry fee belongs to onboarding,
 *       never a renewal cycle.
 *
 *   (b) `proRateFactor == '1.0000'` — a renewal of an existing member is
 *       always a FULL cycle; the derivation that would pro-rate a
 *       mid-FY join is skipped.
 *
 * Contrast control: the SAME member + settings WITHOUT the renewal
 * signal DOES add the reg-fee line — proving the suppression is the
 * renewal signal's effect, not a mis-seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
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

const FROZEN_SATANG = 5_000_050n; // '50000.50' VAT-exclusive
const REG_FEE_SATANG = 200_000n; // 2,000.00 THB one-off entry fee

describe('F8 renewal reg-fee suppression + pro-rate (Task 1.5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;

  async function readLines(invoiceId: string) {
    return runInTenant(tenant.ctx, (tx) =>
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
            eq(invoiceLines.invoiceId, invoiceId),
          ),
        ),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    // Non-zero registration fee so the reg-fee predicate is armed.
    await seedTenantFiscal({
      tenant,
      vatRate: '0.0700',
      registrationFeeSatang: REG_FEE_SATANG,
    });

    planId = `f8-regfee-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Reg-Fee Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: 5_000_050,
      }),
    );

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Reg-Fee Co',
        country: 'TH',
        planId,
        planYear: 2026,
        // The exact predicate that adds the reg-fee line on a fresh draft.
        registrationFeePaid: false,
        // Joined DURING the current FY → the non-renewal path would
        // pro-rate; the renewal path must still force 1.0000.
        registrationDate: '2026-03-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Reg',
        lastName: 'Fee',
        email: 'reg-fee@example.com',
        isPrimary: true,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('renewal signal: NO registration_fee line AND proRateFactor == 1.0000', async () => {
    const input: CreateInvoiceDraftInput = {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `regfee-renewal-${memberId}`,
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
      renewalSignal: { unitPriceSatang: FROZEN_SATANG },
    };
    const result = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), input);
    if (!result.ok) throw new Error(`draft failed: ${JSON.stringify(result.error)}`);

    const lines = await readLines(result.value.invoiceId);
    const membership = lines.find((l) => l.kind === 'membership_fee');
    expect(membership).toBeDefined();
    expect(BigInt(membership!.totalSatang)).toBe(FROZEN_SATANG);
    // (b) full cycle — pro-rate forced to 1.0000.
    expect(membership!.proRateFactor).toBe('1.0000');
    // (a) reg-fee line suppressed despite registrationFeePaid=false + non-zero fee.
    expect(lines.some((l) => l.kind === 'registration_fee')).toBe(false);
    expect(lines).toHaveLength(1);
  }, 120_000);

  it('CONTROL — same member WITHOUT the renewal signal DOES add the reg-fee line (proves the suppression is the signal)', async () => {
    const input: CreateInvoiceDraftInput = {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `regfee-fresh-${memberId}`,
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
      // No renewalSignal — classic fresh-membership draft path.
    };
    const result = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), input);
    if (!result.ok) throw new Error(`draft failed: ${JSON.stringify(result.error)}`);

    const lines = await readLines(result.value.invoiceId);
    expect(lines.some((l) => l.kind === 'membership_fee')).toBe(true);
    // The reg-fee line IS present on the non-renewal path (predicate armed).
    const regFee = lines.find((l) => l.kind === 'registration_fee');
    expect(regFee).toBeDefined();
    expect(BigInt(regFee!.totalSatang)).toBe(REG_FEE_SATANG);
  }, 120_000);
});
