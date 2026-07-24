/**
 * SAFE-PIN (no logic change) — rolling-anchor `plan_year` vs printed-coverage
 * axis on an ANCHORED renewal. Live Neon DEV via .env.local (NEVER prod).
 *
 * Drives the REAL F4 invoicing bridge end-to-end (`confirmRenewal` →
 * `createInvoiceDraft` + `issueMembershipBill`, NOT stubbed), mirroring the
 * harness of `renewal-no-tin-confirm.test.ts`.
 *
 * WHAT THIS PINS (intentional, harmless behaviour — see the WHY comment at
 * `confirm-renewal.ts` around the `deriveFiscalYear(periodFrom)` planYear
 * derivation):
 *
 *   When an ANCHORED member renews, the classifier returns `renewal`, so the
 *   §86/4 prints the NEXT term's coverage window (`periodTo → periodTo + term`)
 *   while `invoices.plan_year` is keyed to `deriveFiscalYear(periodFrom)` = the
 *   CURRENT term year. That one-period LAG between plan_year and the printed
 *   coverage is REAL but HARMLESS and DELIBERATE:
 *     - the printed §86/4 face is self-consistent (`feeYearCe` = the coverage
 *       window's start year; plan_year never reaches the PDF renderer);
 *     - §87 sequential numbering rides `invoices.fiscal_year` (derived from the
 *       ISSUE date), a THIRD independent axis — never plan_year;
 *     - keying plan_year to periodFrom is ALSO what keeps the renewal ISSUABLE:
 *       `getAnnualFeeSatang(planId, nextYear)` is null (no next-year catalogue
 *       row is cloned yet), so a naive "fix" using `deriveFiscalYear(periodTo)`
 *       would throw `plan_not_found` and BLOCK the first anchored renewal.
 *
 * This test SEEDS the exact anchored-renewal shape (current-year catalogue row
 * only, NO next-year row) and ASSERTS the five safe invariants (a)-(e) below.
 * It is the regression net for the `periodTo` "fix": (a) proves issuance still
 * succeeds precisely because plan_year stays on the current year.
 *
 * DO NOT "fix" the plan_year derivation to `deriveFiscalYear(periodTo)` — this
 * test (a) is the guard that would go red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { confirmRenewal, makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Anchor the scenario to the run's OWN fiscal year so the pin never flakes
// across a calendar boundary. `CURRENT_YEAR` is the FY the invoice is ISSUED
// in (Jan-start tenant → Bangkok calendar year of `now`). The cycle's CURRENT
// term = CURRENT_YEAR; the NEXT term the §86/4 covers = NEXT_YEAR.
const CURRENT_YEAR = deriveFiscalYear(new Date().toISOString());
const NEXT_YEAR = CURRENT_YEAR + 1;

// Catalogue price DELIBERATELY differs from the frozen cycle price so invariant
// (e) — "billed the FROZEN price, not a catalogue lookup" — is a real contract,
// not a coincidence. Catalogue = 50,000.00; the cycle froze 10,000.00.
const CATALOGUE_FEE_MINOR = 5_000_000; // 50,000.00 THB (VAT-exclusive)
const FROZEN_PRICE_THB = '10000.00';
const FROZEN_SUBTOTAL_SATANG = 1_000_000n; // 10,000.00 VAT-exclusive
const FROZEN_VAT_SATANG = 70_000n; //  7% of 10,000.00
const FROZEN_TOTAL_SATANG = 1_070_000n; // subtotal + VAT

// Jan 5 avoids the Asia/Bangkok (+7h) month/year boundary: 00:00Z → 07:00
// Bangkok, same calendar day — so `deriveFiscalYear(periodFrom)` is stable.
const PERIOD_FROM = new Date(Date.UTC(CURRENT_YEAR, 0, 5));
const PERIOD_TO = new Date(Date.UTC(NEXT_YEAR, 0, 5));

describe('confirm-renewal anchored plan_year pin — rolling-anchor axis (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'anchored-plan-year-pin';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      // CURRENT-year catalogue row ONLY. NO next-year (NEXT_YEAR) row —
      // this is the crux: the naive `deriveFiscalYear(periodTo)` fix would
      // look up NEXT_YEAR and miss, throwing plan_not_found.
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: CURRENT_YEAR,
        planName: { en: 'Anchored Plan-Year Pin Plan' },
        description: { en: 'Anchored rolling-anchor pin plan' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: CATALOGUE_FEE_MINOR,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: {
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
        },
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
        legalNameEn: 'Test Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'APYP',
        creditNoteNumberPrefix: 'CN',
        // fiscal_year_start_month defaults to 1 (January) → fiscal_year ==
        // Bangkok calendar year of the issue date.
      });
    });
  }, 180_000);

  afterAll(async () => {
    // renewal_cycles FK-reference invoices (anchor + linked) with RESTRICT/
    // NO-ACTION semantics, so tenant.cleanup()'s invoices-before-cycles order
    // would RESTRICT-throw and leak. Clear cycles first, then cleanup the rest.
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  /**
   * A PAID membership invoice — the cycle's `anchor_invoice_id` target.
   * `renewal_cycles_anchor_invoice_fk` requires a REAL invoices row; the paid
   * shape satisfies `invoices_paid_has_receipt_status` + the paid⇒paid_at/
   * payment_method CHECKs. Seeded directly (not via recordPayment) — same
   * precedent as `rolling-anchor-payment.test.ts`'s `seedPaidInvoice`.
   */
  async function seedAnchorPaidInvoice(memberId: string): Promise<string> {
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: CURRENT_YEAR,
        planId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        draftByUserId: user.userId,
        fiscalYear: CURRENT_YEAR,
        sequenceNumber: 900_001,
        documentNumber: `APYP-${CURRENT_YEAR}-900001`,
        issueDate: `${CURRENT_YEAR}-01-06`,
        dueDate: `${CURRENT_YEAR}-02-05`,
        currency: 'THB',
        subtotalSatang: FROZEN_SUBTOTAL_SATANG,
        vatRateSnapshot: '0.0700',
        vatSatang: FROZEN_VAT_SATANG,
        totalSatang: FROZEN_TOTAL_SATANG,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Anchored Pin Co',
          country: 'TH',
          legal_name: 'Anchored Pin Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Anchor Contact',
          primary_contact_email: 'anchor@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/${CURRENT_YEAR}/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'ANCHOR-PAY',
        paymentRecordedByUserId: user.userId,
        paymentDate: `${CURRENT_YEAR}-01-06`,
        paidAt: new Date(Date.UTC(CURRENT_YEAR, 0, 6, 9)),
      }),
    );
    return invoiceId;
  }

  it('anchored renewal issues with plan_year on the CURRENT term while the §86/4 prints the NEXT term (no plan_not_found)', async () => {
    const memberId = randomUUID();
    const cycleId = randomUUID();

    // Sanity: the crux precondition — NO next-year catalogue row exists, so a
    // `deriveFiscalYear(periodTo)`-based planYear would miss getAnnualFeeSatang
    // and confirmRenewal would fail with plan_not_found. This is exactly what
    // invariant (a) below guards against.
    const nextYearRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: membershipPlans.planId })
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.tenantId, tenant.ctx.slug),
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, NEXT_YEAR),
          ),
        ),
    );
    expect(
      nextYearRows,
      'precondition: NO next-year catalogue row — proves the periodTo "fix" would plan_not_found',
    ).toHaveLength(0);

    // Member + contact FIRST — the anchor invoice + cycle both FK-reference
    // the member (invoices_member_fk / renewal_cycles_member_fk).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Anchored Pin Co',
        country: 'TH',
        taxId: '0105556000000',
        addressLine1: '88 Wireless Road',
        city: 'Pathum Wan',
        province: 'Bangkok',
        postalCode: '10330',
        planId,
        planYear: CURRENT_YEAR,
        status: 'active',
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Anchor',
        lastName: 'Member',
        email: `anchor-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
    });

    const anchorInvoiceId = await seedAnchorPaidInvoice(memberId);

    await runInTenant(tenant.ctx, async (tx) => {
      // THE ANCHORED RENEWAL CYCLE — status 'upcoming', linked_invoice_id NULL,
      // anchored_at SET (→ classifier returns `renewal`), anchor_invoice_id →
      // the PAID invoice above, frozen price differing from the catalogue.
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
        expiresAt: PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: FROZEN_PRICE_THB,
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        anchoredAt: PERIOD_FROM,
        anchorInvoiceId,
        linkedInvoiceId: null,
      });
    });

    const r = await confirmRenewal(makeRenewalsDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      actorUserId: user.userId,
      actorRole: 'member',
      correlationId: randomUUID(),
    });

    // (a) — ISSUES with NO plan_not_found. The guard against the dangerous
    // `deriveFiscalYear(periodTo)` fix: plan_year stays on the CURRENT term
    // (CURRENT_YEAR), whose catalogue row exists, so issuance succeeds.
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(!r.ok && r.error)}`).toBe(true);
    if (!r.ok) return;
    expect(r.value.planChanged).toBe(false);
    expect(r.value.invoiceNumber).toBeTruthy();

    const [inv] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          planYear: invoices.planYear,
          fiscalYear: invoices.fiscalYear,
          issueDate: invoices.issueDate,
          documentNumber: invoices.documentNumber,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
          subtotalSatang: invoices.subtotalSatang,
          vatSatang: invoices.vatSatang,
          totalSatang: invoices.totalSatang,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, r.value.invoiceId)),
    );
    expect(inv?.status).toBe('issued');

    // (b) — the PRINTED membership-coverage label / feeYearCe = the NEXT year.
    // feeYearCe is baked into the membership line's description text (it never
    // reaches a column). The line prints "Membership Fee <NEXT_YEAR>" + the
    // NEXT-term window, and NEVER the current year.
    const [line] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          kind: invoiceLines.kind,
          descriptionEn: invoiceLines.descriptionEn,
          unitPriceSatang: invoiceLines.unitPriceSatang,
          totalSatang: invoiceLines.totalSatang,
        })
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, tenant.ctx.slug),
            eq(invoiceLines.invoiceId, r.value.invoiceId),
            eq(invoiceLines.kind, 'membership_fee'),
          ),
        ),
    );
    expect(line, 'membership_fee line must exist').toBeDefined();
    expect(line!.descriptionEn).toContain(`Membership Fee ${NEXT_YEAR}`);
    expect(line!.descriptionEn).toContain(`January ${NEXT_YEAR}`);
    expect(line!.descriptionEn).not.toContain(`Membership Fee ${CURRENT_YEAR}`);

    // (c) — the issued §86/4 number + fiscal_year bucket to the ISSUE-date
    // fiscal year, NOT plan_year. `fiscal_year` == the Bangkok calendar year of
    // `issue_date` (Jan-start tenant); the printed number embeds that same FY
    // (`{prefix}-{FY}-{seq}`). Under FEATURE_088_TAX_AT_PAYMENT the §87 §86/4
    // number is minted at PAYMENT, so at issue `document_number` is NULL and
    // the printed identity is the non-§87 bill number.
    // An ISSUED invoice always carries an issue date (column is nullable only
    // for drafts) — assert + narrow for the strict null check.
    expect(inv!.issueDate).not.toBeNull();
    const issueFy = Number(inv!.issueDate!.slice(0, 4));
    expect(inv!.fiscalYear).toBe(issueFy);
    expect(r.value.invoiceNumber).toContain(`-${inv!.fiscalYear}-`);
    expect(inv!.documentNumber).toBeNull();
    expect(inv!.billDocumentNumberRaw).toBe(r.value.invoiceNumber);

    // (d) — invoices.plan_year = the CURRENT term year; the composite FK
    // (tenant_id, plan_id, plan_year) resolved (the row inserted OK, proven by
    // status 'issued' above + the read here).
    expect(inv!.planYear).toBe(CURRENT_YEAR);

    // (e) — the billed total equals the FROZEN price, NOT the catalogue lookup.
    // Catalogue is 50,000.00; the cycle froze 10,000.00 — the line + totals
    // reflect the frozen amount.
    expect(line!.unitPriceSatang).toBe(FROZEN_SUBTOTAL_SATANG);
    expect(line!.totalSatang).toBe(FROZEN_SUBTOTAL_SATANG);
    expect(inv!.subtotalSatang).toBe(FROZEN_SUBTOTAL_SATANG);
    expect(inv!.vatSatang).toBe(FROZEN_VAT_SATANG);
    expect(inv!.totalSatang).toBe(FROZEN_TOTAL_SATANG);
    // And decisively NOT the catalogue price (would be 5,000,000 satang).
    expect(inv!.subtotalSatang).not.toBe(asSatang(BigInt(CATALOGUE_FEE_MINOR)));
  }, 120_000);
});
