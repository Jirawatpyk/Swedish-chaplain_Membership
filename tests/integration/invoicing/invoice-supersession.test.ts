/**
 * 121-void-supersede-links — `getInvoiceSupersession` on real Postgres.
 *
 * The supersede-void written by `issueMembershipBill` (106-void-on-reissue)
 * stamps `superseded_by_invoice_id` on the `invoice_voided` audit payload.
 * This file proves the READ side resolves it in both directions (AS1/AS2),
 * stays silent for a manual void (AS3), never crosses tenants (AS4 —
 * Constitution I.3, Review-Gate blocker) and never hands a member a link to
 * another member's invoice (AS5 — portal exposure).
 *
 * Harness = `issue-membership-bill.test.ts`: the OLD bill is direct-inserted
 * with a controlled `created_at`; the NEW bill goes through the real
 * `createInvoiceDraft` → `issueMembershipBill` composition. The flag is
 * switched on with the same `vi.hoisted` env mutation, and the deps come from
 * the production `makeIssueMembershipBillDeps` factory, so the supersede-void
 * under test is the one prod runs. `taxAtPayment: 'on'` is forced (as there)
 * so the new bill is new-flow-shaped (SC bill number).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';

vi.hoisted(() => {
  process.env.FEATURE_VOID_ON_REISSUE = 'true';
});
afterAll(() => {
  delete process.env.FEATURE_VOID_ON_REISSUE;
});
vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', async () => {
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
});
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
      key,
      url: `https://blob.test/${key}`,
    })),
    uploadLogo: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
    signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => [] as string[]),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter', () => ({
  resendEmailOutboxAdapter: { enqueue: vi.fn(async () => {}) },
}));

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeIssueMembershipBillDeps,
  makeVoidInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueMembershipBill } from '@/modules/invoicing/application/use-cases/issue-membership-bill';
import { voidInvoice } from '@/modules/invoicing/application/use-cases/void-invoice';
import {
  getInvoiceSupersession,
  makeGetInvoiceSupersessionDeps,
} from '@/modules/invoicing';

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

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Supersession Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

const PLAN_ID = 'supersession-plan';

async function seedPlan(tenant: TestTenant, user: TestUser): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Supersession Plan' },
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
  });
}

async function seedMember(tenant: TestTenant): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Supersession Test Co',
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
    });
  });
  return memberId;
}

/** Direct-insert an issued (or already-void) new-flow membership bill. */
async function seedBill(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
  opts: { billNumber: string; status: 'issued' | 'void'; createdAt: Date },
): Promise<string> {
  const invoiceId = randomUUID();
  const isVoid = opts.status === 'void';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId: PLAN_ID,
      draftByUserId: user.userId,
      status: opts.status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: null,
      documentNumber: null,
      billDocumentNumberRaw: opts.billNumber,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: true,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      voidReason: isVoid ? 'seeded void' : null,
      voidedByUserId: isVoid ? user.userId : null,
      voidedAt: isVoid ? new Date('2026-01-20T00:00:00Z') : null,
      createdAt: opts.createdAt,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: 100_000n,
      totalSatang: 100_000n,
      position: 1,
    });
  });
  return invoiceId;
}

/**
 * Write an `invoice_voided` row by hand — the shape `voidInvoice` emits, used
 * only where the test needs a link the product can't produce on its own
 * (a forged foreign id, a cross-member anomaly).
 */
async function forgeVoidedAudit(
  tenant: TestTenant,
  user: TestUser,
  payload: { invoice_id: string; superseded_by_invoice_id: string; member_id: string },
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(auditLog).values({
      eventType: 'invoice_voided',
      actorUserId: user.userId,
      summary: 'forged supersede link (test)',
      requestId: `forge-${randomUUID()}`,
      payload,
      tenantId: tenant.ctx.slug,
    });
  });
}

/** Draft + issue a NEW membership bill through the production composition. */
async function issueReplacement(tenant: TestTenant, user: TestUser, memberId: string) {
  const prodDeps = makeIssueMembershipBillDeps(tenant.ctx.slug);
  // The flag must reach the factory through `env` — this is what prod reads.
  expect(prodDeps.voidOnReissueEnabled).toBe(true);
  const deps = {
    ...prodDeps,
    issueDeps: { ...makeIssueInvoiceDeps(tenant.ctx.slug), taxAtPayment: 'on' as const },
  };
  const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
    tenantId: tenant.ctx.slug,
    actorUserId: user.userId,
    requestId: `supersession-draft-${randomUUID()}`,
    memberId,
    planId: PLAN_ID,
    planYear: 2026,
    autoEmailOnIssue: false,
  });
  if (!draft.ok) throw new Error(`createInvoiceDraft failed: ${draft.error.code}`);
  const issued = await issueMembershipBill(deps, {
    tenantId: tenant.ctx.slug,
    actorUserId: user.userId,
    requestId: `supersession-issue-${randomUUID()}`,
    invoiceId: draft.value.invoiceId,
  });
  if (!issued.ok) throw new Error(`issueMembershipBill failed: ${issued.error.code}`);
  expect(issued.value.supersedeWarnings).toEqual([]);
  return issued.value;
}

async function statusOf(tenant: TestTenant, invoiceId: string): Promise<string | undefined> {
  const [row] = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId))),
  );
  return row?.status;
}

function resolve(
  tenant: TestTenant,
  invoice: { invoiceId: string; status: 'issued' | 'void' | 'paid'; memberId: string | null },
  restrictToMemberId?: string,
) {
  return getInvoiceSupersession(makeGetInvoiceSupersessionDeps(), {
    tenantId: tenant.ctx.slug,
    invoice,
    ...(restrictToMemberId !== undefined ? { restrictToMemberId } : {}),
  });
}

describe('getInvoiceSupersession — supersede links on real Postgres (121)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  // Fixture built once: tenant A, member M1, old bill OLD superseded by NEW.
  let memberA1: string;
  let oldBillId: string;
  let newBill: { invoiceId: string; billDocumentNumberRaw: string | null; issueDate: string | null };

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-chamber');
    tenantB = await createTestTenant('test-chamber');
    await seedTenantFiscal({ tenant: tenantA, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
    await seedTenantFiscal({ tenant: tenantB, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
    await seedPlan(tenantA, user);
    await seedPlan(tenantB, user);

    memberA1 = await seedMember(tenantA);
    oldBillId = await seedBill(tenantA, user, memberA1, {
      billNumber: 'SC-2026-910001',
      status: 'issued',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const issued = await issueReplacement(tenantA, user, memberA1);
    newBill = {
      invoiceId: issued.invoiceId,
      billDocumentNumberRaw: issued.billDocumentNumberRaw,
      issueDate: issued.issueDate,
    };
    expect(await statusOf(tenantA, oldBillId)).toBe('void');
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('AS1 — resolves the replacement of a supersede-voided bill', async () => {
    const result = await resolve(tenantA, { invoiceId: oldBillId, status: 'void', memberId: memberA1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(newBill.billDocumentNumberRaw).toMatch(/^SC-/);
    expect(result.value.replacedBy).toEqual({
      invoiceId: newBill.invoiceId,
      displayNumber: newBill.billDocumentNumberRaw,
      issueDate: newBill.issueDate,
      status: 'issued',
    });
    expect(result.value.replaces).toEqual([]);
  });

  it('AS2 — resolves the bill(s) a replacement superseded', async () => {
    const result = await resolve(tenantA, {
      invoiceId: newBill.invoiceId,
      status: 'issued',
      memberId: memberA1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replacedBy).toBeNull();
    expect(result.value.replaces).toEqual([
      { invoiceId: oldBillId, displayNumber: 'SC-2026-910001', issueDate: '2026-01-15', status: 'void' },
    ]);
  });

  it('AS3 — a manual void (no superseded_by_invoice_id) has no link in either direction', async () => {
    const memberId = await seedMember(tenantA);
    const billId = await seedBill(tenantA, user, memberId, {
      billNumber: 'SC-2026-910002',
      status: 'issued',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    const voided = await voidInvoice(makeVoidInvoiceDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      actorUserId: user.userId,
      actorRole: 'admin',
      requestId: `manual-void-${randomUUID()}`,
      invoiceId: billId,
      voidReason: 'duplicate — manual void',
    });
    expect(voided.ok).toBe(true);

    const result = await resolve(tenantA, { invoiceId: billId, status: 'void', memberId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ replacedBy: null, replaces: [] });
  });

  it('a chain A→B→C reports B as void, so the reader follows B to the live bill', async () => {
    const memberId = await seedMember(tenantA);
    const a = await seedBill(tenantA, user, memberId, {
      billNumber: 'SC-2026-910010',
      status: 'void',
      createdAt: new Date('2026-01-06T00:00:00Z'),
    });
    const b = await seedBill(tenantA, user, memberId, {
      billNumber: 'SC-2026-910011',
      status: 'void',
      createdAt: new Date('2026-01-07T00:00:00Z'),
    });
    const c = await seedBill(tenantA, user, memberId, {
      billNumber: 'SC-2026-910012',
      status: 'issued',
      createdAt: new Date('2026-01-08T00:00:00Z'),
    });
    await forgeVoidedAudit(tenantA, user, { invoice_id: a, superseded_by_invoice_id: b, member_id: memberId });
    await forgeVoidedAudit(tenantA, user, { invoice_id: b, superseded_by_invoice_id: c, member_id: memberId });

    const onA = await resolve(tenantA, { invoiceId: a, status: 'void', memberId });
    const onB = await resolve(tenantA, { invoiceId: b, status: 'void', memberId });
    expect(onA.ok && onB.ok).toBe(true);
    if (!onA.ok || !onB.ok) return;
    expect(onA.value.replacedBy).toMatchObject({ invoiceId: b, status: 'void' });
    expect(onB.value.replacedBy).toMatchObject({ invoiceId: c, status: 'issued' });
    expect(onB.value.replaces).toEqual([
      { invoiceId: a, displayNumber: 'SC-2026-910010', issueDate: '2026-01-15', status: 'void' },
    ]);
  });

  describe('AS4 — cross-tenant isolation (Constitution I.3)', () => {
    it('app layer: an invoice_voided row with tenant_id NULL (visible under the audit_log RLS policy) never resolves', async () => {
      const memberId = await seedMember(tenantA);
      const voided = await seedBill(tenantA, user, memberId, {
        billNumber: 'SC-2026-910020',
        status: 'void',
        createdAt: new Date('2026-01-09T00:00:00Z'),
      });
      const target = await seedBill(tenantA, user, memberId, {
        billNumber: 'SC-2026-910021',
        status: 'issued',
        createdAt: new Date('2026-01-10T00:00:00Z'),
      });
      // The audit_log policy admits `tenant_id IS NULL` (F1 identity) rows in
      // every tenant context, so RLS alone would let this row through; only
      // the adapter's explicit `a.tenant_id = $tenant` predicate stops it.
      await db.insert(auditLog).values({
        eventType: 'invoice_voided',
        actorUserId: user.userId,
        summary: 'tenantless supersede link (test)',
        requestId: `forge-null-${randomUUID()}`,
        payload: { invoice_id: voided, superseded_by_invoice_id: target, member_id: memberId },
        tenantId: null,
      });

      const fwd = await resolve(tenantA, { invoiceId: voided, status: 'void', memberId });
      const rev = await resolve(tenantA, { invoiceId: target, status: 'issued', memberId });
      expect(fwd.ok && rev.ok).toBe(true);
      if (!fwd.ok || !rev.ok) return;
      expect(fwd.value.replacedBy).toBeNull();
      expect(rev.value.replaces).toEqual([]);
    });

    it('tenant B resolves neither direction of tenant A’s link', async () => {
      const fwd = await resolve(tenantB, { invoiceId: oldBillId, status: 'void', memberId: memberA1 });
      const rev = await resolve(tenantB, {
        invoiceId: newBill.invoiceId,
        status: 'issued',
        memberId: memberA1,
      });
      expect(fwd.ok && rev.ok).toBe(true);
      if (!fwd.ok || !rev.ok) return;
      expect(fwd.value).toEqual({ replacedBy: null, replaces: [] });
      expect(rev.value).toEqual({ replacedBy: null, replaces: [] });
    });

    it('a tenant-B audit row naming a tenant-A invoice never resolves, and never shadows A’s own link', async () => {
      const memberB = await seedMember(tenantB);
      const billB = await seedBill(tenantB, user, memberB, {
        billNumber: 'SC-2026-920001',
        status: 'void',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      });
      // B's void row points at A's replacement bill …
      await forgeVoidedAudit(tenantB, user, {
        invoice_id: billB,
        superseded_by_invoice_id: newBill.invoiceId,
        member_id: memberB,
      });
      // … and a NEWER B row claims A's old bill was superseded by B's bill.
      await forgeVoidedAudit(tenantB, user, {
        invoice_id: oldBillId,
        superseded_by_invoice_id: billB,
        member_id: memberA1,
      });

      const fromB = await resolve(tenantB, { invoiceId: billB, status: 'void', memberId: memberB });
      expect(fromB.ok).toBe(true);
      if (!fromB.ok) return;
      expect(fromB.value.replacedBy).toBeNull();

      const fromA = await resolve(tenantA, { invoiceId: oldBillId, status: 'void', memberId: memberA1 });
      expect(fromA.ok).toBe(true);
      if (!fromA.ok) return;
      expect(fromA.value.replacedBy?.invoiceId).toBe(newBill.invoiceId);

      const revA = await resolve(tenantA, {
        invoiceId: newBill.invoiceId,
        status: 'issued',
        memberId: memberA1,
      });
      expect(revA.ok).toBe(true);
      if (!revA.ok) return;
      expect(revA.value.replaces.map((l) => l.invoiceId)).toEqual([oldBillId]);
    });

    it('DB layer: tenant B’s RLS context sees none of tenant A’s supersede rows or invoices', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ tenantId: auditLog.tenantId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.eventType, 'invoice_voided'),
              sql`${auditLog.payload}->>'superseded_by_invoice_id' IS NOT NULL`,
            ),
          ),
      );
      // B sees its own supersede rows (and, by the policy's design, F1-style
      // `tenant_id IS NULL` rows — which the app-layer test above proves the
      // adapter ignores), but never one of tenant A's.
      expect(rows.some((r) => r.tenantId === tenantB.ctx.slug)).toBe(true);
      expect(rows.some((r) => r.tenantId === tenantA.ctx.slug)).toBe(false);

      const foreign = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ id: invoices.invoiceId })
          .from(invoices)
          .where(eq(invoices.invoiceId, newBill.invoiceId)),
      );
      expect(foreign).toEqual([]);
    });
  });

  describe('AS5 — member scope (portal)', () => {
    it('keeps a same-member link under the member scope', async () => {
      const result = await resolve(
        tenantA,
        { invoiceId: oldBillId, status: 'void', memberId: memberA1 },
        memberA1,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.replacedBy?.invoiceId).toBe(newBill.invoiceId);
    });

    it('drops a link to another member’s invoice for the member, keeps it for staff', async () => {
      const m1 = await seedMember(tenantA);
      const m2 = await seedMember(tenantA);
      const voidedOfM1 = await seedBill(tenantA, user, m1, {
        billNumber: 'SC-2026-910003',
        status: 'void',
        createdAt: new Date('2026-01-04T00:00:00Z'),
      });
      const billOfM2 = await seedBill(tenantA, user, m2, {
        billNumber: 'SC-2026-910004',
        status: 'issued',
        createdAt: new Date('2026-01-05T00:00:00Z'),
      });
      await forgeVoidedAudit(tenantA, user, {
        invoice_id: voidedOfM1,
        superseded_by_invoice_id: billOfM2,
        member_id: m1,
      });

      const memberFwd = await resolve(tenantA, { invoiceId: voidedOfM1, status: 'void', memberId: m1 }, m1);
      const staffFwd = await resolve(tenantA, { invoiceId: voidedOfM1, status: 'void', memberId: m1 });
      const memberRev = await resolve(tenantA, { invoiceId: billOfM2, status: 'issued', memberId: m2 }, m2);
      const staffRev = await resolve(tenantA, { invoiceId: billOfM2, status: 'issued', memberId: m2 });
      expect(memberFwd.ok && staffFwd.ok && memberRev.ok && staffRev.ok).toBe(true);
      if (!memberFwd.ok || !staffFwd.ok || !memberRev.ok || !staffRev.ok) return;

      expect(memberFwd.value.replacedBy).toBeNull();
      expect(memberRev.value.replaces).toEqual([]);
      expect(staffFwd.value.replacedBy?.invoiceId).toBe(billOfM2);
      expect(staffRev.value.replaces.map((l) => l.invoiceId)).toEqual([voidedOfM1]);
    });
  });
});
