/**
 * Unit tests for `exportPaidInvoicesCsv` (Phase 3 of the F4 receipt-
 * surface plan).
 *
 * Pins the bookkeeper-facing column shape, the BOM prefix, RFC-4180
 * escaping, range validation, F5 payment-method fallback to 'manual',
 * and the `invoices_csv_exported` audit emit.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  exportPaidInvoicesCsv,
  escapeCsv,
  type ExportPaidInvoicesCsvDeps,
} from '@/modules/invoicing/application/use-cases/export-paid-invoices-csv';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const BOM = '﻿';
const HEADER_LINE =
  'Issue Date,Invoice No.,Receipt No.,Customer Legal Name,Customer Tax ID,Subtotal,VAT %,VAT,Total,Currency,Paid At,Payment Method';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const base = {
    tenantId: 't',
    invoiceId: asInvoiceId('i-1'),
    memberId: 'm-1',
    planId: 'p',
    planYear: 2026,
    status: 'paid' as const,
    draftByUserId: 'u',
    fiscalYear: 2026 as unknown as Invoice['fiscalYear'],
    sequenceNumber: 1,
    documentNumber: {
      raw: 'INV-2026-000001',
      prefix: 'INV',
      fiscalYear: 2026,
      sequenceNumber: 1,
    } as unknown as Invoice['documentNumber'],
    issueDate: '2026-05-15',
    dueDate: '2026-06-14',
    // Bangkok-local 2026-05-16 (03:00 UTC = 10:00 Bangkok).
    paidAt: '2026-05-16T03:00:00Z',
    voidedAt: null,
    currency: 'THB' as const,
    subtotal: Money.fromSatangUnsafe(100_000n), // 1,000.00 THB
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: {
      legal_name: 'ACME Co., Ltd.',
      tax_id: '0123456789012',
    } as unknown as Invoice['memberIdentitySnapshot'],
    paymentMethod: 'bank_transfer',
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: 'u',
    paymentDate: '2026-05-16',
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: null,
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    lines: [],
    createdAt: '2026-05-15T00:00:00Z',
    updatedAt: '2026-05-16T10:00:00Z',
  };
  return { ...base, ...overrides } as Invoice;
}

function makeDeps(
  paidInvoices: readonly Invoice[],
  paymentMethodMap: ReadonlyMap<string, 'card' | 'promptpay'> = new Map(),
): ExportPaidInvoicesCsvDeps & {
  audit: { emit: ReturnType<typeof vi.fn> };
} {
  const audit = { emit: vi.fn(async () => {}) };
  return {
    audit,
    invoiceRepo: {
      // Only `listPaged` is exercised by the use-case.
      listPaged: vi.fn(async () => ({
        rows: paidInvoices,
        total: paidInvoices.length,
      })),
    } as unknown as ExportPaidInvoicesCsvDeps['invoiceRepo'],
    paymentMethodLookup: vi.fn(async () => paymentMethodMap),
  };
}

describe('exportPaidInvoicesCsv', () => {
  it('emits a UTF-8 BOM + header line + filename for an empty range', async () => {
    const deps = makeDeps([]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(0);
    expect(result.value.csv.startsWith(BOM)).toBe(true);
    expect(result.value.csv).toContain(HEADER_LINE);
    expect(result.value.filename).toBe(
      'invoices-paid-2026-05-01-to-2026-05-31.csv',
    );
  });

  it('renders a separate-mode row with the receipt number populated', async () => {
    const inv = makeInvoice({
      receiptDocumentNumberRaw: 'RC-2026-000001',
    });
    const deps = makeDeps([inv]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(1);
    expect(result.value.csv).toContain('RC-2026-000001');
    expect(result.value.csv).toContain('INV-2026-000001');
    // VAT% formatted as percent (7.00) not multiplier (0.07).
    expect(result.value.csv).toContain(',7.00,');
    // Money: 1000.00 + VAT 70.00 + total 1070.00.
    expect(result.value.csv).toContain(',1000.00,');
    expect(result.value.csv).toContain(',70.00,');
    expect(result.value.csv).toContain(',1070.00,');
  });

  it('leaves Receipt No. blank for combined-mode rows', async () => {
    const inv = makeInvoice({
      receiptDocumentNumberRaw: null, // combined
    });
    const deps = makeDeps([inv]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error('expected ok');
    // Row shape: `2026-05-15,INV-2026-000001,,...` — empty 3rd field.
    expect(result.value.csv).toMatch(
      /2026-05-15,INV-2026-000001,,/,
    );
  });

  it('quotes legal names containing commas per RFC 4180', async () => {
    const inv = makeInvoice({
      memberIdentitySnapshot: {
        legal_name: 'บริษัท ตัวอย่าง, จำกัด',
        tax_id: '0105557123456',
      } as unknown as Invoice['memberIdentitySnapshot'],
    });
    const deps = makeDeps([inv]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.csv).toContain('"บริษัท ตัวอย่าง, จำกัด"');
  });

  it('falls back to "manual" when no F5 payment method is recorded', async () => {
    const inv = makeInvoice();
    const deps = makeDeps([inv]); // empty methodMap → manual
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.csv).toMatch(/,manual\r?\n?$/);
  });

  it('labels F5-paid rows by their PaymentMethod', async () => {
    const inv = makeInvoice();
    const methodMap = new Map<string, 'card' | 'promptpay'>([
      [inv.invoiceId, 'promptpay'],
    ]);
    const deps = makeDeps([inv], methodMap);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.csv).toMatch(/,promptpay\r?\n?$/);
  });

  it('includes an AS-PAID event invoice with its paidAt + payment date rendered (064 T15 pin)', async () => {
    // issueEventInvoiceAsPaid lands draft→paid directly with
    // issue_date = due_date = payment_date and pdfDocKind receipt_combined.
    // The export keys on status='paid' + paidAt-in-range — an as-paid row
    // (never 'issued') MUST appear in the bookkeeper CSV exactly like a
    // two-step paid row, with the as-paid date pin visible in Issue Date.
    const asPaid = makeInvoice({
      invoiceId: asInvoiceId('i-as-paid'),
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      eventId: 'event-1',
      eventRegistrationId: 'reg-1',
      vatInclusive: true,
      pdfDocKind: 'receipt_combined',
      issueDate: '2026-05-16',
      dueDate: '2026-05-16',
      paymentDate: '2026-05-16',
      paidAt: '2026-05-16T03:00:00Z', // Bangkok 2026-05-16 → in range
      receiptDocumentNumberRaw: null, // combined: receipt no. column stays blank
    } as Partial<Invoice>);
    const deps = makeDeps([asPaid]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.rowCount).toBe(1);
    // Issue Date = the as-paid payment date; Paid At = the raw ISO instant.
    expect(result.value.csv).toMatch(/2026-05-16,INV-2026-000001,,/);
    expect(result.value.csv).toContain('2026-05-16T03:00:00Z');
  });

  it('filters out rows whose paidAt falls outside the inclusive range', async () => {
    const insideMay = makeInvoice({
      invoiceId: asInvoiceId('i-may'),
      paidAt: '2026-05-16T03:00:00Z', // Bangkok 2026-05-16
    });
    const beforeRange = makeInvoice({
      invoiceId: asInvoiceId('i-apr'),
      paidAt: '2026-04-30T16:30:00Z', // Bangkok 2026-04-30 23:30 (just before)
    });
    const afterRange = makeInvoice({
      invoiceId: asInvoiceId('i-jun'),
      paidAt: '2026-06-01T01:00:00Z', // Bangkok 2026-06-01 08:00
    });
    const deps = makeDeps([insideMay, beforeRange, afterRange]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.rowCount).toBe(1);
  });

  it('emits the `invoices_csv_exported` audit event with payload', async () => {
    const deps = makeDeps([makeInvoice()]);
    await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'admin-1',
      requestId: 'req-1',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const [tx, event] = deps.audit.emit.mock.calls[0]!;
    expect(tx).toBeNull(); // read-path probe: no DB tx
    expect(event.eventType).toBe('invoices_csv_exported');
    expect(event.tenantId).toBe('t');
    expect(event.actorUserId).toBe('admin-1');
    expect(event.requestId).toBe('req-1');
    expect(event.payload).toMatchObject({
      from: '2026-05-01',
      to: '2026-05-31',
      row_count: 1,
      actor_user_id: 'admin-1',
      route: 'export-paid-invoices-csv',
    });
  });

  it('rejects an inverted range without emitting audit', async () => {
    const deps = makeDeps([]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2026-05-31',
      to: '2026-05-01',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Narrow the union so `.reason` is accessible — `invoices_csv_exported`
    // error union has two arms, only `invalid_range` carries `reason`.
    if (result.error.code !== 'invalid_range') {
      throw new Error(`expected invalid_range, got ${result.error.code}`);
    }
    expect(result.error.reason).toBe('inverted');
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('rejects ranges >366 days without emitting audit', async () => {
    const deps = makeDeps([]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2025-01-01',
      to: '2026-12-31',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'invalid_range') {
      throw new Error(`expected invalid_range, got ${result.error.code}`);
    }
    expect(result.error.reason).toBe('too_wide');
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  // F5R3 MED-8 (2026-05-16) — pin the 366-day boundary explicitly.
  // The use-case uses inclusive `daysBetween` so a full leap year
  // (Jan 1 → Dec 31 of a leap year) is exactly 366 days inclusive
  // and must pass; one day MORE must reject as too_wide. Without
  // these tests a future MAX_DAYS off-by-one (367 instead of 366,
  // or 365 instead of 366) would silently slip through.
  it('accepts exactly 366 days inclusive (full leap year boundary)', async () => {
    const deps = makeDeps([]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2024-01-01',
      to: '2024-12-31', // 2024 is a leap year, 366 days inclusive
    });
    expect(result.ok).toBe(true);
  });

  it('rejects exactly 367 days inclusive (one beyond MAX_DAYS=366)', async () => {
    const deps = makeDeps([]);
    const result = await exportPaidInvoicesCsv(deps, {
      tenantId: 't',
      actorUserId: 'u',
      from: '2024-01-01',
      to: '2025-01-01', // 367 days inclusive (366-day leap year + 1)
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'invalid_range') {
      throw new Error(`expected invalid_range, got ${result.error.code}`);
    }
    expect(result.error.reason).toBe('too_wide');
  });
});

describe('escapeCsv (RFC 4180)', () => {
  it('returns "" for null/undefined/empty', () => {
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
    expect(escapeCsv('')).toBe('');
  });

  it('passes through values with no special chars', () => {
    expect(escapeCsv('hello')).toBe('hello');
    expect(escapeCsv('THB')).toBe('THB');
  });

  it('quotes + escapes embedded double quotes', () => {
    expect(escapeCsv('foo "bar" baz')).toBe('"foo ""bar"" baz"');
  });

  it('quotes values with commas', () => {
    expect(escapeCsv('one,two')).toBe('"one,two"');
  });

  it('quotes values with newlines or CR', () => {
    expect(escapeCsv('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsv('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('stringifies non-string scalars', () => {
    expect(escapeCsv(42)).toBe('42');
    expect(escapeCsv(true)).toBe('true');
  });
});
