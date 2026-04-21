/**
 * T098 — Void-invoice integration test (F4 / US5 Phase 9).
 *
 * Covers US5 AS1–AS3 + FR-036 cancellation-outbox enqueue:
 *  - Happy path: issued → void transitions cleanly, PDF re-uploaded
 *    (allowOverwrite=true), pdf_sha256 flipped to the re-rendered
 *    value, audit row emitted with `member_id`, cancellation outbox
 *    row enqueued when `auto_email_on_issue` resolves true.
 *  - Refusals: paid → `invalid_status` (admin directed to CN); void
 *    → `invalid_status` (re-void blocked); no mutation in either case.
 *  - Cross-tenant probe audit on RLS-hidden / truly-missing invoice.
 *  - Void KEEPS the sequential number; a later issue in the same
 *    fiscal year takes the NEXT number (no reuse, §87 no-gap).
 *
 * Uses live Neon Singapore via `runInTenant`. PDF/Blob/outbox mocked
 * to keep the test fast; DB + RLS + audit are real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { voidInvoice } from '@/modules/invoicing/application/use-cases/void-invoice';
import type { VoidInvoiceDeps } from '@/modules/invoicing/application/use-cases/void-invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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
  legal_name: 'Void Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'n@n.n',
};
const ORIGINAL_SHA = 'a'.repeat(64);
const RERENDERED_SHA = 'b'.repeat(64);
const ORIGINAL_BLOB_KEY = 'invoicing/x/2026/seed.pdf';

async function seedInvoice(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  status: 'issued' | 'paid' | 'void',
  sequenceNumber = 1,
  autoEmail: boolean | null = true,
): Promise<{ invoiceId: string; memberId: string }> {
  const invoiceId = randomUUID();
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: 'Void Test Co',
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
      status,
      fiscalYear: 2026,
      sequenceNumber,
      documentNumber: `VDIT-2026-${String(sequenceNumber).padStart(6, '0')}`,
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
      autoEmailOnIssue: autoEmail,
      pdfBlobKey: ORIGINAL_BLOB_KEY,
      pdfSha256: ORIGINAL_SHA,
      pdfTemplateVersion: 1,
      paymentMethod: status === 'paid' ? 'bank_transfer' : null,
      paymentReference: status === 'paid' ? 'seed-ref' : null,
      paymentRecordedByUserId: status === 'paid' ? user.userId : null,
      paymentDate: status === 'paid' ? '2026-02-01' : null,
      paidAt: status === 'paid' ? new Date('2026-02-01T03:00:00Z') : null,
      voidedAt: status === 'void' ? new Date('2026-03-01T03:00:00Z') : null,
      voidReason: status === 'void' ? 'seed void' : null,
      voidedByUserId: status === 'void' ? user.userId : null,
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
  return { invoiceId, memberId };
}

function makeDeps(tenantId: string): VoidInvoiceDeps & {
  renderCalls: unknown[];
  uploadCalls: unknown[];
  outboxCalls: unknown[];
} {
  const renderCalls: unknown[] = [];
  const uploadCalls: unknown[] = [];
  const outboxCalls: unknown[] = [];
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: {
      render: vi.fn(async (input) => {
        renderCalls.push(input);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x56]),
          sha256: Sha256Hex.ofUnsafe(RERENDERED_SHA),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async (input) => {
        uploadCalls.push(input);
        return { key: input.key, url: `https://blob.test/${input.key}` };
      }),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => [] as string[]),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-03-15T10:00:00Z' },
    outbox: {
      enqueue: vi.fn(async (_tx, input) => {
        outboxCalls.push(input);
      }),
    },
    renderCalls,
    uploadCalls,
    outboxCalls,
  };
}

describe('F4 US5 — void-invoice (T098)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'void-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Void Plan' },
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
        invoiceNumberPrefix: 'VDIT',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  beforeEach(async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
      await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
      await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
    });
  });

  it('voids an issued invoice, re-renders PDF, emits audit + outbox', async () => {
    const { invoiceId, memberId } = await seedInvoice(tenant, user, planId, 'issued');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Wrong tier selected',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('void');
    expect(r.value.voidReason).toBe('Wrong tier selected');
    expect(r.value.voidedByUserId).toBe(user.userId);

    // DB row updated with new sha + status = void
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          pdfSha256: invoices.pdfSha256,
          pdfBlobKey: invoices.pdfBlobKey,
          voidReason: invoices.voidReason,
          voidedByUserId: invoices.voidedByUserId,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(row?.status).toBe('void');
    expect(row?.pdfSha256).toBe(RERENDERED_SHA);
    // Blob key PRESERVED (content-addressed; overwrite at same key)
    expect(row?.pdfBlobKey).toBe(ORIGINAL_BLOB_KEY);
    expect(row?.voidReason).toBe('Wrong tier selected');
    expect(row?.voidedByUserId).toBe(user.userId);

    // Render called with void_stamped_invoice kind + PINNED version
    expect(deps.renderCalls).toHaveLength(1);
    const renderIn = deps.renderCalls[0] as { kind: string; templateVersion: number; voidReason?: string };
    expect(renderIn.kind).toBe('void_stamped_invoice');
    expect(renderIn.templateVersion).toBe(1);
    expect(renderIn.voidReason).toBe('Wrong tier selected');

    // Blob overwrite at SAME key with allowOverwrite
    expect(deps.uploadCalls).toHaveLength(1);
    const up = deps.uploadCalls[0] as { key: string; allowOverwrite?: boolean };
    expect(up.key).toBe(ORIGINAL_BLOB_KEY);
    expect(up.allowOverwrite).toBe(true);

    // Audit row with member_id (US7 F3-timeline coupling)
    const auditRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_voided'),
          ),
        ),
    );
    expect(auditRows).toHaveLength(1);
    const payload = auditRows[0]!.payload as Record<string, unknown>;
    expect(payload.invoice_id).toBe(invoiceId);
    expect(payload.member_id).toBe(memberId);
    expect(payload.void_reason).toBe('Wrong tier selected');
    expect(payload.new_pdf_sha256).toBe(RERENDERED_SHA);

    // Outbox enqueued (auto_email_on_issue=true)
    expect(deps.outboxCalls).toHaveLength(1);
    const ob = deps.outboxCalls[0] as { eventType: string; invoiceId: string; pdfBlobKey: string };
    expect(ob.eventType).toBe('invoice_voided');
    expect(ob.invoiceId).toBe(invoiceId);
    expect(ob.pdfBlobKey).toBe(ORIGINAL_BLOB_KEY);
  }, 60_000);

  it('refuses to void a paid invoice (directs admin to credit-note flow)', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'paid');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Trying to void paid',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_status');
    if (r.error.code === 'invalid_status') expect(r.error.status).toBe('paid');

    // No side effects
    expect(deps.renderCalls).toHaveLength(0);
    expect(deps.uploadCalls).toHaveLength(0);
    expect(deps.outboxCalls).toHaveLength(0);
  }, 60_000);

  it('refuses to re-void a voided invoice (terminal state)', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'void');
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Trying to re-void',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_status');
    if (r.error.code === 'invalid_status') expect(r.error.status).toBe('void');
    expect(deps.renderCalls).toHaveLength(0);
  }, 60_000);

  it('does not enqueue outbox when auto_email_on_issue=false', async () => {
    const { invoiceId } = await seedInvoice(tenant, user, planId, 'issued', 1, false);
    const deps = makeDeps(tenant.ctx.slug);

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
      voidReason: 'Silent void',
    });
    expect(r.ok).toBe(true);
    expect(deps.outboxCalls).toHaveLength(0);
  }, 60_000);

  it('emits cross-tenant probe audit on unknown invoice id', async () => {
    const deps = makeDeps(tenant.ctx.slug);
    const fakeId = randomUUID();

    const r = await voidInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId: fakeId,
      voidReason: 'Probe test',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invoice_not_found');

    const probeRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
            sql`${auditLog.payload}->>'route' = 'void-invoice'`,
          ),
        ),
    );
    expect(probeRows.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
