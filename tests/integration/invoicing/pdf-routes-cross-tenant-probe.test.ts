/**
 * I5 — PDF routes cross-tenant probe (Constitution v1.4.0 Principle I,
 * Review-Gate blocker).
 *
 * Mirrors `tenant-invoice-settings-probe.test.ts` for the two PDF
 * use-cases that back `/api/invoices/[id]/pdf`, `/api/portal/invoices/[id]/pdf`,
 * and `/api/credit-notes/[id]/pdf` (+ portal equivalent). All three
 * routes ultimately call either `getInvoicePdfSignedUrl` or
 * `getCreditNotePdfSignedUrl` — those use-cases are the single
 * tenant-isolation choke point, so we probe them directly against
 * live Neon.
 *
 * Assertions:
 *   1. Seed tenant A with an invoice + a credit-note.
 *   2. From tenant B's context, call both use-cases with tenant A's
 *      ids. Expect `invoice_not_found` / `credit_note_not_found` (opaque
 *      404) — never a signed URL.
 *   3. Audit log receives `invoice_cross_tenant_probe` /
 *      `credit_note_cross_tenant_probe` with the actor's tenant id (B)
 *      and the probed id in the payload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  getInvoicePdfSignedUrl,
  makeGetInvoicePdfSignedUrlDeps,
  getCreditNotePdfSignedUrl,
  makeGetCreditNotePdfSignedUrlDeps,
} from '@/modules/invoicing';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const TENANT_SNAP = {
  legal_name_th: 'I5 probe',
  legal_name_en: 'I5 probe',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};

const MEMBER_SNAP = {
  legal_name: 'I5 Probe Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'Somchai',
  primary_contact_email: 'somchai@i5.test',
};

describe('I5 — PDF routes cross-tenant probe (Principle I Review-Gate)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  const memberId = randomUUID();
  const invoiceId = randomUUID();
  const creditNoteId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenantA.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: TENANT_SNAP.legal_name_th,
        legalNameEn: TENANT_SNAP.legal_name_en,
        taxId: TENANT_SNAP.tax_id,
        registeredAddressTh: TENANT_SNAP.address_th,
        registeredAddressEn: TENANT_SNAP.address_en,
        invoiceNumberPrefix: 'I5',
        creditNoteNumberPrefix: 'I5C',
      });
      await tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'i5-plan',
        draftByUserId: user.userId,
        status: 'issued',
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'I5-2026-000001',
        issueDate: '2026-01-10',
        dueDate: '2026-02-09',
        subtotalSatang: 100_000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'monthly',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: TENANT_SNAP,
        memberIdentitySnapshot: MEMBER_SNAP,
        pdfBlobKey: 'invoicing/i5/2026/inv.pdf',
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      await tx.insert(creditNotes).values({
        tenantId: tenantA.ctx.slug,
        creditNoteId,
        originalInvoiceId: invoiceId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'I5C-2026-000001',
        issueDate: '2026-01-15',
        issuedByUserId: user.userId,
        reason: 'I5 probe',
        creditAmountSatang: 50_000n,
        vatSatang: 3_500n,
        totalSatang: 53_500n,
        tenantIdentitySnapshot: TENANT_SNAP,
        memberIdentitySnapshot: MEMBER_SNAP,
        pdfBlobKey: 'invoicing/i5/2026/cn.pdf',
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('getInvoicePdfSignedUrl from tenant B refuses tenant A\u2019s invoiceId + emits probe', async () => {
    const requestId = `i5-inv-${randomUUID()}`;
    const result = await getInvoicePdfSignedUrl(
      makeGetInvoicePdfSignedUrlDeps(tenantB.ctx.slug),
      {
        tenantId: tenantB.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId,
        invoiceId,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_not_found');

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'invoice_cross_tenant_probe'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.attempted_invoice_id).toBe(invoiceId);
    expect(payload.actor_role).toBe('admin');
    expect(payload.route).toBe('get-invoice-pdf-signed-url');
  }, 30_000);

  it('getCreditNotePdfSignedUrl from tenant B refuses tenant A\u2019s creditNoteId + emits probe', async () => {
    const requestId = `i5-cn-${randomUUID()}`;
    const result = await getCreditNotePdfSignedUrl(
      makeGetCreditNotePdfSignedUrlDeps(tenantB.ctx.slug),
      {
        tenantId: tenantB.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId,
        creditNoteId,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('credit_note_not_found');

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantB.ctx.slug),
          eq(auditLog.eventType, 'credit_note_cross_tenant_probe'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.attempted_credit_note_id).toBe(creditNoteId);
    expect(payload.actor_role).toBe('admin');
    expect(payload.route).toBe('get-credit-note-pdf-signed-url');
  }, 30_000);

  it('member actor from tenant B cannot even see existence of tenant A\u2019s CN', async () => {
    const requestId = `i5-cn-member-${randomUUID()}`;
    const result = await getCreditNotePdfSignedUrl(
      makeGetCreditNotePdfSignedUrlDeps(tenantB.ctx.slug),
      {
        tenantId: tenantB.ctx.slug,
        actorUserId: user.userId,
        actorRole: 'member',
        actorMemberId: randomUUID(),
        requestId,
        creditNoteId,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // MUST be the opaque "not found" so a cross-tenant member cannot
    // distinguish "exists elsewhere" from "truly absent".
    expect(result.error.code).toBe('credit_note_not_found');
  }, 30_000);
});
