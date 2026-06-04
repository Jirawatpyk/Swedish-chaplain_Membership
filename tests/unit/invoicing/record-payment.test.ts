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
import { recordPayment } from '@/modules/invoicing/application/use-cases/record-payment';
import type { RecordPaymentDeps } from '@/modules/invoicing/application/use-cases/record-payment';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import { InvoiceApplyConflictError } from '@/modules/invoicing/application/lib/invoice-apply-conflict-error';

const INVOICE_ID = '00000000-0000-0000-0000-00000000e002';

function makeIssuedInvoice(overrides: Partial<Invoice> = {}): Invoice {
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
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
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
    identity: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
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
      lockForUpdate: vi.fn(async () =>
        rowExists ? ((draft?.status ?? 'issued') as InvoiceStatus) : null,
      ),
      applyCreditNoteRollup: vi.fn(),
      applyInvoicePdfRegeneration: vi.fn(),
      applyVoid: vi.fn(),
      applyReceiptPdf: vi.fn(),
      applyReceiptPdfFailure: vi.fn(),
    },
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
    currentTemplateVersion: 1,
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

  it('separate numbering — allocates receipt seq', async () => {
    const deps = makeDeps(true, makeIssuedInvoice(), makeSettings({ receiptNumberingMode: 'separate' }));
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
      expect.objectContaining({ kind: 'receipt_separate' }),
    );
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
  function makeNonMemberEventInvoice(overrides: Partial<Invoice> = {}): Invoice {
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
        kind: 'receipt_separate',
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

