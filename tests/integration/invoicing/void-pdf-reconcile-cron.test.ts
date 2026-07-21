/**
 * Bug 10 — void §86/4 PDF re-stamp reconcile cron (live Neon).
 *
 * Seeds a `void` invoice marked for reconcile (blob_upload-leg failure), then
 * drives the cron GET with a mocked render + blob adapter and asserts it
 * re-uploads the VOID overlay, syncs the sha, and clears the marker — plus the
 * corruption-park and auth branches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const RESTAMP_SHA = 'f'.repeat(64);

vi.mock('@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter', () => ({
  reactPdfRenderAdapter: {
    render: vi.fn(async () => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
      // The domain Sha256Hex brand is a plain string at runtime.
      sha256: 'f'.repeat(64),
    })),
  },
}));
vi.mock('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter', () => ({
  vercelBlobAdapter: {
    uploadPdf: vi.fn(async (input: { key: string }) => ({
      key: input.key,
      url: `https://blob.test/${input.key}`,
    })),
    signDownloadUrl: vi.fn(async (key: string) => `https://blob.test/${key}`),
    downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    delete: vi.fn(),
    list: vi.fn(async () => [] as string[]),
  },
}));

// Import AFTER the mocks so the route binds the mocked adapters.
const { GET: reconcileCron } = await import(
  '@/app/api/internal/cron/void-pdf-reconcile/route'
);
const { vercelBlobAdapter } = await import(
  '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter'
);

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
  legal_name: 'Void Reconcile Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
  member_number: null,
  member_number_display: null,
};

function cronReq(auth = `Bearer ${process.env.CRON_SECRET}`): NextRequest {
  return new NextRequest('http://localhost/api/internal/cron/void-pdf-reconcile', {
    headers: { authorization: auth },
  });
}

describe('void-pdf-reconcile cron (bug 10)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    planId = `vprc-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Void Reconcile Plan' },
        description: { en: 'Test' },
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
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => console.error('tenant cleanup:', e));
  });

  /** Seed a `void` invoice already marked for reconcile. */
  async function seedMarkedVoid(opts: {
    voidReason: string | null;
    attempts?: number;
    seq: number;
  }): Promise<string> {
    const invoiceId = randomUUID();
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Void Reconcile Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'void',
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        sequenceNumber: opts.seq,
        documentNumber: `VPRC-2026-${String(opts.seq).padStart(6, '0')}`,
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
        pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}_v1.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        receiptPdfStatus: null,
        voidedAt: new Date('2026-03-01T03:00:00Z'),
        voidReason: opts.voidReason,
        voidedByUserId: user.userId,
        voidPdfReconcilePendingAt: new Date('2026-03-01T03:05:00Z'),
        voidPdfReconcileAttempts: opts.attempts ?? 0,
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

  async function readMarker(invoiceId: string) {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          pdfSha256: invoices.pdfSha256,
          pendingAt: invoices.voidPdfReconcilePendingAt,
          attempts: invoices.voidPdfReconcileAttempts,
          parkedAt: invoices.voidPdfReconcileParkedAt,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    return row;
  }

  it('D7 — 401 without a bearer, 500 on a misconfigured secret', async () => {
    const noAuth = await reconcileCron(cronReq(''));
    expect(noAuth.status).toBe(401);
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'short';
    const bad = await reconcileCron(cronReq('Bearer short'));
    expect(bad.status).toBe(500);
    process.env.CRON_SECRET = prev;
  });

  it('D1 — reconciles a marked void: re-uploads, syncs the sha, clears the marker', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'wrong tier', seq: 1 });
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockClear();

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    // The VOID-stamped bytes were re-uploaded at the content-addressed key.
    expect(vercelBlobAdapter.uploadPdf).toHaveBeenCalled();
    const row = await readMarker(invoiceId);
    // sha synced to the freshly-rendered value; marker cleared.
    expect(row?.pdfSha256).toBe(RESTAMP_SHA);
    expect(row?.pendingAt).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row?.parkedAt).toBeNull();
  }, 60_000);

  // NOTE: the cron's corruption-PARK branch (null void_reason / no_snapshot) is
  // defensive-only — the DB CHECK `invoices_void_has_reason` forbids a void row
  // with a null reason, and every voided row carries its issue-time snapshots +
  // document number, so `buildVoidRenderTargets` never returns those on a legit
  // row. It is un-seedable through the constraint, so it stays untested-by-DB
  // (kept as a safety net for a future data-corruption bug).

  it('D2 — a re-upload failure bumps attempts + keeps the row pending (never parks)', async () => {
    const invoiceId = await seedMarkedVoid({
      voidReason: 'upload fails',
      attempts: 2,
      seq: 4,
    });
    (vercelBlobAdapter.uploadPdf as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('blob outage'),
    );

    const res = await reconcileCron(cronReq());
    expect(res.status).toBe(200);

    const row = await readMarker(invoiceId);
    expect(row?.attempts).toBe(3); // SQL-incremented
    expect(row?.pendingAt).not.toBeNull(); // still eligible — retries
    expect(row?.parkedAt).toBeNull(); // NEVER abandon a voided tax doc
    // Below the escalation threshold (3 < 5) → no alert yet.
    const alerts = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'pdf_render_permanently_failed'),
            sql`${auditLog.payload}->>'invoice_id' = ${invoiceId}`,
          ),
        ),
    );
    expect(alerts).toHaveLength(0);
  }, 60_000);

  it('D5 — idempotent under a double fire (re-render + sync + clear, no error)', async () => {
    const invoiceId = await seedMarkedVoid({ voidReason: 'double fire', seq: 3 });
    const r1 = await reconcileCron(cronReq());
    const r2 = await reconcileCron(cronReq());
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const row = await readMarker(invoiceId);
    expect(row?.pdfSha256).toBe(RESTAMP_SHA);
    expect(row?.pendingAt).toBeNull();
  }, 60_000);
});
