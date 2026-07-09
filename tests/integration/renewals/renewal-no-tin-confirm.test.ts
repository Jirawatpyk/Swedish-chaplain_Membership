/**
 * 066 verification — a NO-TIN member completes the F8 portal self-service
 * renewal END-TO-END against live Neon: `confirmRenewal` → the REAL F4
 * invoicing bridge (`createInvoiceDraft` + `issueInvoice`, NOT stubbed) →
 * issues a valid §86/4 ใบกำกับภาษี (name+address, no TIN line) + returns a
 * pay URL.
 *
 * Before the 066 relax this exact path returned `invoice_creation_failed`
 * (issueInvoice → `tax_id_required`) → the confirm route answered HTTP 502,
 * so the 46/131 no-TIN members could NOT self-renew. This test is the
 * regression net proving the portal renewal now works for them.
 *
 * Distinct from renewal-confirm-perf.test.ts, which STUBS the F4 bridge (it
 * measures F8-only latency and never exercises real issuance).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { confirmRenewal, makeRenewalsDeps } from '@/modules/renewals';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const MATRIX: BenefitMatrix = {
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('066 — no-TIN member self-service renewal issues a §86/4 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'no-tin-renewal-plan';

  // 070 G — the cycle's `period_from` is wall-clock-relative (now − 30d) and
  // `confirmRenewal` derives `plan_year = deriveFiscalYear(period_from)`
  // server-side. Seed the catalogue `membership_plans.plan_year` (+ the
  // member's plan binding) from the SAME clock + SAME derivation so the seed
  // and the server-derived year always agree — otherwise, once the calendar
  // crosses into the next fiscal year, the hard-coded 2026 would no longer
  // match the derived year and `getAnnualFeeSatang` would miss the row
  // (cross-year-boundary flake). Computed ONCE here so `beforeAll` (plan seed)
  // and the `it` body (member + cycle seed) share one fiscal year.
  const seedNow = Date.now();
  const periodFrom = new Date(seedNow - 30 * MS_PER_DAY);
  const seededPlanYear = deriveFiscalYear(periodFrom.toISOString());

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        // 070 G — derived from period_from (see describe-scope note), NOT a
        // hard-coded 2026, so this stays valid across a year boundary.
        planYear: seededPlanYear,
        planName: { en: 'No-TIN Renewal Plan' },
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
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'RNTN',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('no-TIN company member confirms renewal → §86/4 issued + payUrl (was invoice_creation_failed pre-066)', async () => {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    // Reuse the describe-scope clock so the cycle's period_from matches the
    // value `seededPlanYear` was derived from (see describe-scope note).
    const now = seedNow;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'No-TIN Renewal Co',
        country: 'TH',
        // The whole point — this member has NO tax_id. Pre-066 the renewal
        // confirm 502'd here; post-066 it issues a §86/4 name+address.
        taxId: null,
        // S7 — seed the FULL structured §86/4 buyer address (not the weakest
        // country-only block). `composeBuyerAddress` folds these into the
        // snapshot's multi-line `address`; the assertion below proves the full
        // street/locality survives onto the issued tax document (the §86/4
        // full-address requirement, not just a bare country code).
        addressLine1: '88 Wireless Road',
        addressLine2: 'Lumpini Tower 9F',
        city: 'Pathum Wan',
        province: 'Bangkok',
        postalCode: '10330',
        planId,
        // 070 G — member plan binding uses the same derived year as the
        // catalogue row (members_plan_tenant_year_fk → membership_plans).
        planYear: seededPlanYear,
        status: 'active',
      });
      // Primary contact — the real memberIdentityAdapter reads it to build the
      // buyer snapshot (name + email) at issue time.
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Renew',
        lastName: 'Member',
        email: `renew-${memberId.slice(0, 8)}@notin.example`,
        isPrimary: true,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        // Same instance `seededPlanYear` was derived from — guarantees the
        // server-derived plan_year equals the seeded catalogue plan_year.
        periodFrom,
        periodTo: new Date(now + 30 * MS_PER_DAY),
        expiresAt: new Date(now + 30 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        // Real seeded plan — the bridge invoices this planId.
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '10000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });

    const r = await confirmRenewal(makeRenewalsDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      // 070 — `planYear` is server-derived from the cycle (period_from →
      // deriveFiscalYear). The seeded membership_plans row uses the SAME
      // derivation (seededPlanYear) so they always agree, regardless of the
      // wall-clock date the suite runs on.
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: randomUUID(),
    });

    expect(
      r.ok,
      r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`,
    ).toBe(true);
    if (!r.ok) return;

    // The portal redirects the member to this URL to pay online (F5).
    expect(r.value.payUrl).toBeTruthy();
    expect(r.value.invoiceNumber).toBeTruthy();
    expect(r.value.planChanged).toBe(false);

    // The linked invoice is a real ISSUED §86/4 — no buyer TIN required.
    const [inv] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          memberId: invoices.memberId,
          documentNumber: invoices.documentNumber,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
          // The document-kind discriminator + the frozen buyer block are what
          // make this a §86/4 full tax invoice (not a §105 receipt or an empty
          // buyer block) — without these the regression net would still PASS if
          // the no-TIN path silently degraded.
          pdfDocKind: invoices.pdfDocKind,
          memberIdentitySnapshot: invoices.memberIdentitySnapshot,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, r.value.invoiceId)),
    );
    expect(inv?.status).toBe('issued');
    expect(inv?.memberId).toBe(memberId);
    // 088 tax-flow redesign (FEATURE_088_TAX_AT_PAYMENT, on in this env,
    // shipped PR #149 — pre-existing on `main`, unrelated to the rolling-
    // anchor Tasks 6/7 on this branch) — the NEW bill-at-issue flow mints
    // the §87 §86/4 `documentNumber` at PAYMENT, not at issue; the printed
    // pre-payment identity is the non-§87 `billDocumentNumberRaw` (ใบแจ้งหนี้
    // bill number), which is what `confirmRenewal`'s returned
    // `invoiceNumber` surfaces (`billFirstDocumentNumber`). This test
    // predates 088 and asserted the legacy documentNumber-at-issue shape;
    // updated to the shipped 088 behaviour.
    expect(inv?.documentNumber).toBeNull();
    expect(inv?.billDocumentNumberRaw).not.toBeNull();
    expect(inv?.billDocumentNumberRaw).toBe(r.value.invoiceNumber);

    // §86/4 — a membership tax invoice (ใบกำกับภาษี), NOT a §105 receipt. If
    // the no-TIN path regressed to 'receipt_separate'/'receipt_combined' this
    // pins the failure.
    expect(inv?.pdfDocKind).toBe('invoice');

    // The frozen BUYER snapshot is a genuine §86/4 block: real legal name +
    // full street address, with the TIN line ABSENT (tax_id null). An empty
    // buyer block or a re-introduced TIN requirement would fail here.
    const snap = inv?.memberIdentitySnapshot as Record<string, unknown>;
    expect(snap).not.toBeNull();
    // No buyer TIN — the whole point of the 066 relax (§86/4 name+address only).
    expect(snap.tax_id).toBeNull();
    // The seeded legal name survives onto the snapshot (not blanked).
    expect(snap.legal_name).toBe('No-TIN Renewal Co');
    // S7 — the FULL structured address (not a bare country code) survives:
    // `composeBuyerAddress` folds the seeded street + locality into the
    // multi-line block and suppresses the redundant domestic "TH" line.
    expect(snap.address).toBe(
      '88 Wireless Road\nLumpini Tower 9F\nPathum Wan Bangkok 10330',
    );
  }, 60_000);
});
