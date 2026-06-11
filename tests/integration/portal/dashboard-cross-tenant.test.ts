/**
 * 057 portal redesign §4.1 — Dashboard cross-tenant isolation (live Neon).
 *
 * Principle I Review-Gate blocker: every member-facing read backing the
 * Dashboard (renewal status, outstanding invoices, benefit usage) must be
 * tenant-scoped. We seed a member + cycle in tenant A and assert tenant B's
 * deps — querying the SAME memberId — see NOTHING. The dashboard resolves the
 * member from the session, so a leak here would surface another tenant's data
 * on the landing page.
 *
 * All seed data is SIMULATED (random UUIDs + fake company names) — never real
 * SweCham PII.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asSatang } from '@/lib/money';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { loadMemberRenewalStatus, makeRenewalsDeps } from '@/modules/renewals';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { computeBenefitUsage, makeComputeBenefitUsageDeps } from '@/modules/insights';
// D1 review finding E3(a) — drive the ACTUAL Dashboard read wrappers (not just
// the underlying use-cases) so the cross-tenant guard covers the real read path.
import {
  loadDashboardRenewalCycle,
  loadDashboardOutstanding,
  loadDashboardBenefitUsage,
} from '@/app/(member)/portal/_components/dashboard-reads';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const DAY_MS = 86_400_000;

describe('057 dashboard reads — cross-tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let seedUser: TestUser;

  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `dash-${randomUUID().slice(0, 8)}`;
  const invoiceId = randomUUID();
  // E3(b) — invoice positive control. THB 1,070.00 issued invoice for the
  // tenant-A member (overdue: due 30 days ago) so the outstanding read has a
  // non-empty positive arm in tenant A and a 0-row arm in tenant B.
  const INVOICE_TOTAL_SATANG = 107_000n;

  beforeAll(async () => {
    seedUser = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed the plan first — members.plan_id has FK to membership_plans.
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Dash Test Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: seedUser.userId,
      }),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co ${memberId.slice(0, 4)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      }),
    );

    const now = Date.now();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(now - 30 * DAY_MS),
        periodTo: new Date(now + 20 * DAY_MS),
        expiresAt: new Date(now + 20 * DAY_MS),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(now - 5 * DAY_MS),
      }),
    );

    // E3(b) — seed one ISSUED membership invoice for the tenant-A member. All
    // `invoices_non_draft_has_snapshots` CHECK fields are populated (the
    // immutability trigger is BEFORE UPDATE only, so a direct issued INSERT is
    // fine). issue/due dates are display-only YYYY-MM-DD; storage stays UTC.
    const dueYmd = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        invoiceSubject: 'membership',
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: seedUser.userId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        // DocumentNumber.parse expects PREFIX-FYYY-NNNNNN (the repo throws on a
        // malformed value). Per-tenant unique, so a fixed value is fine.
        documentNumber: 'INV-2026-000001',
        issueDate: new Date(now - 60 * DAY_MS).toISOString().slice(0, 10),
        dueDate: dueYmd,
        currency: 'THB',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: INVOICE_TOTAL_SATANG,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { name: 'Sim Tenant A', taxId: '0000000000000' },
        // Must satisfy BOTH the non-draft `invoices_snapshot_has_contact_email`
        // CHECK (migration 0045) AND the row→Domain `memberIdentitySnapshotSchema`
        // parse (the repo throws MalformedSnapshotError otherwise). Field names
        // are snake_case per the schema. SIMULATED data only — never real PII.
        memberIdentitySnapshot: {
          legal_name: 'Sim Buyer Co., Ltd.',
          tax_id: '1111111111111',
          address: '1 Simulated Rd, Bangkok 10110',
          primary_contact_name: 'Sim Buyer',
          primary_contact_email: 'sim.buyer@example.com',
        },
        pdfBlobKey: `sim/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenantA.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 100_000n,
        totalSatang: asSatang(100_000n),
        position: 1,
      });
    });
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db.delete(invoiceLines).where(eq(invoiceLines.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(invoices).where(eq(invoices.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)).catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('tenant A sees its own renewal cycle', async () => {
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      memberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle?.cycleId).toBe(cycleId);
  });

  it('tenant B cannot see tenant A renewal cycle for the same memberId', async () => {
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenantB.ctx.slug), {
      tenantId: tenantB.ctx.slug,
      memberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle).toBeNull();
  });

  it('tenant B cannot see tenant A invoices for the same memberId', async () => {
    const res = await listInvoicesPaged(makeListInvoicesDeps(tenantB.ctx.slug), {
      tenantId: tenantB.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId,
      status: 'issued',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows).toHaveLength(0);
  });

  it('tenant A sees benefit usage for its own member (positive control)', async () => {
    // The member is seeded in tenant A with a plan that has eblast_per_year=1.
    // computeBenefitUsage returns ok=true with a valid BenefitUsage — the
    // member + plan exist in tenant A's RLS scope.
    const res = await computeBenefitUsage(
      tenantA.ctx,
      { memberId },
      makeComputeBenefitUsageDeps(tenantA.ctx.slug),
    );
    expect(res.ok).toBe(true);
  });

  it('tenant B cannot see tenant A benefit usage for the same memberId', async () => {
    // The memberId belongs to tenant A. When computeBenefitUsage runs under
    // tenant B's RLS context, memberPlanSource.findPlanIdentity returns null
    // (the member row is not visible to tenant B) → use-case returns
    // err({ code: 'member_not_found' }) — no data leak.
    const res = await computeBenefitUsage(
      tenantB.ctx,
      { memberId },
      makeComputeBenefitUsageDeps(tenantB.ctx.slug),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('member_not_found');
  });

  // -------------------------------------------------------------------------
  // E3(a) — drive the ACTUAL Dashboard read WRAPPERS (loadDashboard*), not just
  // the underlying use-cases, so the cross-tenant guard covers the real read
  // path the page renders. E3(b) — invoice positive control on the outstanding
  // wrapper so the arm is not vacuous.
  // -------------------------------------------------------------------------

  it('renewal wrapper: tenant A sees its cycle; tenant B sees null', async () => {
    const a = await loadDashboardRenewalCycle(tenantA.ctx.slug, memberId);
    expect(a).not.toBe('error');
    expect(a === 'error' ? null : a?.cycleId).toBe(cycleId);

    const b = await loadDashboardRenewalCycle(tenantB.ctx.slug, memberId);
    // tenant B has no cycle for this memberId → null (NOT another tenant's row,
    // NOT the 'error' sentinel).
    expect(b).toBeNull();
  });

  it('outstanding wrapper: tenant A sees the seeded invoice; tenant B sees 0 (E3b)', async () => {
    const a = await loadDashboardOutstanding(tenantA.ctx.slug, memberId);
    expect(a.error).toBe(false);
    expect(a.total).toBe(1);
    expect(a.inputs).toHaveLength(1);
    expect(a.inputs[0]?.status).toBe('issued');
    expect(a.inputs[0]?.totalSatang).toBe(INVOICE_TOTAL_SATANG);

    const b = await loadDashboardOutstanding(tenantB.ctx.slug, memberId);
    expect(b.error).toBe(false);
    expect(b.total).toBe(0);
    expect(b.inputs).toHaveLength(0);
  });

  it('benefit wrapper: tenant A resolves a VO; tenant B resolves null (benign no-plan)', async () => {
    const a = await loadDashboardBenefitUsage(tenantA.ctx, memberId);
    // tenant A: a real BenefitUsage VO (never the 'error' sentinel here).
    expect(a).not.toBe('error');
    expect(a).not.toBeNull();

    const b = await loadDashboardBenefitUsage(tenantB.ctx, memberId);
    // tenant B: the member is invisible → computeBenefitUsage member_not_found
    // → the wrapper maps it to null (benign empty), NOT another tenant's data
    // and NOT the 'error' sentinel (D1 review finding C).
    expect(b).toBeNull();
  });
});
