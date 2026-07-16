/**
 * CP-4.2 — record-payment Application-layer branch coverage.
 *
 * Principle II security-critical — hits 100% branch.
 *
 * Branches:
 *  1. invoice_not_found (raw SQL FOR UPDATE returns []) — skipped: we
 *     mock findByIdInTx null to hit the second `!loaded` branch
 *  2. invoice_not_found (findByIdInTx returns null)
 *  3. Idempotent replay — status=paid returns row without re-doing work
 *  4. invalid_status (status=draft/void/credited)
 *  5. no_snapshot_on_invoice (issued invoice missing snapshots)
 *  6. no_snapshot_on_invoice (settings missing)
 *  7. separate numbering — allocates receipt seq
 *  8. combined numbering — no receipt seq
 *  9. auto_email on/off
 *
 * FR-038: confirm receipt render uses PINNED identity snapshot (not
 * re-read from the live member module). The use case MUST pass
 * `loaded.memberIdentitySnapshot` to `pdfRender.render`, never a fresh
 * adapter call.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  recordPayment,
  recordPaymentSchema,
} from '@/modules/invoicing/application/use-cases/record-payment';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import type { InvoiceFixtureOverrides } from '../../helpers/invoice-fixture-overrides';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';
import { invoicingMetrics } from '@/lib/metrics';
import { membershipAccessStub } from '../../helpers/membership-access-stub';

const INVOICE_ID = '00000000-0000-0000-0000-00000000e002';

function makeIssuedInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
  const line: InvoiceLine = {
    lineId: asInvoiceLineId('line-1'),
    kind: 'membership_fee',
    descriptionTh: 'ค่าสมาชิก',
    descriptionEn: 'Membership',
    unitPrice: Money.fromTHB(1000),
    quantity: '1.0000',
    proRateFactor: '1.0000',
    total: Money.fromTHB(1000),
    position: 1,
  };

  const docNumR = DocumentNumber.of('SC', 2026, 42);
  if (!docNumR.ok) throw new Error('fixture');

  return {
    tenantId: 'test-swecham',
    invoiceId: asInvoiceId(INVOICE_ID),
    memberId: 'member-1',
    planId: 'corporate-regular',
    planYear: 2026,
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
    status: 'issued',
    draftByUserId: 'actor-user',
    fiscalYear: 2026 as never,
    sequenceNumber: 42,
    documentNumber: docNumR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromTHB(1000),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromTHB(70),
    total: Money.fromTHB(1070),
    creditedTotal: Money.zero(),
    proRatePolicy: 'monthly',
    netDays: 30,
    tenantIdentitySnapshot: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    memberIdentitySnapshot: {
      legal_name: 'Acme Co',
      // Snapshot was taken AT ISSUE TIME. FR-038 — the live member can
      // change tax_id afterwards; the receipt MUST render this value.
      tax_id: 'snapshot-tax-at-issue',
      address: '123 Road',
      primary_contact_name: 'John',
      primary_contact_email: 'john@acme.example',
    },
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: {
      blobKey: `invoicing/test-swecham/2026/${INVOICE_ID}_v1.pdf`,
      sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      templateVersion: 1,
    },
    lines: [line],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

function makeSettings(overrides: Partial<TenantInvoiceSettingsView> = {}): TenantInvoiceSettingsView {
  return {
    tenantId: 'test-swecham',
    currencyCode: 'THB',
    vatRate: VatRate.ofUnsafe('0.0700'),
    registrationFeeSatang: asSatang(500000n),
    invoiceNumberPrefix: 'SC',
    creditNoteNumberPrefix: 'CN',
    receiptNumberingMode: 'combined',
    fiscalYearStartMonth: 1,
    defaultNetDays: 30,
    proRatePolicy: 'monthly',
    autoEmailEnabled: true,
    brandName: null,
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพฯ',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    ...overrides,
  };
}

function makeDeps(
  rowExists: boolean,
  draft: Invoice | null,
  settings: TenantInvoiceSettingsView | null,
  overrides: Partial<RecordPaymentDeps> = {},
): RecordPaymentDeps {
  const opaqueTx = {
    execute: vi.fn(async () => (rowExists ? [{ status: draft?.status ?? 'issued' }] : [])),
  };
  return {
    invoiceRepo: {
      withTx: vi.fn(async (fn) => fn(opaqueTx)),
      insertDraft: vi.fn(),
      findByIdInTx: vi.fn(async () => draft),
      findById: vi.fn(),
      list: vi.fn(),
        listPaged: vi.fn(),
      applyIssue: vi.fn(),
      deleteDraft: vi.fn(),
      // applyPayment echoes the input back as the updated invoice —
      // record-payment now uses the RETURNING value directly instead
      // of re-reading.
      applyPayment: vi.fn(async () =>
        draft ? ({ ...draft, status: 'paid' } as Invoice) : (null as unknown as Invoice),
      ),
      applyDraftUpdate: vi.fn(),
      // Return the draft's CURRENT status — `rowExists=false` means
      // the row doesn't exist (null), otherwise surface whatever
      // status the fixture was built with so the state-machine
      // branches all exercise correctly.
      findByIdInTxForUpdate: vi.fn(),
      lockForUpdate: vi.fn(async () =>
        rowExists ? ((draft?.status ?? 'issued') as InvoiceStatus) : null,
      ),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyReceiptPdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
      applyIssueAsPaid: vi.fn(),
    },
    // 066 §4.4(1) — default full access so the terminated-membership gate
    // never fires (findById also returns undefined here → gate short-circuits).
    membershipAccess: membershipAccessStub(),
    tenantSettingsRepo: {
      getForIssue: vi.fn(async () => settings),
      upsert: vi.fn(),
      withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
    },
    sequenceAllocator: {
      allocateNext: vi.fn(async () => 1),
    },
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('b'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    audit: {
      emit: vi.fn(async () => {}),
    },
    clock: {
      nowIso: () => '2026-05-18T10:00:00Z',
    },
    outbox: {
      enqueue: vi.fn(async () => {}),
    },
    memberIdentity: {
      getForIssue: vi.fn(),
      markRegistrationFeePaid: vi.fn(async () => {}),
    },
    // Email-locale audit 2026-07-16 — default no stored preference (→ 'en'),
    // preserving pre-fix behaviour for the existing assertions. Individual
    // tests override to assert the locale is threaded onto the outbox row.
    recipientLocale: {
      getMemberEmailLocale: vi.fn(async () => null),
    },
    currentTemplateVersion: 1,
    // Default: the flag is not carried (legacy/dormant), exact-equivalent of the
    // pre-refactor `undefined` — the stranded-funds guard (keyed on 'off') stays
    // dormant. Individual tests override with 'on'/'off' as needed.
    taxAtPayment: 'off',
    ...overrides,
  };
}

const input = {
  tenantId: 'test-swecham',
  actorUserId: 'actor-user',
  requestId: 'req-pay',
  invoiceId: INVOICE_ID,
  paymentMethod: 'bank_transfer' as const,
  paymentReference: 'TRX-123',
  paymentDate: '2026-05-18',
};

describe('recordPaymentSchema — paymentDate calendar validation', () => {
  it('schema — shape-valid but IMPOSSIBLE calendar dates rejected; real leap day accepted', () => {
    // `^\d{4}-\d{2}-\d{2}$` alone accepts 2026-02-31; with f088TaxAtPayment ON
    // that date reaches `fiscalYearFromUtcIso` → js-joda `Instant.parse` throws
    // RAW → an unhandled 500. The `.refine(isValidCalendarDate)` rejects it at
    // parse (typed validation failure), never a thrown DateTimeException.
    expect(recordPaymentSchema.safeParse(input).success).toBe(true);
    expect(
      recordPaymentSchema.safeParse({ ...input, paymentDate: '2026-02-31' }).success,
    ).toBe(false);
    // 2027 is not a leap year.
    expect(
      recordPaymentSchema.safeParse({ ...input, paymentDate: '2027-02-29' }).success,
    ).toBe(false);
    // 2028 IS a leap year — Feb 29 must remain accepted.
    expect(
      recordPaymentSchema.safeParse({ ...input, paymentDate: '2028-02-29' }).success,
    ).toBe(true);
  });
});

describe('recordPayment — 066 §4.4(1) terminated-membership gate', () => {
  beforeEach(() => vi.clearAllMocks());

  // A payable ISSUED membership bill returned by the pre-tx findById read.
  function depsWithAccess(
    access: 'full' | 'suspended' | 'terminated',
    lookupOk = true,
  ): RecordPaymentDeps {
    const issued = makeIssuedInvoice({ status: 'issued' });
    const base = makeDeps(true, issued, makeSettings());
    return {
      ...base,
      invoiceRepo: { ...base.invoiceRepo, findById: vi.fn(async () => issued) },
      membershipAccess: {
        getMembershipAccess: vi.fn(async () =>
          lookupOk
            ? { ok: true as const, value: { access, reason: 'grace_expired' as const } }
            : { ok: false as const, error: { kind: 'membership_access.lookup_error' as const } },
        ),
      },
    };
  }

  it('terminated + admin-manual + membership → err membership_terminated (gate fires pre-tx)', async () => {
    const r = await recordPayment(depsWithAccess('terminated'), input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('membership_terminated');
  });

  it('suspended access → gate does NOT fire (not membership_terminated)', async () => {
    const r = await recordPayment(depsWithAccess('suspended'), input);
    if (!r.ok) expect(r.error.code).not.toBe('membership_terminated');
  });

  it('membership-access lookup ERROR → gate fails OPEN (payment not blocked)', async () => {
    // §4.4(1) fail-open: availability of the money path beats the gate;
    // the §4.4(2) heal-site net (keyed on in-tx cycle state, not the gate
    // result) is the durable backstop for any slip.
    const r = await recordPayment(depsWithAccess('terminated', /* lookupOk */ false), input);
    if (!r.ok) expect(r.error.code).not.toBe('membership_terminated');
  });

  it('webhook trigger → gate SKIPPED even for terminated (money already captured)', async () => {
    const r = await recordPayment(depsWithAccess('terminated'), {
      ...input,
      triggeredBy: 'webhook' as const,
    });
    if (!r.ok) expect(r.error.code).not.toBe('membership_terminated');
  });
});

describe('recordPayment — CP-4.2 branch coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invoice_not_found — row lock returns empty + emits invoice_cross_tenant_probe (R7-W1)', async () => {
    // R18-03 — settings must be present so the use case reaches
    // lockForUpdate; the pre-R18-03 ordering reached the lock check
    // even with null settings, but the corrected early-exit now
    // short-circuits at `settings_missing` when settings are null.
    // Intent of THIS test is the probe-emit path, not settings-missing.
    const deps = makeDeps(false, null, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'invoice_cross_tenant_probe',
        payload: expect.objectContaining({
          attempted_invoice_id: input.invoiceId,
          actor_role: 'admin',
          route: 'record-payment',
        }),
      }),
    );
  });

  it('invoice_not_found — findByIdInTx returns null after row exists (concurrent delete race)', async () => {
    const deps = makeDeps(true, null, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invoice_not_found');
  });

  it('idempotent replay — status=paid returns persisted row', async () => {
    const paid = makeIssuedInvoice({ status: 'paid' });
    const deps = makeDeps(true, paid, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('paid');
    // No seq allocator, no pdf render, no audit emit, no update UPDATE calls.
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  // Cluster 5 (review) — the idempotent replay does NOT re-attempt the email, so
  // it must REPORT the outcome the original attempt would have had. The derivation
  // mirrors the fresh path's arm precedence EXACTLY. The suppress arm is the
  // honesty fix: an F5-suppressed original must NOT replay as 'sent'.
  it('idempotent replay derives emailDispatch honestly across the fresh-path arms', async () => {
    // auto-email on, recipient present, NOT suppressed → 'sent'
    {
      const deps = makeDeps(true, makeIssuedInvoice({ status: 'paid' }), makeSettings({ autoEmailEnabled: true }));
      const r = await recordPayment(deps, input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.emailDispatch).toBe('sent');
    }
    // auto-email on, recipient present, SUPPRESSED (F5) → 'disabled' (the fix; a
    // suppressed original previously replayed as 'sent').
    {
      const deps = makeDeps(true, makeIssuedInvoice({ status: 'paid' }), makeSettings({ autoEmailEnabled: true }));
      const r = await recordPayment(deps, { ...input, suppressReceiptEmail: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.emailDispatch).toBe('disabled');
    }
    // auto-email OFF → 'disabled' regardless of recipient/suppress
    {
      const deps = makeDeps(true, makeIssuedInvoice({ status: 'paid' }), makeSettings({ autoEmailEnabled: false }));
      const r = await recordPayment(deps, input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.emailDispatch).toBe('disabled');
    }
    // auto-email on, NO recipient (empty-string sentinel) → 'skipped_no_email'
    {
      const noEmail = makeIssuedInvoice({
        status: 'paid',
        memberIdentitySnapshot: {
          legal_name: 'Acme Co',
          tax_id: 'snapshot-tax-at-issue',
          address: '123 Road',
          primary_contact_name: 'John',
          primary_contact_email: '',
          member_number: null,
          member_number_display: null,
        },
      });
      const deps = makeDeps(true, noEmail, makeSettings({ autoEmailEnabled: true }));
      const r = await recordPayment(deps, input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.emailDispatch).toBe('skipped_no_email');
    }
  });

  it('invalid_status — draft', async () => {
    const draft = makeIssuedInvoice({ status: 'draft' });
    const deps = makeDeps(true, draft, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_status');
      if (r.error.code === 'invalid_status') expect(r.error.status).toBe('draft');
    }
  });

  it('invalid_status — void', async () => {
    const voided = makeIssuedInvoice({ status: 'void' });
    const deps = makeDeps(true, voided, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_status');
  });

  it('no_snapshot_on_invoice — snapshot fields missing', async () => {
    const broken = makeIssuedInvoice({ tenantIdentitySnapshot: null });
    const deps = makeDeps(true, broken, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_snapshot_on_invoice');
  });

  it('settings_missing — tenant settings row absent at pay time', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), null);
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('settings_missing');
  });

  it('combined numbering — no receipt seq allocation', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings({ receiptNumberingMode: 'combined' }));
    // Re-mock findByIdInTx to return paid invoice on second call (after UPDATE).
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? makeIssuedInvoice() : makeIssuedInvoice({ status: 'paid', paidAt: '2026-05-18T10:00:00Z' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'receipt_combined' }),
    );
  });

  it('088 tax-at-payment — allocates the §87 RC receipt number + renders receipt_combined', async () => {
    // 088 T008/T018 — RC allocation is now FLAG-gated (`taxAtPayment`), not
    // settings-driven. A MEMBERSHIP receipt is receipt_combined (§86/4) — the
    // old separate-mode rendered it as receipt_separate, a §105 mislabel that
    // `inferReceiptKind` (D13) corrects.
    const deps = makeDeps(
      true,
      makeIssuedInvoice(),
      makeSettings({ receiptNumberingMode: 'separate' }),
      { taxAtPayment: 'on' },
    );
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? makeIssuedInvoice() : makeIssuedInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.sequenceAllocator.allocateNext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentType: 'receipt' }),
    );
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'receipt_combined' }),
    );
  });

  it('088 FR-030 — invoice_paid audit summary names the SC bill (not "Invoice undefined marked paid")', async () => {
    // record-payment.ts:820 — an 088 bill has NULL §87 `documentNumber`; the
    // summary must fall back to `billDocumentNumberRaw` (SC) so the audit trail
    // never reads "Invoice undefined marked paid". Pre-fix (documentNumber-only)
    // this string interpolated `undefined`. Paying under the flag ON is a valid
    // new-flow bill (documentNumber NULL → the FR-017 guard is skipped; the
    // symmetric OFF guard is skipped because the flag is ON), so the flow reaches
    // the audit emit.
    const bill = makeIssuedInvoice({
      documentNumber: null,
      sequenceNumber: null,
      billDocumentNumberRaw: 'SC-2026-000042',
    });
    const deps = makeDeps(
      true,
      bill,
      makeSettings({ receiptNumberingMode: 'separate' }),
      { taxAtPayment: 'on' },
    );
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1
        ? bill
        : makeIssuedInvoice({
            documentNumber: null,
            sequenceNumber: null,
            billDocumentNumberRaw: 'SC-2026-000042',
            status: 'paid',
          });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);

    const paidEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, e]) => (e as { eventType: string }).eventType === 'invoice_paid',
    );
    expect(paidEmit, 'expected an invoice_paid audit emit').toBeDefined();
    const summary = (paidEmit![1] as { summary: string }).summary;
    expect(summary).toContain('SC-2026-000042');
    expect(summary).not.toContain('undefined');
  });

  it('088 FR-017 — rejects a legacy §87-numbered invoice (no bill number) paid under the new flow', async () => {
    // Legacy shape: a §87 `document_number` (issued under the old flow) with NO
    // bill_document_number_raw. Paying it under the flag would mint a 2nd §87.
    const legacy = makeIssuedInvoice({ billDocumentNumberRaw: null });
    const deps = makeDeps(true, legacy, makeSettings(), { taxAtPayment: 'on' });
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => legacy);
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected legacy_invoice_needs_reissue');
    expect(r.error.code).toBe('legacy_invoice_needs_reissue');
    // Pre-sequence reject — no §87 receipt number burned, no payment applied.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyPayment).not.toHaveBeenCalled();
  });

  it('088 SEC-MED — rejects a new-flow bill paid after a flag ON→OFF rollback (no untaxed paid row)', async () => {
    // A NEW-flow bill: non-§87 SC number, NULL §87 document_number (issued while
    // the flag was ON). Paying it with the flag now OFF would reuse the NULL
    // §87 number → a paid membership with NO §87 tax number + NO tax_receipt.
    const newFlowBill = makeIssuedInvoice({
      documentNumber: null,
      sequenceNumber: null,
      billDocumentNumberRaw: 'SC-2026-000042',
    });
    const deps = makeDeps(true, newFlowBill, makeSettings(), { taxAtPayment: 'off' });
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => newFlowBill);
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected new_flow_bill_requires_flag_on');
    expect(r.error.code).toBe('new_flow_bill_requires_flag_on');
    // Pre-sequence reject — nothing minted, nothing applied.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyPayment).not.toHaveBeenCalled();
  });

  it('FR-038 — receipt PDF uses ISSUE-TIME member snapshot, NOT live value', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings());
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    // The render call's `member` param MUST be the invoice's frozen
    // snapshot — callers can mutate the live member module without
    // affecting the receipt.
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({
        member: expect.objectContaining({ tax_id: 'snapshot-tax-at-issue' }),
      }),
    );
  });

  it('auto_email enabled → outbox enqueued with receipt pdf key', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ autoEmailEnabled: true }));
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_paid',
        recipientEmail: 'john@acme.example',
      }),
    );
  });

  it('member prefers Thai → receipt-email outbox row carries recipientLocale=th (email-locale audit 2026-07-16)', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ autoEmailEnabled: true }));
    deps.recipientLocale.getMemberEmailLocale = vi.fn(async () => 'th' as const);
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    expect(deps.recipientLocale.getMemberEmailLocale).toHaveBeenCalledWith(
      expect.anything(),
      'test-swecham',
      'member-1',
    );
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_paid',
        recipientEmail: 'john@acme.example',
        recipientLocale: 'th',
      }),
    );
  });

  it('auto_email disabled → no outbox enqueue', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ autoEmailEnabled: false }));
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    await recordPayment(deps, input);
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('auto_email enabled but snapshot has NO recipient email → no enqueue + autoEmailSkipped metric bumps', async () => {
    // Observability parity (054 speckit-review) — the snapshot-missing-email
    // skip was previously a silent `logger.warn` only. Assert the dedicated
    // `autoEmailSkipped` counter bumps so ops can alert (matches the
    // issue-invoice + credit-note `skipped_no_recipient` surfaces).
    const skipMetric = vi.spyOn(invoicingMetrics, 'autoEmailSkipped');
    const invoice = makeIssuedInvoice({
      memberIdentitySnapshot: {
        legal_name: 'Acme Co',
        tax_id: 'snapshot-tax-at-issue',
        address: '123 Road',
        primary_contact_name: 'John',
        // Legacy/migrated snapshot row — no deliverable address (the snapshot
        // type's "no email" sentinel is '' per the zod union, not null).
        primary_contact_email: '',
        member_number: null,
        member_number_display: null,
      },
    });
    const deps = makeDeps(true, invoice, makeSettings({ autoEmailEnabled: true }));
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    // No enqueue without a recipient.
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
    // Metric bumped — membership subject (the fixture is a membership invoice).
    expect(skipMetric).toHaveBeenCalledWith('membership', 'no_recipient');
    skipMetric.mockRestore();
  });

  it('payment fields — optional reference / notes default null', async () => {
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings());
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeIssuedInvoice({ status: 'paid' });
    });
    const { paymentReference, ...rest } = input;
    void paymentReference;
    const r = await recordPayment(deps, { ...rest });
    expect(r.ok).toBe(true);
  });

  it('concurrent_state_change — applyPayment throws "no row updated" → typed error (race guard)', async () => {
    // Scenario: lockForUpdate observed status='issued' but another
    // transaction flipped the invoice to 'paid'/'void' between the
    // lock and applyPayment. The repo throws; the use case must
    // catch + map to the typed concurrent_state_change code so the
    // route layer returns 409 instead of a raw 500.
    const invoice = makeIssuedInvoice();
    const deps = makeDeps(true, invoice, makeSettings());
    deps.invoiceRepo.applyPayment = vi.fn(async () => {
      throw new InvoiceApplyConflictError('applyPayment');
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('concurrent_state_change');
  });

  it('idempotent replay does NOT call applyPayment (tautology-proof)', async () => {
    const paid = makeIssuedInvoice({ status: 'paid' });
    const deps = makeDeps(true, paid, makeSettings());
    await recordPayment(deps, input);
    expect(deps.invoiceRepo.applyPayment).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
  });

  it('flips registration_fee_paid when paid invoice contains registration_fee line (spec § 398)', async () => {
    const regFeeLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-2'),
      kind: 'registration_fee',
      descriptionTh: 'ค่าลงทะเบียนแรกเข้า',
      descriptionEn: 'Registration fee (one-off)',
      unitPrice: Money.fromTHB(5000),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromTHB(5000),
      position: 2,
    };
    const invoiceWithRegFee = makeIssuedInvoice({
      lines: [makeIssuedInvoice().lines[0]!, regFeeLine],
    });
    const deps = makeDeps(true, invoiceWithRegFee, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.memberIdentity.markRegistrationFeePaid).toHaveBeenCalledWith(
      expect.anything(),
      'test-swecham',
      'member-1',
    );
  });

  it('wave-3 S12 lock-order — markRegistrationFeePaid runs BEFORE the separate-mode receipt allocation (member→advisory, as-paid parity)', async () => {
    // The β as-paid path locks the member row (FOR UPDATE in
    // resolveInvoiceBuyerForIssue) BEFORE taking advisory('receipt') in
    // allocateNext. recordPayment used to take the pair in the OPPOSITE
    // order (advisory first, member-row UPDATE at the tail) — the AB-BA
    // 40P01 edge. The flip is hoisted above the allocation so both flows
    // order member→advisory; this pin keeps it that way.
    const regFeeLine: InvoiceLine = {
      lineId: asInvoiceLineId('line-order-pin'),
      kind: 'registration_fee',
      descriptionTh: 'ค่าลงทะเบียนแรกเข้า',
      descriptionEn: 'Registration fee (one-off)',
      unitPrice: Money.fromTHB(5000),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromTHB(5000),
      position: 2,
    };
    const invoiceWithRegFee = makeIssuedInvoice({
      lines: [makeIssuedInvoice().lines[0]!, regFeeLine],
    });
    const deps = makeDeps(
      true,
      invoiceWithRegFee,
      makeSettings({ receiptNumberingMode: 'separate' }),
      // 088 — RC allocation is flag-gated now; enable it so the member→advisory
      // lock-order assertion still exercises the allocation.
      { taxAtPayment: 'on' },
    );
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    const flipMock = deps.memberIdentity.markRegistrationFeePaid as ReturnType<typeof vi.fn>;
    const allocMock = deps.sequenceAllocator.allocateNext as ReturnType<typeof vi.fn>;
    expect(flipMock).toHaveBeenCalledTimes(1);
    expect(allocMock).toHaveBeenCalledTimes(1);
    expect(flipMock.mock.invocationCallOrder[0]!).toBeLessThan(
      allocMock.mock.invocationCallOrder[0]!,
    );
  });

  it('does NOT flip registration_fee_paid when invoice has only membership_fee line', async () => {
    const invoiceOnlyMembership = makeIssuedInvoice(); // default fixture has 1 membership line
    const deps = makeDeps(true, invoiceOnlyMembership, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.memberIdentity.markRegistrationFeePaid).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 054-event-fee-invoices (final-review HIGH 2) — NON-member EVENT invoice
  // support on the admin manual mark-paid path (spec §9 NF-B / Decision 7).
  // The relaxed null-member guard + the non-timeline audit branch + the
  // registration-fee / onPaid-callback null-member guards are NEW
  // security-critical branches → covered here.
  // ---------------------------------------------------------------------------

  /** A NON-member EVENT invoice: member_id NULL, subject 'event', VAT-inclusive,
   *  buyer pinned in the snapshot, single event_fee line. */
  function makeNonMemberEventInvoice(overrides: InvoiceFixtureOverrides = {}): Invoice {
    const eventLine: InvoiceLine = {
      lineId: asInvoiceLineId('evt-line-1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน',
      descriptionEn: 'Event ticket',
      unitPrice: Money.fromTHB(250),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromTHB(250),
      position: 1,
    };
    return makeIssuedInvoice({
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      vatInclusive: true,
      eventId: 'event-77',
      eventRegistrationId: 'reg-88',
      proRatePolicy: null,
      lines: [eventLine],
      memberIdentitySnapshot: {
        legal_name: 'Walk-in Buyer Co',
        tax_id: '9876543210123',
        address: '50 Sukhumvit Road',
        primary_contact_name: 'Jane',
        primary_contact_email: 'jane@buyer.example',
        member_number: null,
        member_number_display: null,
      },
      ...overrides,
    });
  }

  it('non-member EVENT invoice (member_id NULL) → recordPayment succeeds (relaxed guard, spec §9 NF-B)', async () => {
    const invoice = makeNonMemberEventInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ receiptNumberingMode: 'separate' }));
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeNonMemberEventInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok, r.ok ? 'ok' : `err: ${JSON.stringify(r)}`).toBe(true);
    // The receipt render uses the BUYER snapshot as `member`, never a deref of
    // a null member, and threads the event Model-B VAT-inclusive flag.
    expect(deps.pdfRender.render).toHaveBeenCalledWith(
      expect.objectContaining({
        // 088 D13 — an event-with-TIN buyer's receipt is receipt_combined
        // (§86/4), NOT receipt_separate (§105); `inferReceiptKind` fixes the
        // former settings-driven mislabel.
        kind: 'receipt_combined',
        vatInclusive: true,
        member: expect.objectContaining({ legal_name: 'Walk-in Buyer Co' }),
      }),
    );
  });

  it('non-member EVENT invoice → invoice_paid audit uses NON-timeline branch (no member_id, has event_registration_id)', async () => {
    const invoice = makeNonMemberEventInvoice();
    const deps = makeDeps(true, invoice, makeSettings({ receiptNumberingMode: 'separate' }));
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeNonMemberEventInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);

    const paidEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, e]) => (e as { eventType: string }).eventType === 'invoice_paid',
    );
    expect(paidEmit, 'expected an invoice_paid audit emit').toBeDefined();
    const payload = (paidEmit![1] as { payload: Record<string, unknown> }).payload;
    expect('member_id' in payload).toBe(false);
    expect(payload.event_registration_id).toBe('reg-88');
    expect(payload.invoice_id).toBe(INVOICE_ID);
  });

  it('non-member EVENT invoice → receipt-email outbox row carries privacyFooterKind event_non_member (wave-3 S13, §87/3 footer parity)', async () => {
    // issueInvoice (Task-14 B) + issueEventInvoiceAsPaid both thread the
    // PDPA transparency footer for a non-member event buyer; the legacy /
    // bill-first row paid through recordPayment must receive the SAME footer
    // on its receipt email — previously it silently got NULL.
    const invoice = makeNonMemberEventInvoice();
    const deps = makeDeps(
      true,
      invoice,
      makeSettings({ receiptNumberingMode: 'separate', autoEmailEnabled: true }),
    );
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeNonMemberEventInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invoice_paid',
        recipientEmail: 'jane@buyer.example',
        privacyFooterKind: 'event_non_member',
      }),
    );
  });

  it('matched-member EVENT invoice → receipt-email outbox row has NO privacyFooterKind key (footer is non-member-only)', async () => {
    const matched = makeNonMemberEventInvoice({ memberId: 'member-matched-1' });
    const deps = makeDeps(
      true,
      matched,
      makeSettings({ receiptNumberingMode: 'separate', autoEmailEnabled: true }),
    );
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1
        ? matched
        : makeNonMemberEventInvoice({ memberId: 'member-matched-1', status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    const enqueueCall = (deps.outbox.enqueue as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, e]) => (e as { eventType: string }).eventType === 'invoice_paid',
    );
    expect(enqueueCall, 'expected an invoice_paid outbox enqueue').toBeDefined();
    // The key must be ABSENT (exactOptionalPropertyTypes discipline), not
    // present-with-undefined — the adapter persists context_data verbatim.
    expect('privacyFooterKind' in (enqueueCall![1] as object)).toBe(false);
  });

  it('064 INTERIM — LEGACY issued no-TIN event row → legacy_no_tin_event_needs_remediation, NO receipt #2 side-effects', async () => {
    // REMOVE-WITH-064-REMEDIATION (site 6/15 — checklist at the guard in
    // record-payment.ts). legacy-row defensive (remove with spec §6 item 1).
    //
    // Supersedes the former "FIX 5" pin that drove a no-TIN event invoice
    // through recordPayment expecting SUCCESS (forceSeparate receipt) — that
    // business meaning died with the 064 §105 ROOT FIX: a no-TIN event buyer
    // can no longer reach 'issued' via plain issueInvoice
    // (`event_no_tin_requires_paid_issue`), and a LEGACY issued no-TIN row
    // that predates the as-paid redesign must NOT be payable here — its issue-
    // time PDF already IS the §105 ใบเสร็จรับเงิน, so paying it would mint
    // receipt #2 (the §105 double-receipt the redesign kills). The interim
    // guard rejects with a typed code so operators route the row to the
    // spec §6 item 1 remediation runbook instead.
    const legacyNoTinRow = makeNonMemberEventInvoice({
      memberIdentitySnapshot: {
        legal_name: 'Walk-in Buyer Co',
        tax_id: null, // TIN-less → legacy §105 receipt-shaped row
        address: '50 Sukhumvit Road',
        primary_contact_name: 'Jane',
        primary_contact_email: 'jane@buyer.example',
        member_number: null,
        member_number_display: null,
      },
    });
    const deps = makeDeps(
      true,
      legacyNoTinRow,
      makeSettings({ receiptNumberingMode: 'combined' }),
    );
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('legacy_no_tin_event_needs_remediation');
    // The guard fires BEFORE any side-effect: no §87 receipt sequence burned,
    // no receipt render, no issued→paid UPDATE, no audit emit, no outbox row.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.pdfRender.render).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyPayment).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('non-member EVENT invoice → does NOT flip registration_fee_paid (no F3 member) even with a registration_fee line', async () => {
    // Defensive: even if a malformed event draft somehow carried a
    // registration_fee line, the null-member guard must skip the member flip
    // (markRegistrationFeePaid requires a non-null memberId).
    const regFeeLine: InvoiceLine = {
      lineId: asInvoiceLineId('evt-regfee'),
      kind: 'registration_fee',
      descriptionTh: 'ค่าลงทะเบียน',
      descriptionEn: 'Registration fee',
      unitPrice: Money.fromTHB(5000),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromTHB(5000),
      position: 2,
    };
    const invoice = makeNonMemberEventInvoice({
      lines: [makeNonMemberEventInvoice().lines[0]!, regFeeLine],
    });
    const deps = makeDeps(true, invoice, makeSettings({ receiptNumberingMode: 'separate' }));
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeNonMemberEventInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(deps.memberIdentity.markRegistrationFeePaid).not.toHaveBeenCalled();
  });

  it('non-member EVENT invoice → registered onPaid callbacks do NOT fire (no member, no renewal cycle)', async () => {
    const invoice = makeNonMemberEventInvoice();
    const onPaid = vi.fn(async () => {});
    const deps = makeDeps(true, invoice, makeSettings({ receiptNumberingMode: 'separate' }), {
      onPaidCallbacks: [onPaid],
    });
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1 ? invoice : makeNonMemberEventInvoice({ status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('matched-member EVENT invoice (member_id present) → onPaid callbacks DO fire + TIMELINE audit (member_id present)', async () => {
    // A matched-member event invoice carries a real member_id, so it takes the
    // timeline audit branch AND fires onPaid callbacks (parity with membership).
    const matched = makeNonMemberEventInvoice({ memberId: 'member-matched-1' });
    const onPaid = vi.fn(async () => {});
    const deps = makeDeps(true, matched, makeSettings({ receiptNumberingMode: 'separate' }), {
      onPaidCallbacks: [onPaid],
    });
    let call = 0;
    deps.invoiceRepo.findByIdInTx = vi.fn(async () => {
      call++;
      return call === 1
        ? matched
        : makeNonMemberEventInvoice({ memberId: 'member-matched-1', status: 'paid' });
    });
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(true);
    expect(onPaid).toHaveBeenCalledTimes(1);
    // Rolling-anchor field (renewal-rolling-anchor task 3): an EVENT
    // invoice's onPaid event always carries invoiceSubject='event' — the
    // F8 hook skips it before ever reading paymentDate.
    expect(onPaid).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceSubject: 'event' }),
      expect.anything(),
    );

    const paidEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, e]) => (e as { eventType: string }).eventType === 'invoice_paid',
    );
    const payload = (paidEmit![1] as { payload: Record<string, unknown> }).payload;
    expect(payload.member_id).toBe('member-matched-1');
    expect('event_registration_id' in payload).toBe(false);
  });

  it('MEMBERSHIP invoice with member_id NULL → still rejected as no_snapshot_on_invoice (data-error guard preserved)', async () => {
    // A membership invoice with a null member is a corrupted row
    // (invoices_subject_fields_ck guarantees member_id NOT NULL for membership).
    // The relaxed guard only exempts subject='event'; membership must still fail.
    const broken = makeIssuedInvoice({ memberId: null, invoiceSubject: 'membership' });
    const deps = makeDeps(true, broken, makeSettings());
    const r = await recordPayment(deps, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_snapshot_on_invoice');
  });
});

describe('recordPayment — server-side payment-date guard (defense-in-depth)', () => {
  beforeEach(() => vi.clearAllMocks());

  // clock.nowIso() = 2026-05-18T10:00Z → Asia/Bangkok today = 2026-05-18.
  // Fixture issue_date = 2026-04-18 → valid window [2026-04-18, 2026-05-18].
  // Mirrors the F4 admin record-payment client clamp, but server-side so a
  // bypassed (curl/script) request can't mint a receipt dated before its
  // invoice or in the future. MUST use Asia/Bangkok today, NOT UTC.

  it('rejects an admin payment date BEFORE issue_date (client-clamp bypass)', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings());
    const r = await recordPayment(deps, { ...input, paymentDate: '2026-04-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('payment_date_out_of_range');
      if (r.error.code === 'payment_date_out_of_range') {
        expect(r.error.min).toBe('2026-04-18');
        expect(r.error.max).toBe('2026-05-18');
      }
    }
    // Guard runs before any write — no receipt allocated, no apply.
    expect(deps.sequenceAllocator.allocateNext).not.toHaveBeenCalled();
    expect(deps.invoiceRepo.applyPayment).not.toHaveBeenCalled();
  });

  it('rejects an admin payment date IN THE FUTURE (Asia/Bangkok today)', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings());
    const r = await recordPayment(deps, { ...input, paymentDate: '2026-06-01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payment_date_out_of_range');
  });

  it('accepts an in-range admin payment date', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings());
    const r = await recordPayment(deps, { ...input, paymentDate: '2026-05-10' });
    expect(r.ok).toBe(true);
  });

  it('EXEMPTS the F5 webhook path (processor-authoritative settlement date)', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings());
    const r = await recordPayment(deps, {
      ...input,
      paymentDate: '2026-06-01', // future — would be rejected on an admin path
      triggeredBy: 'webhook',
    });
    expect(r.ok).toBe(true);
  });

  it('EXEMPTS the F8 offline-mark path (admin_offline_mark)', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings());
    const r = await recordPayment(deps, {
      ...input,
      paymentDate: '2026-06-01',
      triggeredBy: 'admin_offline_mark',
    });
    expect(r.ok).toBe(true);
  });
});

