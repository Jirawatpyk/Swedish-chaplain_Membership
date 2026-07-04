/**
 * Task 8 (054-event-fee-invoices) — issueCreditNote for a NON-member EVENT-fee
 * invoice (live Neon Singapore via .env.local).
 *
 * End-to-end through the REAL use-cases:
 *   createEventInvoiceDraft (non-member, pins buyer snapshot at DRAFT)
 *     → issueInvoice (Model B VAT-inclusive split stored at ISSUE)
 *     → recordPayment (issued → paid; works for non-member event invoices after
 *       final-review HIGH 2 — replaces the prior raw-SQL 'paid' workaround)
 *     → issueCreditNote (full credit)
 *
 * The buyer here carries a 13-digit TIN, so `issueInvoice` resolves kind
 * 'invoice' (ใบกำกับภาษี / §86/4 tax invoice) — NOT a §105 receipt_separate.
 * That makes this the REGRESSION case for final-review HIGH 1: a TIN-bearing
 * event invoice is a genuine §86/4 tax invoice and MUST stay creditable (only
 * the no-TIN receipt_separate path is blocked by `receipt_not_creditable`,
 * covered in credit-note-receipt-separate-blocked.test.ts).
 *
 * Asserts (per Task 8 spec):
 *   1. The credit note PERSISTS (creditNotes row) for a non-member event
 *      invoice (member_id NULL) — proving the removed `memberId === null →
 *      no_snapshot_on_invoice` bug guard no longer blocks it.
 *   2. VAT RECONCILES to the STORED split: a full credit of the inclusive
 *      total carries vat === the invoice's stored vat (calculateCreditNoteVat
 *      uses loaded.vat/loaded.total, NOT a recompute from lines), and
 *      credit_amount + vat === total on the CN row.
 *   3. `credit_note_issued` is emitted via the NON-timeline branch — the
 *      persisted audit payload has NO `member_id` key and HAS
 *      `event_registration_id`.
 *   4. The parent invoice flips paid → credited.
 *   5. `getInvoiceForPayment` returns `not_payable` (NOT a crash / forbidden)
 *      for the same non-member event invoice — proving the widened
 *      `memberId: string | null` DTO + the boundary guard hold against live
 *      data.
 *
 * PDF render + Blob upload + outbox are mocked (fast); DB + sequence allocator
 * + RLS + the real F4 audit adapter are live so the tax-document (§87) path is
 * genuinely exercised. Migrations 0200–0203 MUST be applied (`pnpm db:migrate`).
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
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';
import { makeCreateEventInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  recordPayment,
  type RecordPaymentDeps,
} from '@/modules/invoicing/application/use-cases/record-payment';
import { makeRecordPaymentDeps } from '@/modules/invoicing/application/invoicing-deps';
import {
  issueCreditNote,
  type IssueCreditNoteDeps,
} from '@/modules/invoicing/application/use-cases/issue-credit-note';
import { getInvoiceForPayment } from '@/modules/invoicing/application/use-cases/get-invoice-for-payment';
import { makeGetInvoiceDeps } from '@/modules/invoicing/application/invoicing-deps';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';

// Non-member buyer WITH a Thai TIN + a contact email (so the credit-note
// auto-email enqueues — proving the guard is on email, not memberId).
const BUYER = {
  legal_name: 'Beta Imports Ltd',
  tax_id: '9876543210123',
  address: '50 Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Jane Doe',
  primary_contact_email: 'jane@beta.example',
} as const;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function makeIssueDeps(tenantSlug: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: makeCreateEventInvoiceDraftDeps(tenantSlug).memberIdentity,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe('b'.repeat(64)) })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as IssueInvoiceDeps['blob'],
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-18T10:00:00Z' },
    outbox: { enqueue: vi.fn(async () => {}) },
    currentTemplateVersion: 1,
    taxAtPayment: 'off',
  };
}

function makeCreditNoteDeps(tenantSlug: string): {
  deps: IssueCreditNoteDeps;
  outboxEnqueue: ReturnType<typeof vi.fn>;
} {
  const outboxEnqueue = vi.fn(async () => {});
  const deps: IssueCreditNoteDeps = {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantSlug),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantSlug),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe('c'.repeat(64)) })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as IssueCreditNoteDeps['blob'],
    audit: f4AuditAdapter,
    clock: { nowIso: () => '2026-04-20T10:00:00Z' },
    outbox: { enqueue: outboxEnqueue },
    currentTemplateVersion: 1,
  };
  return { deps, outboxEnqueue };
}

/**
 * Real recordPayment composition root with PDF/Blob mocked + the async-receipt
 * flag forced OFF (the shared integration setup forces it ON, which skips the
 * inline receipt render). Also pins `taxAtPayment: false` — this seed pays a
 * direct-inserted LEGACY §86/4-at-issue invoice, which under the ambient
 * FEATURE_088_TAX_AT_PAYMENT=true (dev/local) would be rejected by the FR-017
 * guard with `legacy_invoice_needs_reissue`; the legacy flow is this test's
 * intent (a paid creditable §86/4). We only need the invoice to reach `paid` so
 * the credit-note status guard passes — no assertions on the receipt itself.
 */
function makeRecordPaymentDepsForPay(tenantSlug: string): RecordPaymentDeps {
  const real = makeRecordPaymentDeps(tenantSlug);
  const { receiptPdfRenderEnqueue: _omitEnqueue, ...rest } = real;
  void _omitEnqueue;
  return {
    ...rest,
    asyncReceiptPdf: false,
    // Decouple from the ambient 088 flag — see the docblock above.
    taxAtPayment: 'off',
    pdfRender: {
      render: vi.fn(async () => ({ bytes: PDF_BYTES, sha256: Sha256Hex.ofUnsafe('d'.repeat(64)) })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => PDF_BYTES),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    } as unknown as RecordPaymentDeps['blob'],
  };
}

describe('issueCreditNote — NON-member EVENT invoice (Task 8, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  let eventId: string;
  let regId: string;
  let invoiceId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    eventId = randomUUID();
    regId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'หอการค้า',
        legalNameEn: 'Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'EVT',
        creditNoteNumberPrefix: 'EVTC',
        // Auto-email enabled — proves the credit-note email enqueues for a
        // non-member buyer who DOES have a contact email.
        autoEmailEnabled: true,
      });

      await tx.insert(events).values({
        tenantId: tenant.ctx.slug,
        eventId,
        source: 'eventcreate',
        externalId: 'evt_cn_int',
        name: 'Annual Gala',
        startDate: new Date('2026-09-10T11:00:00Z'),
      } satisfies NewEventRow);

      await tx.insert(eventRegistrations).values({
        tenantId: tenant.ctx.slug,
        registrationId: regId,
        eventId,
        externalId: 'att_cn',
        attendeeEmail: 'jane@beta.example',
        attendeeName: 'Jane Doe',
        attendeeCompany: 'Beta Imports Ltd',
        matchType: 'non_member',
        ticketType: 'VIP',
        ticketPriceThb: 250,
        paymentStatus: 'paid',
        registeredAt: new Date('2026-09-01T03:00:00Z'),
      } satisfies NewEventRegistrationRow);
    });

    // 1) Draft (non-member, 250 THB inclusive → 25000 satang).
    const draft = await createEventInvoiceDraft(makeCreateEventInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cn-draft-${regId}`,
      eventRegistrationId: regId,
      buyer: BUYER,
    });
    if (!draft.ok) throw new Error(`draft failed: ${draft.error.code}`);
    invoiceId = draft.value.invoiceId;

    // 2) Issue (pins buyer snapshot + Model B stored VAT split).
    const issued = await issueInvoice(makeIssueDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `int-cn-issue-${invoiceId}`,
      invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued)}`);

    // 3) issued → paid via the REAL recordPayment use-case. Works for
    // non-member event invoices after final-review HIGH 2 (replaces the prior
    // raw-SQL 'paid' workaround) — exercises the genuine §86/4 receipt path so
    // the credit-note status guard sees a real paid invoice. The buyer's TIN
    // means issue resolved kind 'invoice', so this stays a creditable §86/4
    // document (the HIGH 1 block applies only to the no-TIN receipt_separate).
    const paid = await runInTenant(tenant.ctx, async () =>
      recordPayment(makeRecordPaymentDepsForPay(tenant.ctx.slug), {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `int-cn-pay-${invoiceId}`,
        invoiceId,
        paymentMethod: 'bank_transfer',
        paymentReference: 'seed-ref',
        paymentDate: '2026-04-19',
      }),
    );
    if (!paid.ok) throw new Error(`pay failed: ${JSON.stringify(paid)}`);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function readInvoiceRow() {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
    return row;
  }

  it('full credit persists a CN, reconciles VAT to the stored split, flips invoice → credited, emits non-timeline audit', async () => {
    const before = await readInvoiceRow();
    expect(before!.status).toBe('paid');
    expect(before!.memberId).toBeNull(); // non-member event invoice
    const storedTotal = BigInt(before!.totalSatang!.toString());
    const storedVat = BigInt(before!.vatSatang!.toString());
    expect(storedTotal).toBe(25_000n);

    const { deps, outboxEnqueue } = makeCreditNoteDeps(tenant.ctx.slug);
    const cnReqId = `int-cn-issue-cn-${invoiceId}`;
    const r = await issueCreditNote(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: cnReqId,
      invoiceId,
      creditTotalSatang: storedTotal, // full
      reason: 'event cancelled',
    });
    expect(r.ok, r.ok ? 'ok' : `cn err: ${JSON.stringify(r)}`).toBe(true);
    if (!r.ok) throw new Error('cn failed');

    // (1) CN row persisted.
    const [cnRow] = await db
      .select()
      .from(creditNotes)
      .where(
        and(eq(creditNotes.tenantId, tenant.ctx.slug), eq(creditNotes.originalInvoiceId, invoiceId)),
      );
    expect(cnRow).toBeDefined();

    // (2) VAT reconciles to the STORED split (full credit → vat === stored vat).
    const cnTotal = BigInt(cnRow!.totalSatang.toString());
    const cnVat = BigInt(cnRow!.vatSatang.toString());
    const cnCredit = BigInt(cnRow!.creditAmountSatang.toString());
    expect(cnTotal).toBe(storedTotal);
    expect(cnVat).toBe(storedVat);
    expect(cnCredit + cnVat).toBe(cnTotal);

    // (4) Parent invoice flips paid → credited (full credit).
    const after = await readInvoiceRow();
    expect(after!.status).toBe('credited');

    // (3) Audit: non-member → NON-timeline credit_note_issued (no member_id,
    // has event_registration_id).
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'credit_note_issued'),
          eq(auditLog.requestId, cnReqId),
        ),
      );
    expect(auditRow).toBeDefined();
    const payload = auditRow!.payload as Record<string, unknown>;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe(regId);
    expect(payload.original_invoice_id).toBe(invoiceId);

    // Credit-note email enqueued (buyer has a contact email).
    expect(outboxEnqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'credit_note_issued', recipientEmail: 'jane@beta.example' }),
    );
  }, 90_000);

  it('getInvoiceForPayment returns not_payable (not crash/forbidden) for the non-member event invoice', async () => {
    // The widened DTO (`memberId: string | null`) + the boundary guard:
    // a null-member event invoice is surfaced as a typed not_payable, never a
    // null deref or a forbidden probe (no actor here → admin/no-actor path).
    const result = await getInvoiceForPayment(makeGetInvoiceDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      invoiceId,
      taxAtPayment: 'off', reconciliationPath: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_payable');
  }, 60_000);
});
