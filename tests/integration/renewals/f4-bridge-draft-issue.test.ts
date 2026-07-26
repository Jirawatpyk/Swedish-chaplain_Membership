/**
 * 107-auto-invoice (Task 5) — `draftInvoiceForRenewal` +
 * `issueExistingDraftForRenewal` bridge methods, live Neon Singapore.
 *
 * Proves the split of `issueInvoiceForRenewal`'s create+issue composition
 * into two independently-callable halves. The auto-invoice cron (Task 7)
 * will call `draftInvoiceForRenewal` ahead of the due date; the
 * review-queue "Issue" action (Task 9) will later call
 * `issueExistingDraftForRenewal` on that SAME draft, once an operator has
 * decided whether to auto-email it.
 *
 * Scenarios:
 *   1. `draftInvoiceForRenewal` -> a DRAFT invoice stamped
 *      `origin='auto_renewal'`, `autoEmailOnIssue=false`, with NO printed
 *      number, NO PDF, and NO `notifications_outbox` row (nothing is sent
 *      for an un-issued draft).
 *   2. `issueExistingDraftForRenewal({autoEmailOnIssue:false})` on such a
 *      draft -> `status:'issued'`, a printed number minted, still 0 outbox
 *      rows (silent issue — the T4 `autoEmailOverride` forwarding proven
 *      end-to-end).
 *   3. The same flow with `autoEmailOnIssue:true` -> exactly 1 outbox row.
 *
 * Mocking policy mirrors `tests/integration/invoicing/issue-membership-
 * bill.test.ts` (Task 4's own live-Neon proof of this bridge file): PDF
 * render + Blob upload are mocked module-wide (network-touching, not the
 * system under test); the audit + outbox adapters are the REAL
 * Drizzle-backed ones so the `notifications_outbox` row-count assertions
 * land on live Neon (`resendEmailOutboxAdapter.enqueue` only INSERTs a
 * row — it never calls the Resend API itself; that happens in the
 * separate outbox-dispatch cron, not exercised here).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { parseThbDecimal } from '@/lib/money';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// --- Module-level mocks (mirrors issue-membership-bill.test.ts) ----------
// `vi.mock` calls are hoisted above every import in this file by Vitest's
// transform, so every `makeCreateInvoiceDraftDeps` / `makeIssueMembership
// BillDeps` call the bridge makes (indirectly, via the F4 barrel) picks up
// these fakes instead of touching react-pdf / real Vercel Blob.
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

// Imports that depend on the mocked modules MUST come after the vi.mock calls.
import { f4InvoicingForRenewalBridge } from '@/modules/renewals/infrastructure/ports-adapters/f4-invoicing-for-renewal-bridge-drizzle';

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

describe('f4InvoicingForRenewalBridge — draftInvoiceForRenewal + issueExistingDraftForRenewal (107-auto-invoice Task 5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'auto-invoice-t5-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, invoiceNumberPrefix: 'SC', receiptNumberPrefix: 'RC' });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Auto-Invoice Bridge Test Plan' },
        description: { en: 'Task 5 bridge test' },
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
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  /** Seed a fresh member; `withEmail` also seeds a primary contact with a
   * deliverable address (required for the "1 outbox row" scenario — the
   * real `memberIdentityAdapter` reads the F3 contacts table). */
  async function seedMember(withEmail: boolean): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Auto-Invoice Bridge Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      if (withEmail) {
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Auto',
          lastName: 'Invoice',
          // Unique per member — `contacts_tenant_email_uniq` rejects a
          // second identical address within the same tenant, and this
          // helper is called once per test.
          email: `auto-invoice-t5-${memberId.slice(0, 8)}@example.com`,
          isPrimary: true,
        });
      }
    });
    return memberId;
  }

  async function outboxCountForInvoice(invoiceId: string): Promise<number> {
    const rows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          eq(notificationsOutbox.notificationType, 'invoice_auto_email'),
        ),
      );
    return rows.filter(
      (r) => (r.contextData as Record<string, unknown>).invoice_id === invoiceId,
    ).length;
  }

  it('draftInvoiceForRenewal creates a draft: origin=auto_renewal, autoEmailOnIssue=false, no number/PDF/outbox', async () => {
    const memberId = await seedMember(false);

    const result = await f4InvoicingForRenewalBridge.draftInvoiceForRenewal({
      tenantId: tenant.ctx.slug,
      memberId,
      planId,
      planYear: 2026,
      frozenPlanPriceThb: parseThbDecimal('50000.00'),
      actorUserId: user.userId,
      coverageWindow: { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2027-01-01T00:00:00.000Z' },
      requestId: 't5-draft-1',
    });

    expect(
      result.status,
      result.status !== 'drafted' ? `err: ${JSON.stringify(result)}` : 'ok',
    ).toBe('drafted');
    if (result.status !== 'drafted') return;

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          origin: invoices.origin,
          autoEmailOnIssue: invoices.autoEmailOnIssue,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
          documentNumber: invoices.documentNumber,
          pdfBlobKey: invoices.pdfBlobKey,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, result.invoiceId)),
    );
    expect(row?.status).toBe('draft');
    expect(row?.origin).toBe('auto_renewal');
    expect(row?.autoEmailOnIssue).toBe(false);
    expect(row?.billDocumentNumberRaw).toBeNull();
    expect(row?.documentNumber).toBeNull();
    expect(row?.pdfBlobKey).toBeNull();
    expect(await outboxCountForInvoice(result.invoiceId)).toBe(0);
  }, 60_000);

  it('issueExistingDraftForRenewal({autoEmailOnIssue:false}) mints a number and enqueues NO outbox row', async () => {
    const memberId = await seedMember(true);
    const draftResult = await f4InvoicingForRenewalBridge.draftInvoiceForRenewal({
      tenantId: tenant.ctx.slug,
      memberId,
      planId,
      planYear: 2026,
      frozenPlanPriceThb: parseThbDecimal('50000.00'),
      actorUserId: user.userId,
      coverageWindow: { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2027-01-01T00:00:00.000Z' },
      requestId: 't5-draft-2',
    });
    if (draftResult.status !== 'drafted') {
      throw new Error(`draft failed: ${JSON.stringify(draftResult)}`);
    }

    const issueResult = await f4InvoicingForRenewalBridge.issueExistingDraftForRenewal({
      tenantId: tenant.ctx.slug,
      invoiceId: draftResult.invoiceId,
      actorUserId: user.userId,
      autoEmailOnIssue: false,
      requestId: 't5-issue-2',
    });

    expect(
      issueResult.status,
      issueResult.status !== 'issued' ? `err: ${JSON.stringify(issueResult)}` : 'ok',
    ).toBe('issued');
    if (issueResult.status !== 'issued') return;
    expect(issueResult.invoiceNumber).not.toBe('');

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.invoiceId, draftResult.invoiceId)),
    );
    expect(row?.status).toBe('issued');
    expect(await outboxCountForInvoice(draftResult.invoiceId)).toBe(0);
  }, 60_000);

  it('issueExistingDraftForRenewal({autoEmailOnIssue:true}) enqueues exactly ONE outbox row', async () => {
    const memberId = await seedMember(true);
    const draftResult = await f4InvoicingForRenewalBridge.draftInvoiceForRenewal({
      tenantId: tenant.ctx.slug,
      memberId,
      planId,
      planYear: 2026,
      frozenPlanPriceThb: parseThbDecimal('50000.00'),
      actorUserId: user.userId,
      coverageWindow: { fromIso: '2026-01-01T00:00:00.000Z', toIso: '2027-01-01T00:00:00.000Z' },
      requestId: 't5-draft-3',
    });
    if (draftResult.status !== 'drafted') {
      throw new Error(`draft failed: ${JSON.stringify(draftResult)}`);
    }

    const issueResult = await f4InvoicingForRenewalBridge.issueExistingDraftForRenewal({
      tenantId: tenant.ctx.slug,
      invoiceId: draftResult.invoiceId,
      actorUserId: user.userId,
      autoEmailOnIssue: true,
      requestId: 't5-issue-3',
    });

    expect(
      issueResult.status,
      issueResult.status !== 'issued' ? `err: ${JSON.stringify(issueResult)}` : 'ok',
    ).toBe('issued');
    if (issueResult.status !== 'issued') return;
    expect(await outboxCountForInvoice(draftResult.invoiceId)).toBe(1);
  }, 60_000);
});
