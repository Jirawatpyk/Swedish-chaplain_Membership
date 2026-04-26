/**
 * T069 — F4 US3 portal ownership integration test.
 *
 * Constitution v1.4.0 Principle I — tenant isolation is a Review-Gate
 * blocker. This suite covers the **member-portal ownership axis** that
 * `tenant-isolation.test.ts` (table-level RLS) and `audit-coverage.test.ts`
 * (MVP-flow audit enumeration) leave implicit:
 *
 *   1. Member A attempting to read **member B's invoice inside the same
 *      tenant** via `getInvoicePdfSignedUrl` — RLS cannot help here
 *      (both rows are same-tenant) so the ownership guard lives in the
 *      use case. Expect `forbidden` + `invoice_cross_tenant_probe` row
 *      with `actor_role=member` + mismatched `actor_member_id` vs
 *      `invoice_member_id` payload.
 *   2. Member A attempting to read **tenant B's invoice via crafted URL**
 *      — the invoice is invisible under tenant A's RLS so the use case
 *      resolves to `invoice_not_found` + `invoice_cross_tenant_probe`
 *      with `actor_role=member` payload.
 *   3. Member A listing their own invoices via `listInvoicesPaged` with
 *      `memberId=A` — the foreign (B) invoice MUST NOT appear in the
 *      result set, even though both live in tenant A. Proves the
 *      member-scope filter in the shared admin+portal use case is
 *      enforced at the repo layer, not only by RLS.
 *
 * This is authored in the T069 slot which `tasks.md` originally spec'd
 * as RED before implementation. F4 US3 shipped as R7-B3 earlier so the
 * guard is already in place; the suite therefore runs GREEN and locks
 * the contract against future regressions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  getInvoicePdfSignedUrl,
  listInvoicesPaged,
  makeGetInvoicePdfSignedUrlDeps,
  makeListInvoicesDeps,
} from '@/modules/invoicing';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

describe('F4 US3 — portal ownership (T069)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let adminUser: TestUser;

  // Tenant A holds two members (alpha + gamma) to cover the
  // same-tenant-different-member probe — this is the case RLS alone
  // cannot guard because both rows share tenant_id.
  let alphaMemberId: string;
  let gammaMemberId: string;
  let alphaInvoiceId: string;
  let gammaInvoiceId: string;

  // Tenant B holds one member/invoice for the cross-tenant probe case.
  let betaMemberId: string;
  let betaInvoiceId: string;

  // Simulated signed-in user (we only need the user id for audit
  // attribution — actor role + member id are passed explicitly).
  let alphaUserId: string;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    const alphaMemberUser = await createActiveTestUser('member');
    alphaUserId = alphaMemberUser.userId;

    // Seed one plan per tenant.
    for (const [t, prefix] of [[tenantA, 'alpha'], [tenantB, 'beta']] as const) {
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: `${prefix}-plan`,
          planYear: 2026,
          planName: { en: `${prefix} Plan` },
          description: { en: '' },
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
          createdBy: adminUser.userId,
          updatedBy: adminUser.userId,
        });
      });
    }

    // Seed alpha + gamma in tenant A, beta in tenant B.
    alphaMemberId = randomUUID();
    gammaMemberId = randomUUID();
    betaMemberId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values([
        {
          tenantId: tenantA.ctx.slug,
          memberId: alphaMemberId,
          companyName: 'Alpha Co',
          country: 'TH',
          planId: 'alpha-plan',
          planYear: 2026,
        },
        {
          tenantId: tenantA.ctx.slug,
          memberId: gammaMemberId,
          companyName: 'Gamma Co',
          country: 'TH',
          planId: 'alpha-plan',
          planYear: 2026,
        },
      ]);
    });
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: betaMemberId,
        companyName: 'Beta Co',
        country: 'TH',
        planId: 'beta-plan',
        planYear: 2026,
      }),
    );

    // Seed one draft invoice per member. The ownership guard in
    // `get-invoice-pdf-signed-url` runs BEFORE the pdf check, so draft
    // rows are sufficient to exercise the member-probe branch.
    alphaInvoiceId = randomUUID();
    gammaInvoiceId = randomUUID();
    betaInvoiceId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(invoices).values([
        {
          tenantId: tenantA.ctx.slug,
          invoiceId: alphaInvoiceId,
          memberId: alphaMemberId,
          planYear: 2026,
          planId: 'alpha-plan',
          draftByUserId: adminUser.userId,
        },
        {
          tenantId: tenantA.ctx.slug,
          invoiceId: gammaInvoiceId,
          memberId: gammaMemberId,
          planYear: 2026,
          planId: 'alpha-plan',
          draftByUserId: adminUser.userId,
        },
      ]);
    });
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantB.ctx.slug,
        invoiceId: betaInvoiceId,
        memberId: betaMemberId,
        planYear: 2026,
        planId: 'beta-plan',
        draftByUserId: adminUser.userId,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  /**
   * Counts the `invoice_cross_tenant_probe` rows in `audit_log` whose
   * payload `attempted_invoice_id` matches the given UUID. Uses the
   * unscoped `db` (audit rows are appended across tenants) + filters
   * by tenant + event type.
   */
  async function countProbes(params: {
    tenantSlug: string;
    attemptedInvoiceId: string;
    actorUserId: string;
  }): Promise<number> {
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, params.tenantSlug),
          eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
          eq(auditLog.actorUserId, params.actorUserId),
        ),
      );
    return rows.filter((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return p.attempted_invoice_id === params.attemptedInvoiceId;
    }).length;
  }

  // ---------------------------------------------------------------------
  // Case 1 — same tenant, different member (RLS cannot guard)
  // ---------------------------------------------------------------------

  it('alpha member hitting gamma invoice → forbidden + probe audit', async () => {
    const before = await countProbes({
      tenantSlug: tenantA.ctx.slug,
      attemptedInvoiceId: gammaInvoiceId,
      actorUserId: alphaUserId,
    });

    const result = await runInTenant(tenantA.ctx, () =>
      getInvoicePdfSignedUrl(makeGetInvoicePdfSignedUrlDeps(tenantA.ctx.slug), {
        tenantId: tenantA.ctx.slug,
        actorUserId: alphaUserId,
        actorRole: 'member',
        actorMemberId: alphaMemberId,
        invoiceId: gammaInvoiceId,
        requestId: 'portal-ownership-case1',
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
    }

    const after = await countProbes({
      tenantSlug: tenantA.ctx.slug,
      attemptedInvoiceId: gammaInvoiceId,
      actorUserId: alphaUserId,
    });
    expect(after - before).toBe(1);
  });

  it('alpha member payload names both member ids for forensic traceability', async () => {
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
          eq(auditLog.actorUserId, alphaUserId),
        ),
      );
    const probe = rows.find((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return p.attempted_invoice_id === gammaInvoiceId;
    });
    expect(probe, 'probe row must exist after Case 1').toBeTruthy();
    const p = (probe!.payload ?? {}) as Record<string, unknown>;
    expect(p.actor_role).toBe('member');
    expect(p.actor_member_id).toBe(alphaMemberId);
    expect(p.invoice_member_id).toBe(gammaMemberId);
  });

  // ---------------------------------------------------------------------
  // Case 2 — cross-tenant probe (RLS hides the row entirely)
  // ---------------------------------------------------------------------

  it('alpha member hitting tenant-B invoice id → not_found + probe audit', async () => {
    const before = await countProbes({
      tenantSlug: tenantA.ctx.slug,
      attemptedInvoiceId: betaInvoiceId,
      actorUserId: alphaUserId,
    });

    const result = await runInTenant(tenantA.ctx, () =>
      getInvoicePdfSignedUrl(makeGetInvoicePdfSignedUrlDeps(tenantA.ctx.slug), {
        tenantId: tenantA.ctx.slug,
        actorUserId: alphaUserId,
        actorRole: 'member',
        actorMemberId: alphaMemberId,
        invoiceId: betaInvoiceId,
        requestId: 'portal-ownership-case2',
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invoice_not_found');
    }

    const after = await countProbes({
      tenantSlug: tenantA.ctx.slug,
      attemptedInvoiceId: betaInvoiceId,
      actorUserId: alphaUserId,
    });
    expect(after - before).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Case 3 — member-scope filter on listInvoicesPaged
  // ---------------------------------------------------------------------

  it('listInvoicesPaged(memberId=alpha) excludes gamma invoice (same tenant)', async () => {
    const result = await runInTenant(tenantA.ctx, () =>
      listInvoicesPaged(makeListInvoicesDeps(tenantA.ctx.slug), {
        tenantId: tenantA.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: true,
        memberId: alphaMemberId,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).toContain(alphaInvoiceId);
    expect(
      ids,
      'member-scope filter must never leak a sibling member inside the same tenant',
    ).not.toContain(gammaInvoiceId);
  });

  it('listInvoicesPaged(memberId=alpha) under tenant A cannot see tenant-B invoice', async () => {
    const result = await runInTenant(tenantA.ctx, () =>
      listInvoicesPaged(makeListInvoicesDeps(tenantA.ctx.slug), {
        tenantId: tenantA.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: true,
        memberId: alphaMemberId,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.rows.map((r) => r.invoiceId);
    expect(ids).not.toContain(betaInvoiceId);
  });

  // ---------------------------------------------------------------------
  // D1 (verify-run remediation) — AS1 deterministic seed assertion.
  // The E2E spec asserts the *render path* doesn't 5xx for a member,
  // but cannot deterministically claim "3 rows" without a seed harness.
  // This integration case provides the strict AS1 contract: seed N
  // issued invoices for one member and assert the use case returns
  // exactly N rows with the fields surfaced on the portal page
  // (status / issueDate / dueDate / total / documentNumber).
  // ---------------------------------------------------------------------

  it('AS1 — seed 3 issued invoices, listInvoicesPaged returns exactly 3 with portal fields', async () => {
    // Use a fresh member to keep the seeded count exact (alphaMemberId
    // already has a draft from the suite setup; we want a clean slate).
    const deltaMemberId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: deltaMemberId,
        companyName: 'Delta Co',
        country: 'TH',
        planId: 'alpha-plan',
        planYear: 2026,
      }),
    );

    // Three issued invoices: 2 paid, 1 open — mirrors the AS1 wording
    // "3 issued invoices (2 paid, 1 open)".
    const seeded: { id: string; status: 'paid' | 'issued'; doc: string; total: bigint }[] = [
      { id: randomUUID(), status: 'paid',   doc: 'D-2026-000001', total: 1_070_000n },
      { id: randomUUID(), status: 'paid',   doc: 'D-2026-000002', total: 2_140_000n },
      { id: randomUUID(), status: 'issued', doc: 'D-2026-000003', total: 535_000n },
    ];
    // Non-draft rows must satisfy the `invoices_non_draft_has_snapshots`
    // CHECK constraint (migration 0024 H5) — tenant + member identity
    // snapshots, vat snapshot, totals, pro-rate, net-days, and PDF
    // metadata all NOT NULL. Use placeholder PDF identifiers since this
    // suite never streams the blob.
    const tenantSnap = { legal_name_en: 'Alpha', legal_name_th: 'อัลฟา', tax_id: '0000000000000', address: 'BKK' };
    const memberSnap = {
      legal_name: 'Delta Co',
      tax_id: null,
      address: 'Bangkok',
      primary_contact_name: 'Delta Contact',
      primary_contact_email: 'test@example.com',
    };
    await runInTenant(tenantA.ctx, async (tx) => {
      for (const [idx, row] of seeded.entries()) {
        const subtotal = (row.total * 100n) / 107n;
        const vat = row.total - subtotal;
        await tx.insert(invoices).values({
          tenantId: tenantA.ctx.slug,
          invoiceId: row.id,
          memberId: deltaMemberId,
          planYear: 2026,
          planId: 'alpha-plan',
          draftByUserId: adminUser.userId,
          status: row.status,
          fiscalYear: 2026,
          sequenceNumber: idx + 1,
          documentNumber: row.doc,
          issueDate: '2026-04-15',
          dueDate: '2026-05-15',
          paidAt: row.status === 'paid' ? new Date('2026-04-18T00:00:00Z') : null,
          paymentMethod: row.status === 'paid' ? 'bank_transfer' : null,
          subtotalSatang: subtotal,
          vatRateSnapshot: '0.0700',
          vatSatang: vat,
          totalSatang: row.total,
          proRatePolicySnapshot: 'none',
          netDaysSnapshot: 30,
          tenantIdentitySnapshot: tenantSnap,
          memberIdentitySnapshot: memberSnap,
          pdfBlobKey: `tenants/${tenantA.ctx.slug}/invoices/${row.id}/v1.pdf`,
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        });
      }
    });

    const result = await runInTenant(tenantA.ctx, () =>
      listInvoicesPaged(makeListInvoicesDeps(tenantA.ctx.slug), {
        tenantId: tenantA.ctx.slug,
        offset: 0,
        pageSize: 50,
        includeDrafts: false, // members never see drafts (R7-B3)
        memberId: deltaMemberId,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
    expect(result.value.rows).toHaveLength(3);

    // Spot-check the fields the portal `/portal/invoices` page binds:
    // documentNumber, status, issueDate, dueDate, total. (PDF column
    // is null because we didn't render — the page treats null as "—",
    // which is the expected behaviour for issued-without-blob fixtures.)
    const docs = result.value.rows.map((r) => r.documentNumber?.raw).sort();
    expect(docs).toEqual(['D-2026-000001', 'D-2026-000002', 'D-2026-000003']);
    const statuses = result.value.rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['issued', 'paid', 'paid']);
    const totals = result.value.rows
      .map((r) => r.total?.satang ?? 0n)
      .sort((a, b) => Number(a - b));
    expect(totals).toEqual([535_000n, 1_070_000n, 2_140_000n]);
    for (const row of result.value.rows) {
      expect(row.issueDate).toBe('2026-04-15');
      expect(row.dueDate).toBe('2026-05-15');
    }
  });

  // ---------------------------------------------------------------------
  // SC-003 / CP-5.2 (Best Practice closure) — Source-of-truth invariant
  // at the integration layer. Two consecutive `getInvoicePdfSignedUrl`
  // calls on the SAME issued invoice MUST resolve to the SAME blob key
  // and the SAME filename — proves admin + portal + future call-sites
  // download the byte-identical Blob object every time, with no covert
  // re-render path. Pairs with the C1 unit test (admin + member roles
  // resolve to same key) by adding the DB-backed dimension.
  //
  // The signed URL itself is allowed to differ run-over-run (signature
  // tokens are short-lived + signing is non-deterministic by design);
  // what matters is the underlying blob key + filename are stable.
  // ---------------------------------------------------------------------

  it('SC-003 source-of-truth — two getInvoicePdfSignedUrl calls return same blob key', async () => {
    // Reuse the AS1 seed pattern but bind a pdfBlobKey so the use case
    // reaches the Blob-signing branch rather than returning forbidden.
    const echoMemberId = randomUUID();
    const echoInvoiceId = randomUUID();
    const echoBlobKey = `tenants/${tenantA.ctx.slug}/invoices/${echoInvoiceId}/v1.pdf`;
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: echoMemberId,
        companyName: 'Echo Co',
        country: 'TH',
        planId: 'alpha-plan',
        planYear: 2026,
      });
      const total = 1_070_000n;
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: echoInvoiceId,
        memberId: echoMemberId,
        planYear: 2026,
        planId: 'alpha-plan',
        draftByUserId: adminUser.userId,
        status: 'paid',
        fiscalYear: 2026,
        sequenceNumber: 99,
        documentNumber: 'E-2026-000099',
        issueDate: '2026-04-15',
        dueDate: '2026-05-15',
        paidAt: new Date('2026-04-18T00:00:00Z'),
        paymentMethod: 'bank_transfer',
        subtotalSatang: 1_000_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 70_000n,
        totalSatang: total,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legal_name_en: 'Alpha', legal_name_th: 'อัลฟา', tax_id: '0', address: 'BKK' },
        memberIdentitySnapshot: {
          legal_name: 'Echo Co',
          tax_id: null,
          address: 'Bangkok',
          primary_contact_name: 'Echo Contact',
          primary_contact_email: 'test@example.com',
        },
        pdfBlobKey: echoBlobKey,
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });

    // Stub the Blob signing so the test never hits the real Vercel Blob
    // network surface — we only assert the KEY + filename, which are
    // the source-of-truth identifiers.
    const calls: string[] = [];
    const stubBlob = {
      signDownloadUrl: async (key: string, ttl?: number) => {
        calls.push(key);
        return `https://blob.example/${key}?t=${ttl ?? 60}&sig=stub`;
      },
    } as unknown as Parameters<
      typeof getInvoicePdfSignedUrl
    >[0]['blob'];

    const baseDeps = makeGetInvoicePdfSignedUrlDeps(tenantA.ctx.slug);
    const deps = { ...baseDeps, blob: stubBlob };

    const r1 = await runInTenant(tenantA.ctx, () =>
      getInvoicePdfSignedUrl(deps, {
        tenantId: tenantA.ctx.slug,
        actorUserId: adminUser.userId,
        actorRole: 'admin',
        invoiceId: echoInvoiceId,
        requestId: 'sot-1',
      }),
    );
    const r2 = await runInTenant(tenantA.ctx, () =>
      getInvoicePdfSignedUrl(deps, {
        tenantId: tenantA.ctx.slug,
        actorUserId: adminUser.userId,
        actorRole: 'admin',
        invoiceId: echoInvoiceId,
        requestId: 'sot-2',
      }),
    );

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Source-of-truth: both calls signed the IDENTICAL blob key. Vercel
    // Blob is content-addressable so identical key → identical bytes
    // when streamed → SC-003 satisfied user-visibly.
    expect(calls).toEqual([echoBlobKey, echoBlobKey]);

    // Filename is derived from documentNumber + persisted at issue time
    // → also identical across calls. This is the Content-Disposition
    // value the user's browser shows, and must not flap.
    if (r1.ok && r2.ok) {
      expect(r2.value.filename).toBe(r1.value.filename);
    }
  });
});
