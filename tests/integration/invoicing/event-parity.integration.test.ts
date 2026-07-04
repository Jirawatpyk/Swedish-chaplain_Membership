/**
 * 088-invoice-tax-flow-redesign (T049 / US7 — FR-006) — event-fee invoice/
 * receipt parity + the §105/§86-4 register SPLIT (live Neon Singapore).
 *
 * US7 acceptance scenarios, proven SIDE-BY-SIDE inside ONE tenant whose §86/4
 * receipt prefix is configured to 'RC' (the whole point — the split must hold
 * even when 'RC' is the tenant's §86/4 prefix):
 *
 *   AS1 (event-WITH-TIN): the buyer can claim input VAT, so payment mints the
 *        combined §86/4 tax receipt (`receipt_combined`) from the §86/4 'RC'
 *        receipt register (documentType 'receipt') — EXACT parity with a
 *        membership payment. Number: RC-2026-000001.
 *
 *   AS2 (event-WITHOUT-TIN): the legal identity is UNCHANGED — a §105
 *        ใบเสร็จรับเงิน (`receipt_separate`) issued at payment. Its number comes
 *        from the SEPARATE `receipt_105` register with a HARDCODED 'RE' prefix
 *        (US7/T050), NOT the §86/4 'RC' register — so a §105 receipt can never
 *        pollute the §86/4/§87 'RC' stream (un-renumberable §87 pollution was
 *        the M1 ship-gate blocker). Number: RE-2026-000001.
 *
 * The DISJOINT-register proof is the core value: with 'RC' configured, an
 * event-WITH-TIN payment advances ONLY the 'receipt' (RC) register while an
 * event-WITHOUT-TIN payment advances ONLY the 'receipt_105' (RE) register —
 * neither touches the other, and neither burns the §87 'invoice' stream. Each
 * `it` asserts the split from its own side (order-independent).
 *
 * Both issuances go through the as-paid use case (`issueEventInvoiceAsPaid`):
 * AS1 with `taxAtPayment=true` (the 088 §86/4-at-payment flow, mirroring
 * record-payment's RC allocation); AS2's §105 arm is independent of the flag.
 *
 * Lives in tests/integration/** → hits live Neon. Migration 0230 (document_type
 * += 'receipt_105') MUST be applied first (`pnpm db:migrate`). All buyers are
 * SIMULATED (fake names + fake 13-digit TINs) — never real PII.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import {
  createEventInvoiceDraft,
  type CreateEventInvoiceDraftInput,
} from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueEventInvoiceAsPaid,
  type IssueEventInvoiceAsPaidDeps,
} from '@/modules/invoicing/application/use-cases/issue-event-invoice-as-paid';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { TaxAtPaymentFlag } from '@/modules/invoicing';
import type {
  DocumentTypeCode,
  SequenceAllocatorPort,
} from '@/modules/invoicing/application/ports/sequence-allocator-port';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { InvoiceId } from '@/modules/invoicing/domain/invoice';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

// Fixed Bangkok-safe clock ("today") + an out-of-band payment settled a few
// days earlier; both land in FY 2026 under fiscalYearStartMonth=1.
const NOW_ISO = '2026-06-10T10:00:00Z';
const PAYMENT_DATE = '2026-06-07';
const FY = 2026;

/** SIMULATED non-member buyer WITH a fake 13-digit Thai TIN → receipt_combined. */
const BUYER_TIN: CreateEventInvoiceDraftInput['buyer'] = {
  legal_name: 'Simulated Parity Co Ltd',
  tax_id: '1234512345123',
  address: '123 Simulated Road, Bangkok 10110',
  primary_contact_name: 'Sim Buyer',
  primary_contact_email: 'sim.parity.tin@event-parity.test',
};

/** SIMULATED non-member walk-in buyer (tax_id null) → §105 receipt_separate. */
const BUYER_NO_TIN: CreateEventInvoiceDraftInput['buyer'] = {
  legal_name: 'Simulated Parity Walk-in',
  tax_id: null,
  address: '99 Simulated Lane, Bangkok 10110',
  primary_contact_name: 'Sim Walkin',
  primary_contact_email: 'sim.parity.notin@event-parity.test',
};

/** Records each documentType the (real) allocator is asked for. */
type AllocSpy = ReturnType<typeof makeAllocSpy>;
function makeAllocSpy() {
  return vi.fn(
    (
      tx: unknown,
      args: Parameters<SequenceAllocatorPort['allocateNext']>[1],
    ): Promise<number> => postgresSequenceAllocator.allocateNext(tx, args),
  );
}

/**
 * REAL repos / allocator / identity / audit / outbox + mocked PDF + Blob. The
 * allocator is the REAL postgres allocator wrapped in a spy so tests can assert
 * the exact `documentType` each stream was asked for (the split proof), while
 * still allocating deterministically against live Neon.
 */
function makeDeps(
  tenantSlug: string,
  opts: { taxAtPayment: TaxAtPaymentFlag; allocSpy: AllocSpy; captured?: PdfRenderInput[] },
): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: { allocateNext: opts.allocSpy },
    pdfRender: {
      render: vi.fn(async (renderInput: PdfRenderInput) => {
        opts.captured?.push(renderInput);
        return {
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
          sha256: Sha256Hex.ofUnsafe('d'.repeat(64)),
        };
      }),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
    audit: f4AuditAdapter,
    clock: { nowIso: () => NOW_ISO },
    outbox: resendEmailOutboxAdapter,
    // PDF is mocked here, so the pinned version only decorates the blob key —
    // v1 matches the sibling as-paid use-case integration tests.
    currentTemplateVersion: 1,
    taxAtPayment: opts.taxAtPayment,
  };
}

/** Seed one F6 event + one non-member registration; returns the registration id. */
async function seedRegistration(tenant: TestTenant, attendeeEmail: string): Promise<string> {
  const eventId = randomUUID();
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt-parity-${registrationId.slice(0, 8)}`,
      name: 'Event Parity Gala',
      startDate: new Date('2026-09-10T11:00:00Z'),
    } satisfies NewEventRow);
    await tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId,
      eventId,
      externalId: `att-parity-${registrationId.slice(0, 8)}`,
      attendeeEmail,
      attendeeName: 'Sim Attendee',
      attendeeCompany: 'Simulated Parity Co Ltd',
      matchType: 'non_member',
      ticketType: 'Standard',
      ticketPriceThb: 1070,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-09-01T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
  });
  return registrationId;
}

/** Create a genuine event draft via the REAL use-case; throws on err. */
async function createDraft(
  tenant: TestTenant,
  user: TestUser,
  registrationId: string,
  buyer: CreateEventInvoiceDraftInput['buyer'],
): Promise<InvoiceId> {
  const res = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
    tenantId: tenant.ctx.slug,
    actorUserId: user.userId,
    requestId: `int-parity-draft-${registrationId}`,
    eventRegistrationId: registrationId,
    amountOverride: 107000, // 1,070.00 THB inclusive
    buyer,
  });
  if (!res.ok) throw new Error(`draft failed: ${res.error.code}`);
  return res.value.invoiceId;
}

/** Register counter for (tenant, docType, fy) — null when never allocated. */
async function readCounter(
  tenantSlug: string,
  documentType: DocumentTypeCode,
  fiscalYear: number,
): Promise<number | null> {
  const [row] = await db
    .select()
    .from(tenantDocumentSequences)
    .where(
      and(
        eq(tenantDocumentSequences.tenantId, tenantSlug),
        eq(tenantDocumentSequences.documentType, documentType),
        eq(tenantDocumentSequences.fiscalYear, fiscalYear),
      ),
    );
  return row?.nextSequenceNumber ?? null;
}

describe('event parity + §105/§86-4 register split (US7/T049, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let draftTin: InvoiceId;
  let draftNoTin: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // §86/4 receipt prefix 'RC' — the split must hold DESPITE this: the §105
    // no-TIN arm still numbers from its own separate receipt_105/'RE' register.
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าจำลอง',
      legalNameEn: 'Simulated Chamber',
      registeredAddressTh: 'Bangkok',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'EVP',
      creditNoteNumberPrefix: 'EVPC',
      receiptNumberPrefix: 'RC',
    });
    const regTin = await seedRegistration(tenant, BUYER_TIN.primary_contact_email);
    const regNoTin = await seedRegistration(tenant, BUYER_NO_TIN.primary_contact_email);
    draftTin = await createDraft(tenant, user, regTin, BUYER_TIN);
    draftNoTin = await createDraft(tenant, user, regNoTin, BUYER_NO_TIN);
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('AS1 — event-WITH-TIN as-paid mints the §86/4 combined tax receipt from the RC register (documentType "receipt"); the separate receipt_105 register is UNTOUCHED', async () => {
    const receipt105Before = await readCounter(tenant.ctx.slug, 'receipt_105', FY);
    const allocSpy = makeAllocSpy();
    const captured: PdfRenderInput[] = [];
    const res = await issueEventInvoiceAsPaid(
      makeDeps(tenant.ctx.slug, { taxAtPayment: 'on', allocSpy, captured }),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-parity-as1-${draftTin}`,
        invoiceId: draftTin,
        paymentDate: PAYMENT_DATE,
        paymentMethod: 'cash',
      },
    );
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('AS1 as-paid failed');

    // Combined §86/4 tax receipt on the §86/4 'RC' receipt register — EXACT
    // parity with a membership payment.
    expect(res.value.pdfDocKind).toBe('receipt_combined');
    expect(res.value.receiptDocumentNumberRaw).toBe('RC-2026-000001');
    expect(res.value.documentNumber).toBeNull();
    expect(captured[0]?.kind).toBe('receipt_combined');
    expect(captured[0]?.documentNumber?.raw).toBe('RC-2026-000001');

    // The allocator was asked for the §86/4 'receipt' (RC) stream — NEVER the
    // separate §105 'receipt_105' register.
    expect(allocSpy).toHaveBeenCalledTimes(1);
    expect(allocSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'receipt', fiscalYear: FY }),
    );
    expect(allocSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'receipt_105' }),
    );

    // Split proof (AS1 side): a §86/4 payment NEVER advances the §105 register.
    expect(await readCounter(tenant.ctx.slug, 'receipt', FY)).toBe(2); // RC bootstrapped, next=2
    expect(await readCounter(tenant.ctx.slug, 'receipt_105', FY)).toBe(receipt105Before);
    // The shared §87 invoice stream is never burned for a receipt document.
    expect(await readCounter(tenant.ctx.slug, 'invoice', FY)).toBeNull();
  }, 90_000);

  it('AS2 — event-WITHOUT-TIN as-paid keeps the §105 ใบเสร็จรับเงิน numbered from the SEPARATE receipt_105/RE register (documentType "receipt_105"), NOT the §86/4 RC register; legal identity unchanged', async () => {
    const rcBefore = await readCounter(tenant.ctx.slug, 'receipt', FY);
    const allocSpy = makeAllocSpy();
    const captured: PdfRenderInput[] = [];
    const res = await issueEventInvoiceAsPaid(
      makeDeps(tenant.ctx.slug, { taxAtPayment: 'on', allocSpy, captured }),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-parity-as2-${draftNoTin}`,
        invoiceId: draftNoTin,
        paymentDate: PAYMENT_DATE,
        paymentMethod: 'cash',
      },
    );
    expect(res.ok, res.ok ? 'ok' : `as-paid err: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error('AS2 as-paid failed');

    // §105 legal identity UNCHANGED — a §105 ใบเสร็จรับเงิน (receipt_separate),
    // numbered 'RE-…' from the separate receipt_105 register, NEVER 'RC-…',
    // even though 'RC' is the configured §86/4 receipt prefix (US7/T050).
    expect(res.value.pdfDocKind).toBe('receipt_separate');
    expect(res.value.receiptDocumentNumberRaw).toBe('RE-2026-000001');
    expect(res.value.documentNumber).toBeNull();
    expect(res.value.sequenceNumber).toBeNull();
    expect(captured[0]?.kind).toBe('receipt_separate');
    expect(captured[0]?.documentNumber?.raw).toBe('RE-2026-000001');

    // The allocator was asked for the SEPARATE §105 'receipt_105' register —
    // NEVER the §86/4 'receipt' (RC) stream, NEVER the §87 'invoice' stream.
    expect(allocSpy).toHaveBeenCalledTimes(1);
    expect(allocSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'receipt_105', fiscalYear: FY }),
    );
    expect(allocSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'receipt' }),
    );
    expect(allocSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'invoice' }),
    );

    // Split proof (AS2 side, order-independent): a §105 payment NEVER advances
    // the §86/4 'RC' register — it stays exactly where AS1 (or nothing) left it.
    expect(await readCounter(tenant.ctx.slug, 'receipt', FY)).toBe(rcBefore);
    expect(await readCounter(tenant.ctx.slug, 'receipt_105', FY)).toBe(2); // RE bootstrapped, next=2
    expect(await readCounter(tenant.ctx.slug, 'invoice', FY)).toBeNull();
  }, 90_000);
});

/**
 * 088 US7 (review fix, live Neon) — DEFAULT (NULL)-prefix collision regression.
 *
 * The §86/4 RC-role receipt register and the §105 `receipt_105` register both
 * write into `invoices.receipt_document_number_raw` and share ONE partial
 * unique index `invoices_tenant_receipt_raw_uniq (tenant_id,
 * receipt_document_number_raw)` (NOT partitioned by document_type). Each is a
 * SEPARATE counter starting at seq 1 per fiscal year. The §105 register uses a
 * HARDCODED 'RE' prefix; the §86/4 receipt register falls back to a DEFAULT
 * prefix when `receiptNumberPrefix` is NULL (the shipped default config).
 *
 * Pre-fix that default fell back to 'RE' too — so on a NULL-prefix tenant a
 * §86/4 receipt (RE-{fy}-000001) and a §105 receipt (RE-{fy}-000001) rendered
 * the SAME raw and the second commit hit 23505 (untranslated 500 → the §105
 * receipt could not be issued). The fix makes the §86/4 default 'RC', disjoint
 * from the §105 'RE', so both issue with DISTINCT raws.
 *
 * Unlike the sibling describe above (which pins `receiptNumberPrefix: 'RC'`),
 * this tenant OMITS the prefix so the NULL→default path is exercised — the
 * exact scenario a future MTA tenant on the shipped default config hits.
 */
describe('DEFAULT (NULL)-prefix tenant: §86/4 RC-role + §105 receipts do not collide (US7 regression, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let draftTin: InvoiceId;
  let draftNoTin: InvoiceId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // receiptNumberPrefix OMITTED → NULL (the shipped default config). The §86/4
    // 'receipt' register falls back to 'RC'; the §105 'receipt_105' register is
    // hardcoded 'RE'. Pre-fix both fell back to 'RE' → 23505 on the 2nd commit.
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าจำลอง',
      legalNameEn: 'Simulated Chamber',
      registeredAddressTh: 'Bangkok',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'EVP',
      creditNoteNumberPrefix: 'EVPC',
      // receiptNumberPrefix omitted on purpose → exercises the NULL default.
    });
    const regTin = await seedRegistration(tenant, BUYER_TIN.primary_contact_email);
    const regNoTin = await seedRegistration(tenant, BUYER_NO_TIN.primary_contact_email);
    draftTin = await createDraft(tenant, user, regTin, BUYER_TIN);
    draftNoTin = await createDraft(tenant, user, regNoTin, BUYER_NO_TIN);
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('issues a §86/4 combined tax receipt (RC-…) AND a §105 receipt (RE-…) with DISTINCT receipt_document_number_raw — no unique-index collision', async () => {
    // §86/4 combined (TIN buyer, taxAtPayment) → 'receipt' register, NULL→'RC'.
    const res1 = await issueEventInvoiceAsPaid(
      makeDeps(tenant.ctx.slug, { taxAtPayment: 'on', allocSpy: makeAllocSpy() }),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-parity-collide-tin-${draftTin}`,
        invoiceId: draftTin,
        paymentDate: PAYMENT_DATE,
        paymentMethod: 'cash',
      },
    );
    expect(res1.ok, res1.ok ? 'ok' : `§86/4 as-paid err: ${JSON.stringify(res1)}`).toBe(true);
    if (!res1.ok) throw new Error('§86/4 as-paid failed');
    // NULL default now falls back to 'RC' (disjoint from §105's 'RE').
    expect(res1.value.pdfDocKind).toBe('receipt_combined');
    expect(res1.value.receiptDocumentNumberRaw).toBe('RC-2026-000001');

    // §105 (no-TIN buyer) → separate receipt_105 register, hardcoded 'RE'. Same
    // tenant + fiscal year. Pre-fix THIS commit hit 23505 against the §86/4
    // 'RE-2026-000001' the first issuance would have taken under the old default.
    const res2 = await issueEventInvoiceAsPaid(
      makeDeps(tenant.ctx.slug, { taxAtPayment: 'on', allocSpy: makeAllocSpy() }),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-parity-collide-notin-${draftNoTin}`,
        invoiceId: draftNoTin,
        paymentDate: PAYMENT_DATE,
        paymentMethod: 'cash',
      },
    );
    expect(res2.ok, res2.ok ? 'ok' : `§105 as-paid err: ${JSON.stringify(res2)}`).toBe(true);
    if (!res2.ok) throw new Error('§105 as-paid failed');
    expect(res2.value.pdfDocKind).toBe('receipt_separate');
    expect(res2.value.receiptDocumentNumberRaw).toBe('RE-2026-000001');

    // The crux: the two raws are DISTINCT, so both rows satisfy
    // invoices_tenant_receipt_raw_uniq — no 23505.
    expect(res1.value.receiptDocumentNumberRaw).not.toBe(res2.value.receiptDocumentNumberRaw);
  }, 90_000);
});
