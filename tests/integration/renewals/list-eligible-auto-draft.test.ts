/**
 * 107-auto-invoice Task 6 — `listCyclesEligibleForAutoDraft` repo-method
 * integration test (live Neon).
 *
 * The daily auto-draft cron (Task 7) calls this to find cycles it should
 * pre-fill a DRAFT membership invoice for, ahead of the member's due
 * date. Verifies the full eligibility predicate on real Postgres + RLS:
 *
 *   (a) enrolled + rolling billing_cycle + expires within
 *       `leadDaysRolling` → INCLUDED.
 *   (b) enrolled but with a LIVE `issued` OR `draft` membership invoice
 *       → EXCLUDED (dedup) — both branches of the `status IN
 *       ('draft','issued')` predicate exercised.
 *   (c) enrolled with ONLY a `paid` membership invoice on file (the
 *       member's prior, already-settled cycle) → STILL INCLUDED. This is
 *       the crux case: an `upcoming` cycle exists BECAUSE the prior
 *       cycle was paid, so every real candidate has a `paid` invoice —
 *       the dedup NOT EXISTS must not match on `paid`, or the cron would
 *       never fire for anyone.
 *   (d) NOT enrolled (`auto_invoice_enrolled_at IS NULL`) → EXCLUDED.
 *   (e) enrolled + calendar billing_cycle + expires OUTSIDE
 *       `leadDaysCalendar` → EXCLUDED at the base `nowIso`, then
 *       INCLUDED once `nowIso` advances into the window (same cycle,
 *       two queries).
 *   (f) status filter — a cycle in a non-eligible status
 *       (`awaiting_payment`) → EXCLUDED even though otherwise eligible.
 *   (g) lower bound — a cycle whose `expires_at` is already in the past
 *       relative to `nowIso` (already at/past T-0) → EXCLUDED (that cron
 *       is `listCyclesEligibleForAwaitingPayment`'s job, not this one's).
 *   (h) GDPR/PDPA-ERASED member (`erased_at` set), still enrolled and
 *       otherwise perfectly eligible → EXCLUDED. Task 15 review
 *       (Important). NOT covered by (d) or by the archived gate: the F3
 *       erasure scrub deliberately leaves `status`/`archived_at` untouched
 *       ("erasure is orthogonal to archive"), and although the scrub now
 *       NULLs `auto_invoice_enrolled_at`, that is one-shot — a later bulk
 *       enrol can re-stamp an erased row. This fixture reproduces exactly
 *       that state (erased AND re-enrolled) so the repo predicate is what
 *       is under test, not the scrub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('107-auto-invoice Task 6 — listCyclesEligibleForAutoDraft (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  const NOW_ISO = '2026-08-01T00:00:00.000Z';
  const LEAD_DAYS_ROLLING = 30;
  const LEAD_DAYS_CALENDAR = 31;
  const dayMs = 24 * 60 * 60 * 1000;
  const addDays = (iso: string, days: number): Date =>
    new Date(new Date(iso).getTime() + days * dayMs);

  // --- Member ids (one member per scenario) ---------------------------------
  const mIncluded = randomUUID(); // (a) rolling, within window → included
  const mDedupIssued = randomUUID(); // (b1) rolling, live `issued` invoice → excluded
  const mDedupDraft = randomUUID(); // (b2) rolling, live `draft` invoice → excluded
  const mPaidOnly = randomUUID(); // (c) rolling, only a `paid` invoice → still included
  const mNotEnrolled = randomUUID(); // (d) not enrolled → excluded
  const mCalendar = randomUUID(); // (e) calendar, outside window → excluded, then included
  const mWrongStatus = randomUUID(); // (f) cycle status not eligible → excluded
  const mAlreadyPast = randomUUID(); // (g) already past T-0 → excluded
  const mErased = randomUUID(); // (h) erased member, still enrolled → excluded

  // --- Cycle ids --------------------------------------------------------------
  const cIncluded = randomUUID();
  const cDedupIssued = randomUUID();
  const cDedupDraft = randomUUID();
  const cPaidOnly = randomUUID();
  const cNotEnrolled = randomUUID();
  const cCalendar = randomUUID();
  const cWrongStatus = randomUUID();
  const cAlreadyPast = randomUUID();
  const cErased = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = `f8-autodraft-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Auto-Draft Eligibility Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    const memberSpecs: ReadonlyArray<{
      memberId: string;
      enrolled: boolean;
      billingCycle: 'rolling' | 'calendar';
    }> = [
      { memberId: mIncluded, enrolled: true, billingCycle: 'rolling' },
      { memberId: mDedupIssued, enrolled: true, billingCycle: 'rolling' },
      { memberId: mDedupDraft, enrolled: true, billingCycle: 'rolling' },
      { memberId: mPaidOnly, enrolled: true, billingCycle: 'rolling' },
      { memberId: mNotEnrolled, enrolled: false, billingCycle: 'rolling' },
      { memberId: mCalendar, enrolled: true, billingCycle: 'calendar' },
      { memberId: mWrongStatus, enrolled: true, billingCycle: 'rolling' },
      { memberId: mAlreadyPast, enrolled: true, billingCycle: 'rolling' },
      { memberId: mErased, enrolled: true, billingCycle: 'rolling' },
    ];

    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values(
        memberSpecs.map((m) => ({
          tenantId: tenant.ctx.slug,
          memberId: m.memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Auto-Draft Co ${m.memberId.slice(0, 6)}`,
          country: 'TH' as const,
          planId,
          planYear: 2026,
          billingCycle: m.billingCycle,
          autoInvoiceEnrolledAt: m.enrolled ? new Date('2026-01-01T00:00:00Z') : null,
        })),
      ),
    );

    const seedCycle = (
      cycleId: string,
      memberId: string,
      status: 'upcoming' | 'awaiting_payment',
      expiresAt: Date,
    ) =>
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId,
          memberId,
          status,
          periodFrom: new Date('2025-08-01T00:00:00Z'),
          periodTo: expiresAt,
          expiresAt,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: 'regular',
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        }),
      );

    await seedCycle(cIncluded, mIncluded, 'upcoming', addDays(NOW_ISO, 18));
    await seedCycle(cDedupIssued, mDedupIssued, 'upcoming', addDays(NOW_ISO, 18));
    await seedCycle(cDedupDraft, mDedupDraft, 'upcoming', addDays(NOW_ISO, 18));
    await seedCycle(cPaidOnly, mPaidOnly, 'upcoming', addDays(NOW_ISO, 18));
    await seedCycle(cNotEnrolled, mNotEnrolled, 'upcoming', addDays(NOW_ISO, 18));
    await seedCycle(cCalendar, mCalendar, 'upcoming', addDays(NOW_ISO, 35));
    await seedCycle(cWrongStatus, mWrongStatus, 'awaiting_payment', addDays(NOW_ISO, 18));
    await seedCycle(cAlreadyPast, mAlreadyPast, 'upcoming', addDays(NOW_ISO, -1));
    // (h) identical to the (a) happy path — same status, same lead window —
    // so the ONLY thing that can exclude it is the `erased_at IS NULL` gate.
    await seedCycle(cErased, mErased, 'upcoming', addDays(NOW_ISO, 18));
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(members)
        .set({ erasedAt: new Date('2026-07-01T00:00:00Z') })
        .where(
          and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, mErased)),
        ),
    );

    // --- Invoices — minimal fields per status (see schema-invoices.ts CHECKs) --
    const draftLike = (
      invoiceId: string,
      memberId: string,
      status: 'draft' | 'issued',
    ) => ({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      status,
      draftByUserId: user.userId,
      ...(status === 'issued'
        ? {
            pdfDocKind: 'invoice' as const,
            fiscalYear: 2026,
            sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
            documentNumber: `INV-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`,
            issueDate: '2026-08-01',
            dueDate: '2026-08-31',
            currency: 'THB' as const,
            subtotalSatang: asSatang(5_000_000n),
            vatRateSnapshot: '0.0700',
            vatSatang: asSatang(350_000n),
            totalSatang: asSatang(5_350_000n),
            proRatePolicySnapshot: 'none',
            netDaysSnapshot: 30,
            tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
            memberIdentitySnapshot: {
              companyName: 'Auto-Draft Dedup Co',
              country: 'TH',
              legal_name: 'Auto-Draft Dedup Co Ltd',
              address: '1 Test Road, Bangkok 10110',
              primary_contact_name: 'Test Contact',
              primary_contact_email: 'autodraft-dedup@example.com',
            } as unknown,
            pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
            pdfSha256: 'a'.repeat(64),
            pdfTemplateVersion: 1,
          }
        : {}),
    });

    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values(draftLike(randomUUID(), mDedupIssued, 'issued')),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values(draftLike(randomUUID(), mDedupDraft, 'draft')),
    );

    // (c) mPaidOnly — a PAID prior-cycle membership invoice, the crux
    // case: must NOT be caught by the dedup NOT EXISTS. `planYear` stays
    // 2026 (matching the one seeded plan row — `invoices_plan_fk` is a
    // composite FK to `membership_plans(tenant_id, plan_id, plan_year)`);
    // this test only cares that a PAID row exists for the member, not
    // that it carries a different plan_year than the cycle.
    const paidInvoiceId = randomUUID();
    const paidAt = new Date('2025-08-05T00:00:00Z');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: paidInvoiceId,
        memberId: mPaidOnly,
        planYear: 2026,
        planId,
        status: 'paid',
        pdfDocKind: 'invoice',
        receiptPdfStatus: 'rendered',
        draftByUserId: user.userId,
        fiscalYear: 2025,
        sequenceNumber: Math.floor(Math.random() * 1_000_000) + 1,
        documentNumber: `INV-2025-${String(Math.floor(Math.random() * 900000) + 100000)}`,
        issueDate: '2025-08-01',
        dueDate: '2025-08-31',
        currency: 'THB',
        subtotalSatang: asSatang(5_000_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(350_000n),
        totalSatang: asSatang(5_350_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Auto-Draft Paid-Only Co',
          country: 'TH',
          legal_name: 'Auto-Draft Paid-Only Co Ltd',
          address: '1 Test Road, Bangkok 10110',
          primary_contact_name: 'Test Contact',
          primary_contact_email: 'autodraft-paidonly@example.com',
        } as unknown,
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2025/${paidInvoiceId}.pdf`,
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
        paymentMethod: 'bank_transfer',
        paymentReference: 'AUTODRAFT-PAIDONLY',
        paymentRecordedByUserId: user.userId,
        paymentDate: paidAt.toISOString().slice(0, 10),
        paidAt,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('applies the full eligibility predicate at the base nowIso', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const page = await deps.cyclesRepo.listCyclesEligibleForAutoDraft(tenant.ctx.slug, {
      nowIso: NOW_ISO,
      leadDaysRolling: LEAD_DAYS_ROLLING,
      leadDaysCalendar: LEAD_DAYS_CALENDAR,
      pageSize: 100,
    });

    const returnedIds = page.cycles.map((c) => c.cycleId);

    // (a) + (c) included.
    expect(returnedIds).toContain(cIncluded);
    expect(returnedIds).toContain(cPaidOnly);

    // (b1)/(b2) dedup — both draft and issued exclude.
    expect(returnedIds).not.toContain(cDedupIssued);
    expect(returnedIds).not.toContain(cDedupDraft);

    // (d) not enrolled.
    expect(returnedIds).not.toContain(cNotEnrolled);

    // (e) calendar cycle outside its 31-day lead window at the base nowIso.
    expect(returnedIds).not.toContain(cCalendar);

    // (f) non-eligible status.
    expect(returnedIds).not.toContain(cWrongStatus);

    // (g) already past T-0 (lower bound `expires_at > nowIso`).
    expect(returnedIds).not.toContain(cAlreadyPast);

    // (h) erased member — enrolled, active, in-window, correct status, no
    // live invoice. Excluded ONLY by `m.erased_at IS NULL`.
    expect(returnedIds).not.toContain(cErased);

    // Exactly the two positive cases from this tenant's fixture set.
    const ourIds = new Set<string>([
      cIncluded,
      cDedupIssued,
      cDedupDraft,
      cPaidOnly,
      cNotEnrolled,
      cCalendar,
      cWrongStatus,
      cAlreadyPast,
      cErased,
    ]);
    const ourReturned = returnedIds.filter((id) => ourIds.has(id));
    expect(ourReturned.sort()).toEqual([cIncluded, cPaidOnly].sort());

    expect(page.nextCursor).toBeNull();
  });

  it('includes the calendar cycle once nowIso advances into its lead window', async () => {
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const advancedNowIso = addDays(NOW_ISO, 5).toISOString();

    const page = await deps.cyclesRepo.listCyclesEligibleForAutoDraft(tenant.ctx.slug, {
      nowIso: advancedNowIso,
      leadDaysRolling: LEAD_DAYS_ROLLING,
      leadDaysCalendar: LEAD_DAYS_CALENDAR,
      pageSize: 100,
    });

    const returnedIds = page.cycles.map((c) => c.cycleId);

    // 35 - 5 = 30 days <= leadDaysCalendar(31) → now in-window.
    expect(returnedIds).toContain(cCalendar);
    // Still-eligible cases remain included; dedup/not-enrolled/status/
    // past-T-0 cases remain excluded at the advanced clock too.
    expect(returnedIds).toContain(cIncluded);
    expect(returnedIds).toContain(cPaidOnly);
    expect(returnedIds).not.toContain(cDedupIssued);
    expect(returnedIds).not.toContain(cDedupDraft);
    expect(returnedIds).not.toContain(cNotEnrolled);
    expect(returnedIds).not.toContain(cWrongStatus);
    expect(returnedIds).not.toContain(cAlreadyPast);
    expect(returnedIds).not.toContain(cErased);

    expect(page.nextCursor).toBeNull();
  });
});
