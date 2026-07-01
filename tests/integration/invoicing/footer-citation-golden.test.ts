/**
 * Task 31 (065-review-followups) — kind-aware §-citation PDF footer
 * goldens (tax-auditor finding M-D, fixed via template v3).
 *
 * The footer previously printed "เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4"
 * UNCONDITIONALLY on every document kind. Template v3 makes the
 * citation kind-true; v1/v2 (every already-issued row) keep the legacy
 * unconditional string BYTE-FOR-BYTE so SC-003 pinned-version
 * re-renders (void overlay, J2 credited annotation, async receipt
 * worker) reproduce the original output. The version gate works
 * because EVERY re-render path passes the row's PINNED
 * `pdf_template_version` in `PdfRenderInput.templateVersion` (R3-E4)
 * and the template is a pure function of its input.
 *
 * Section A — render-input goldens (REAL adapter + pdf-parse, no DB):
 * per-kind footer text at v3 (right มาตรา present, wrong มาตรา absent)
 * + the OLD-VERSION regression goldens (v1/v2 stay legacy §86/4 for
 * every kind, with the repo's structural length+text standard).
 * External byte evidence: docs/Bug/065-t31-footer-{pre,post}change.txt
 * (v1/v2 kind matrix measured before/after the template change —
 * byte-length + extracted text identical).
 *
 * Section B — live-Neon as-paid β sanity: the REAL chain
 * (createEventInvoiceDraft → issueEventInvoiceAsPaid, no-TIN buyer)
 * pins pdf_template_version = CURRENT on the row and the §105
 * receipt bytes carry "มาตรา 105" — proving new issuance is wired to
 * the bumped constant end-to-end, not just at the template boundary.
 *
 * Thai-shaping note: shapeThai may inject ZWSP (U+200B) at break
 * points, so Thai matchers tolerate [\s​]* between tokens (same
 * posture as event-invoice-pdf-golden.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PDFParse } from 'pdf-parse';
import { runInTenant } from '@/lib/db';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type {
  PdfDocKind,
  PdfRenderInput,
} from '@/modules/invoicing/application/ports/pdf-render-port';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { KIND_AWARE_CITATION_MIN_VERSION } from '@/modules/invoicing/infrastructure/pdf/templates/revenue-code-citation';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueEventInvoiceAsPaid,
  type IssueEventInvoiceAsPaidDeps,
} from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';
import type { InvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

// --- Citation matchers (ZWSP-tolerant) --------------------------------------
const RX_S86_4 = /มาตรา[\s​]*86\/4/;
const RX_S86_10 = /มาตรา[\s​]*86\/10/;
const RX_S105 = /มาตรา[\s​]*105/;
const RX_S105_BIS = /105[\s​]*ทวิ/;

/** SIMULATED PII only — mirrors pdf-deterministic.test.ts makeInput. */
function makeLines(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000a1'),
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPrice: Money.fromSatangUnsafe(100_000n),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      total: Money.fromSatangUnsafe(100_000n),
      position: 1,
    },
  ];
}

function makeInput(kind: PdfDocKind, templateVersion: number): PdfRenderInput {
  const docR = DocumentNumber.of('SC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind,
    templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: 'Simulated Footer Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'Sim Contact',
      primary_contact_email: 'sim@footer.test',
      member_number: null,
      member_number_display: null,
    },
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

async function renderText(input: PdfRenderInput): Promise<string> {
  const { bytes } = await reactPdfRenderAdapter.render(input);
  expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  return extractPdfText(bytes);
}

const V_NEW = KIND_AWARE_CITATION_MIN_VERSION;

describe('T31 §A — kind-aware footer citation at v3 (adapter goldens, no DB)', () => {
  it("invoice → มาตรา 86/4 only (no 105, no 86/10)", async () => {
    const text = await renderText(makeInput('invoice', V_NEW));
    expect(text, 'invoice must cite §86/4').toMatch(RX_S86_4);
    expect(text, 'invoice must NOT cite §105').not.toMatch(RX_S105);
    expect(text, 'invoice must NOT cite §86/10').not.toMatch(RX_S86_10);
  }, 60_000);

  it('invoice_preview → มาตรา 86/4 (same document class as invoice)', async () => {
    const text = await renderText(makeInput('invoice_preview', V_NEW));
    expect(text).toMatch(RX_S86_4);
    expect(text).not.toMatch(RX_S105);
  }, 60_000);

  it('receipt_combined → มาตรา 86/4 และ 105ทวิ (BOTH present)', async () => {
    const text = await renderText(makeInput('receipt_combined', V_NEW));
    expect(text, 'combined doc must cite §86/4').toMatch(RX_S86_4);
    expect(text, 'combined doc must cite §105ทวิ').toMatch(RX_S105_BIS);
  }, 60_000);

  it('receipt_separate → มาตรา 105 only (no 86/4, no ทวิ)', async () => {
    const text = await renderText(makeInput('receipt_separate', V_NEW));
    expect(text, '§105 receipt must cite §105').toMatch(RX_S105);
    expect(text, '§105 receipt must NOT cite §86/4').not.toContain('86/4');
    expect(text, '§105 receipt must NOT cite §105ทวิ').not.toMatch(RX_S105_BIS);
  }, 60_000);

  it('credit_note → มาตรา 86/10 only (no 86/4)', async () => {
    const input: PdfRenderInput = {
      ...makeInput('credit_note', V_NEW),
      creditNote: {
        originalDocumentNumber: 'SC-2026-000042',
        originalIssueDate: '2026-03-01',
        reason: 'Membership cancelled mid-year',
      },
    };
    const text = await renderText(input);
    expect(text, 'credit note must cite §86/10').toMatch(RX_S86_10);
    expect(text, 'credit note must NOT cite §86/4').not.toContain('86/4');
  }, 60_000);

  it('void over receipt_separate → มาตรา 105 (citation follows the voided document, kind-true)', async () => {
    const input: PdfRenderInput = {
      ...makeInput('void_stamped_invoice', V_NEW),
      voidReason: 'golden probe',
      voidUnderlyingKind: 'receipt_separate',
    };
    const text = await renderText(input);
    expect(text, 'void-over-§105-receipt must cite §105').toMatch(RX_S105);
    expect(text, 'void-over-§105-receipt must NOT cite §86/4').not.toContain('86/4');
    expect(text).toMatch(/VOID/);
  }, 60_000);

  it('void over receipt_combined → มาตรา 86/4 และ 105ทวิ', async () => {
    const input: PdfRenderInput = {
      ...makeInput('void_stamped_invoice', V_NEW),
      voidReason: 'golden probe',
      voidUnderlyingKind: 'receipt_combined',
    };
    const text = await renderText(input);
    expect(text).toMatch(RX_S86_4);
    expect(text).toMatch(RX_S105_BIS);
  }, 60_000);

  it('void with ABSENT underlying kind → มาตรา 86/4 (legacy fallback, mirrors pdfDocKind ?? "invoice")', async () => {
    const input: PdfRenderInput = {
      ...makeInput('void_stamped_invoice', V_NEW),
      voidReason: 'golden probe',
    };
    const text = await renderText(input);
    expect(text).toMatch(RX_S86_4);
    expect(text).not.toMatch(RX_S105);
  }, 60_000);
});

describe('T31 §A — OLD-VERSION regression: v1/v2 keep the legacy unconditional §86/4 footer (SC-003)', () => {
  it.each([1, 2])(
    'v%i receipt_separate → STILL the legacy §86/4 footer (NOT kind-aware) + structurally deterministic',
    async (v) => {
      const input = makeInput('receipt_separate', v);
      const a = await reactPdfRenderAdapter.render(input);
      const b = await reactPdfRenderAdapter.render(input);
      // Repo structural-equivalence standard (T017 known limitation:
      // sha-identity unattainable with @react-pdf v4 — byte LENGTH +
      // text is what Blob-cache keys + the legal-identity claim rely
      // on). Full pre/post-change byte evidence:
      // docs/Bug/065-t31-footer-{pre,post}change.txt.
      expect(b.bytes.byteLength).toBe(a.bytes.byteLength);

      const text = await extractPdfText(a.bytes);
      expect(text, `v${v} must keep the legacy §86/4 citation`).toMatch(RX_S86_4);
      expect(
        text,
        `v${v} must NOT pick up the kind-aware §105 citation`,
      ).not.toMatch(/เอกสารตามประมวลรัษฎากร/);
    },
    120_000,
  );

  it('v2 credit_note → STILL §86/4 (NOT §86/10)', async () => {
    const text = await renderText(makeInput('credit_note', 2));
    expect(text).toMatch(RX_S86_4);
    expect(text).not.toMatch(RX_S86_10);
  }, 60_000);

  it('v2 receipt_combined → STILL plain §86/4 (NO 105ทวิ suffix)', async () => {
    const text = await renderText(makeInput('receipt_combined', 2));
    expect(text).toMatch(RX_S86_4);
    expect(text).not.toMatch(RX_S105_BIS);
  }, 60_000);

  it('v2 void over receipt_separate → STILL §86/4 (kind-true citation only at v3+; pinned re-renders preserved)', async () => {
    const input: PdfRenderInput = {
      ...makeInput('void_stamped_invoice', 2),
      voidReason: 'golden probe',
      voidUnderlyingKind: 'receipt_separate',
    };
    const text = await renderText(input);
    expect(text).toMatch(RX_S86_4);
    expect(text).not.toMatch(/เอกสารตามประมวลรัษฎากร/);
  }, 60_000);
});

// =============================================================================
// §B — live-Neon as-paid β sanity: new issuance pins CURRENT_TEMPLATE_VERSION on the row and the
// §105 receipt bytes carry มาตรา 105. SIMULATED buyer only (fake PII).
// =============================================================================

const B_NOW_ISO = '2026-06-11T10:00:00Z';
const B_PAYMENT_DATE = '2026-03-02';
const B_TOTAL_SATANG = 107_000;

const B_BUYER_NO_TIN = {
  legal_name: 'Simulated Footer Walk-in',
  tax_id: null,
  address: '99 Simulated Lane, Bangkok 10110',
  primary_contact_name: 'Sim Footer',
  primary_contact_email: 'sim.footer@t31-footer-golden.test',
} as const;

function makeAsPaidDeps(
  tenantSlug: string,
  capturedBytes: Uint8Array[],
): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
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
    audit: f4AuditAdapter,
    clock: { nowIso: () => B_NOW_ISO },
    outbox: resendEmailOutboxAdapter,
    // The REAL constant — this is the point of §B: the bumped version
    // flows from the registry into the row pin + the rendered bytes.
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
  };
}

describe('T31 §B — as-paid β issue pins CURRENT + §105 footer (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let draftNoTin: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'หอการค้าจำลอง',
        legalNameEn: 'Simulated Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'กรุงเทพมหานคร',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'FCG',
        creditNoteNumberPrefix: 'FCGC',
        receiptNumberPrefix: 'FCR',
      });
    });

    const eventId = randomUUID();
    const regNoTin = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: `evt-t31-footer-${eventId.slice(0, 8)}`,
        name: 'Footer Citation Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);
      await tx.insert(eventRegistrations).values([
        {
          tenantId: tenant.ctx.slug,
          eventId,
          registrationId: regNoTin,
          externalId: `att-t31-notin-${regNoTin.slice(0, 8)}`,
          attendeeName: 'Sim Footer',
          attendeeCompany: 'Simulated Footer Walk-in',
          attendeeEmail: B_BUYER_NO_TIN.primary_contact_email,
          matchType: 'non_member' as const,
          ticketType: 'Standard',
          ticketPriceThb: 1070,
          paymentStatus: 'paid' as const,
          registeredAt: new Date('2026-01-20T03:00:00Z'),
        },
      ] satisfies NewEventRegistrationRow[]);
    });

    const res = await createEventInvoiceDraft(
      makeCreateEventInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-t31-footer-draft-${regNoTin}`,
        eventRegistrationId: regNoTin,
        amountOverride: B_TOTAL_SATANG,
        buyer: B_BUYER_NO_TIN,
      },
    );
    if (!res.ok) throw new Error(`t31 draft failed: ${res.error.code}`);
    draftNoTin = res.value.invoiceId;
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('no-TIN as-paid → row pins pdf_template_version = CURRENT + bytes cite มาตรา 105 (not 86/4)', async () => {
    const capturedBytes: Uint8Array[] = [];
    const deps = makeAsPaidDeps(tenant.ctx.slug, capturedBytes);
    const res = await issueEventInvoiceAsPaid(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-t31-footer-aspaid-${draftNoTin}`,
      invoiceId: draftNoTin,
      paymentDate: B_PAYMENT_DATE,
      paymentMethod: 'cash',
    });
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('as-paid failed');

    // Row pin — the bumped registry constant reached the persisted row.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          pdfTemplateVersion: invoices.pdfTemplateVersion,
          pdfDocKind: invoices.pdfDocKind,
        })
        .from(invoices)
        .where(eq(invoices.invoiceId, draftNoTin)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pdfDocKind).toBe('receipt_separate');
    expect(rows[0]!.pdfTemplateVersion).toBe(CURRENT_TEMPLATE_VERSION);
    expect(rows[0]!.pdfTemplateVersion).toBeGreaterThanOrEqual(
      KIND_AWARE_CITATION_MIN_VERSION,
    );

    // Bytes — the §105 receipt carries the kind-true citation.
    expect(capturedBytes).toHaveLength(1);
    const text = await extractPdfText(capturedBytes[0]!);
    expect(text, 'live §105 receipt must cite มาตรา 105').toMatch(RX_S105);
    expect(text, 'live §105 receipt must NOT cite §86/4').not.toContain('86/4');
    expect(text).toContain('ใบเสร็จรับเงิน');
    expect(text).not.toMatch(/Tax Invoice/i);
  }, 120_000);
});
