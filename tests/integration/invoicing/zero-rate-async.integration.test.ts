/**
 * 088-invoice-tax-flow-redesign (T054 / US8 / SC-008 / AS5 / § F.2 G1) — live-Neon
 * proof that the ASYNC receipt-render worker sources the PINNED `vat_treatment`
 * + MFA cert from the invoice row (NEVER defaults to 7%), so an async-rendered
 * §86/4 receipt on a `zero_rated_80_1_5` bill computes VAT 0% + renders the
 * §80/1(5) note.
 *
 * Full chain: createEventInvoiceDraft → issueInvoice (zero-rate + cert, bill) →
 * recordPayment (asyncReceiptPdf=TRUE → receipt left 'pending', RC pre-allocated,
 * NO sync render) → renderReceiptPdf worker (REAL @react-pdf adapter, bytes
 * captured + pdf-parsed).
 *
 * Migrations 0230→0234 MUST be applied to the `dev` Neon branch first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PDFParse } from 'pdf-parse';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import { renderReceiptPdf } from '@/modules/invoicing/application/use-cases/render-receipt-pdf';
import {
  makeCreateEventInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
  makeRenderReceiptPdfDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const FIXED_NOW = '2026-07-01T09:00:00Z';
const PAYMENT_DATE = '2026-07-01';
const CERT_NO = 'กต 0404/9999';
const CERT_DATE = '2026-03-11';
const RX_8015 = /80\/1\(5\)/;

/** Mocked render+blob (used for the bill issue + the async-mode pay, neither asserted). */
function mockRenderBlob() {
  return {
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDeps(slug: string): IssueInvoiceDeps {
  return { ...makeIssueInvoiceDeps(slug), ...mockRenderBlob(), clock: { nowIso: () => FIXED_NOW }, taxAtPayment: 'on' };
}

function recordDepsAsync(slug: string): RecordPaymentDeps {
  return {
    ...makeRecordPaymentDeps(slug),
    ...mockRenderBlob(),
    clock: { nowIso: () => FIXED_NOW },
    taxAtPayment: 'on',
    // Async path — receipt left 'pending', RC pre-allocated, NO sync render.
    asyncReceiptPdf: true,
  };
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  return (await parser.getText()).text;
}

describe('088 US8 — async worker sources pinned vat_treatment (live Neon, AS5)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let eventId: string;
  let regId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    eventId = randomUUID();
    regId = randomUUID();

    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-zra-${eventId.slice(0, 8)}`,
        name: 'Embassy Async Service',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values([
        {
          tenantId: tenant.ctx.slug,
          eventId,
          registrationId: regId,
          externalId: `att-zra-${regId.slice(0, 8)}`,
          attendeeName: 'Sim Async',
          attendeeCompany: 'Embassy of Sweden (Simulated)',
          attendeeEmail: 'sim.async@zra-embassy.test',
          matchType: 'non_member' as const,
          ticketType: 'Service',
          ticketPriceThb: 12000,
          paymentStatus: 'pending' as const,
          registeredAt: new Date('2026-01-20T03:00:00Z'),
        },
      ] satisfies NewEventRegistrationRow[]);
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('AS5 — async receipt render of a zero-rated bill → VAT 0% + §80/1(5) note', async () => {
    // 1. Draft + issue a zero-rated bill (TIN buyer → bill→receipt flow).
    const draft = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zra-draft-${regId}`,
      eventRegistrationId: regId,
      amountOverride: 1_200_000,
      buyer: {
        legal_name: 'Embassy of Sweden (Simulated)',
        tax_id: '0994000000002',
        address: '1 Wireless Rd, Bangkok',
        primary_contact_name: 'Sim Async',
        primary_contact_email: 'sim.async@zra-embassy.test',
      },
    });
    expect(draft.ok, draft.ok ? 'ok' : JSON.stringify(draft)).toBe(true);
    if (!draft.ok) throw new Error('draft failed');
    const invoiceId = draft.value.invoiceId;

    const issued = await issueInvoice(issueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zra-issue-${invoiceId}`,
      invoiceId,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: CERT_NO,
      zeroRateCertDate: CERT_DATE,
    });
    expect(issued.ok, issued.ok ? 'ok' : JSON.stringify(issued)).toBe(true);
    if (!issued.ok) throw new Error('issue failed');

    // 2. Pay on the ASYNC path — receipt left 'pending', RC pre-allocated, no
    //    sync render. The pinned vat_treatment + cert are on the row.
    const paid = await recordPayment(recordDepsAsync(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `zra-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: PAYMENT_DATE,
    });
    expect(paid.ok, paid.ok ? 'ok' : JSON.stringify(paid)).toBe(true);
    if (!paid.ok) throw new Error('pay failed');

    const [pendingRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(pendingRow!.receiptPdfStatus).toBe('pending');
    expect(pendingRow!.receiptDocumentNumberRaw).toMatch(/^RC-2026-\d{6}$/);
    expect(pendingRow!.vatTreatment).toBe('zero_rated_80_1_5');

    // 3. Run the async worker with the REAL @react-pdf adapter; capture bytes.
    const capturedBytes: Uint8Array[] = [];
    const workerDeps = {
      ...makeRenderReceiptPdfDeps(tenant.ctx.slug),
      blob: {
        uploadPdf: vi.fn(async ({ key, body }: { key: string; body: Uint8Array }) => {
          capturedBytes.push(body);
          return { key, url: `https://blob.test/${key}` };
        }),
        uploadLogo: vi.fn(),
        signDownloadUrl: vi.fn(),
        downloadBytes: vi.fn(),
        delete: vi.fn(async () => {}),
        list: vi.fn(),
      },
      clock: { nowIso: () => FIXED_NOW },
    };
    const rendered = await renderReceiptPdf(workerDeps, {
      tenantId: tenant.ctx.slug,
      invoiceId,
      fiscalYear: 2026,
      // The dispatcher passes CURRENT; the note gate requires v>=8.
      templateVersion: CURRENT_TEMPLATE_VERSION,
      requestId: `zra-render-${invoiceId}`,
    });
    expect(rendered.ok, rendered.ok ? 'ok' : JSON.stringify(rendered)).toBe(true);

    const [renderedRow] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    expect(renderedRow!.receiptPdfStatus).toBe('rendered');

    // SC-008 on the ASYNC path — the worker sourced the pinned zero-rate
    // treatment (never 7%): VAT 0.00% + the §80/1(5) note + cert reference.
    expect(capturedBytes).toHaveLength(1);
    const text = await extractPdfText(capturedBytes[0]!);
    expect(text, 'async receipt must cite §80/1(5)').toMatch(RX_8015);
    expect(text, 'async receipt must reference the MFA cert number').toContain('0404/9999');
    expect(text, 'async receipt VAT rate is 0.00%').toContain('0.00%');
  }, 120_000);
});
