/**
 * Round-3 invoice importer — PURE helper unit tests (Part 2, ROUND3_PLAN.md
 * § Invoice import). Orchestration + the real money path are covered by the
 * live-Neon integration test (tests/integration/scripts/import-round3-invoices.test.ts).
 *
 * SYNTHETIC fixtures only — never real company names/emails (PII rule, spec § 7).
 * Covers: the 12-month half-open coverage window (month-end clamp), THB→satang
 * rounding, payment-date self-validation (the import bypasses the use-case rail
 * guards via triggeredBy 'admin_offline_mark', so THESE checks are the guard),
 * payment-reference / void-reason composition + caps, date-only day arithmetic,
 * the mapping-table shape, operator-attention lists, and PII-freedom of the
 * whole report document.
 */
import { describe, expect, it } from 'vitest';

const {
  addDaysDateOnly,
  buildInvoiceImportReport,
  coverageWindowFor,
  midnightUtcIso,
  issueClockIso,
  paymentReferenceFor,
  thbToSatang,
  validateDocDates,
  voidReasonFor,
} = await import('@/../scripts/import-round3/invoice-import-core');
type CoreModule = typeof import('@/../scripts/import-round3/invoice-import-core');
type DocOutcome = Parameters<CoreModule['buildInvoiceImportReport']>[0]['pairs'][number]['outcome'];

import type { Round3InvoiceDoc } from '@/../scripts/import-round3/finalized-sheet';

const TODAY = '2026-07-29'; // fixed Bangkok "today" for deterministic tests

function doc(over: Partial<Round3InvoiceDoc>): Round3InvoiceDoc {
  return {
    companyKey: 'SECRET COMPANY (THAILAND) LTD',
    contactEmail: 'secret-company@pending.swecham.zyncdata.app',
    series: '2026',
    origBillNo: 'MB2026-042',
    origReceiptNo: 'RC2026-041',
    issueDate: '2026-03-01',
    dueDateExcel: '2026-03-31',
    paymentDate: '2026-03-05',
    amountThb: 16000,
    vatThb: 1120,
    totalThb: 17120,
    targetStatus: 'paid',
    planTier: 'Regular Corporate',
    planYear: 2026,
    rowIndex: 42,
    ...over,
  };
}

function outcome(over: Partial<DocOutcome>): DocOutcome {
  return {
    action: 'imported',
    errorCode: null,
    mintedBillNo: 'SC-2026-000001',
    mintedReceiptNo: 'RC-2026-000001',
    memberNumber: 900123,
    memberActive: true,
    cycle: 'anchored_upcoming',
    plannedSteps: null,
    ...over,
  };
}

describe('coverageWindowFor — half-open [issueDate, +12mo) UTC window', () => {
  it('plain date → same day-of-month next year, midnight UTC, half-open pair', () => {
    expect(coverageWindowFor('2026-03-01')).toEqual({
      fromIso: '2026-03-01T00:00:00.000Z',
      toIso: '2027-03-01T00:00:00.000Z',
    });
  });

  it('leap-day anchor clamps to Feb 28 the following (non-leap) year', () => {
    expect(coverageWindowFor('2024-02-29')).toEqual({
      fromIso: '2024-02-29T00:00:00.000Z',
      toIso: '2025-02-28T00:00:00.000Z',
    });
  });

  it('month-end anchor is preserved when the target month has the day', () => {
    expect(coverageWindowFor('2025-05-31')).toEqual({
      fromIso: '2025-05-31T00:00:00.000Z',
      toIso: '2026-05-31T00:00:00.000Z',
    });
  });
});

describe('midnightUtcIso / issueClockIso', () => {
  it('midnightUtcIso appends T00:00:00.000Z', () => {
    expect(midnightUtcIso('2026-01-15')).toBe('2026-01-15T00:00:00.000Z');
  });
  it('issueClockIso is 05:00Z (midday Bangkok — same Bangkok calendar day + right FY)', () => {
    expect(issueClockIso('2026-01-15')).toBe('2026-01-15T05:00:00.000Z');
  });
});

describe('thbToSatang — money conversion (VAT-exclusive unit price)', () => {
  it('integer THB', () => {
    expect(thbToSatang(16000)).toBe(1_600_000n);
  });
  it('2-dp THB', () => {
    expect(thbToSatang(1234.56)).toBe(123_456n);
  });
  it('float-noise input rounds to the exact satang (4103.85 * 100 = 410384.999…)', () => {
    expect(thbToSatang(4103.85)).toBe(410_385n);
  });
});

describe('addDaysDateOnly', () => {
  it('rolls over month + year boundaries', () => {
    expect(addDaysDateOnly('2026-12-30', 5)).toBe('2027-01-04');
  });
  it('+60 days (the lapse-clock window)', () => {
    expect(addDaysDateOnly('2026-03-31', 60)).toBe('2026-05-30');
  });
});

describe('paymentReferenceFor / voidReasonFor', () => {
  it('composes "TSCC {bill} / {rc}" when the original receipt no exists', () => {
    expect(paymentReferenceFor({ origBillNo: 'MB2026-042', origReceiptNo: 'RC2026-041' })).toBe(
      'TSCC MB2026-042 / RC2026-041',
    );
  });
  it('omits the receipt part when null', () => {
    expect(paymentReferenceFor({ origBillNo: 'MB2026-042', origReceiptNo: null })).toBe(
      'TSCC MB2026-042',
    );
  });
  it('caps at 200 chars (recordPayment schema max)', () => {
    const long = paymentReferenceFor({
      origBillNo: 'X'.repeat(300),
      origReceiptNo: 'Y'.repeat(300),
    });
    expect(long.length).toBeLessThanOrEqual(200);
  });
  it('void reason cites the original bill number and caps at 500', () => {
    expect(voidReasonFor({ origBillNo: 'MB2025-089' })).toBe(
      'Cancelled per TSCC records (import; original MB2025-089)',
    );
    expect(voidReasonFor({ origBillNo: 'Z'.repeat(600) }).length).toBeLessThanOrEqual(500);
  });
});

describe('validateDocDates — the importer-side guard (offline rail bypasses the use-case guard)', () => {
  it('clean paid doc → no errors', () => {
    expect(validateDocDates(doc({}), TODAY)).toEqual([]);
  });
  it('paid doc without a payment date → paid_missing_payment_date', () => {
    expect(validateDocDates(doc({ paymentDate: null }), TODAY)).toEqual([
      'paid_missing_payment_date',
    ]);
  });
  it('payment before issue → payment_before_issue', () => {
    expect(
      validateDocDates(doc({ issueDate: '2026-03-10', paymentDate: '2026-03-05' }), TODAY),
    ).toEqual(['payment_before_issue']);
  });
  it('payment in the future → payment_in_future', () => {
    expect(validateDocDates(doc({ paymentDate: '2026-08-01' }), TODAY)).toEqual([
      'payment_in_future',
    ]);
  });
  it('issue date in the future → issue_date_in_future', () => {
    expect(
      validateDocDates(
        doc({ issueDate: '2026-09-01', paymentDate: null, targetStatus: 'issued' }),
        TODAY,
      ),
    ).toEqual(['issue_date_in_future']);
  });
  it('issued / void docs do not require a payment date', () => {
    expect(validateDocDates(doc({ targetStatus: 'issued', paymentDate: null }), TODAY)).toEqual([]);
    expect(validateDocDates(doc({ targetStatus: 'void', paymentDate: null }), TODAY)).toEqual([]);
  });
});

describe('buildInvoiceImportReport — shape, counts, attention lists, PII-freedom', () => {
  const paidFuture = doc({ rowIndex: 10, issueDate: '2026-03-01', paymentDate: '2026-03-05' });
  const paidEnded = doc({
    rowIndex: 11,
    series: '2025',
    origBillNo: 'MB2025-007',
    issueDate: '2025-06-10',
    paymentDate: '2025-06-15',
    planYear: 2025,
  });
  const issuedStale = doc({
    rowIndex: 12,
    targetStatus: 'issued',
    paymentDate: null,
    origReceiptNo: null,
    issueDate: '2026-01-10', // system due 2026-02-09; +60 = 2026-04-10 < TODAY → lapse-list
    dueDateExcel: '2026-02-10',
  });
  const issuedInactive = doc({
    rowIndex: 13,
    targetStatus: 'issued',
    paymentDate: null,
    origReceiptNo: null,
    issueDate: '2026-06-01', // system due 2026-07-01; +60 = 2026-08-30 > TODAY → NOT listed
    dueDateExcel: '2026-07-15',
  });
  const voided = doc({
    rowIndex: 14,
    targetStatus: 'void',
    paymentDate: null,
    origReceiptNo: null,
    origBillNo: 'MB2025-089',
  });
  // R3-5 discriminators — the list is keyed on the SYSTEM due date
  // (issue + defaultNetDays), never the sheet's Due Date cell:
  //   row 15: sheet due is ANCIENT (sheet+60 < TODAY → the old keying would
  //           list it) but the system due is recent → must NOT be listed.
  const issuedSheetDueOld = doc({
    rowIndex: 15,
    targetStatus: 'issued',
    paymentDate: null,
    origReceiptNo: null,
    issueDate: '2026-06-20', // system due 2026-07-20; +60 = 2026-09-18 > TODAY
    dueDateExcel: '2026-03-01', // sheet+60 = 2026-04-30 < TODAY
  });
  //   row 16: sheet due is FUTURE-ish (sheet+60 > TODAY → the old keying
  //           would skip it) but the system due is ancient → MUST be listed.
  const issuedSheetDueNew = doc({
    rowIndex: 16,
    targetStatus: 'issued',
    paymentDate: null,
    origReceiptNo: null,
    issueDate: '2026-01-05', // system due 2026-02-04; +60 = 2026-04-05 < TODAY
    dueDateExcel: '2026-07-01', // sheet+60 = 2026-08-30 > TODAY
  });

  const report = buildInvoiceImportReport({
    mode: 'commit',
    generatedAt: '2026-07-29T04:00:00.000Z',
    runId: 'test-run',
    todayBangkok: TODAY,
    defaultNetDays: 30,
    pairs: [
      { doc: paidFuture, outcome: outcome({}) },
      {
        doc: paidEnded,
        outcome: outcome({
          mintedBillNo: 'SC-2025-000001',
          mintedReceiptNo: 'RC-2025-000001',
          memberNumber: 900124,
        }),
      },
      {
        doc: issuedStale,
        outcome: outcome({
          mintedBillNo: 'SC-2026-000002',
          mintedReceiptNo: null,
          memberNumber: 900125,
          cycle: 'linked_awaiting',
        }),
      },
      {
        doc: issuedInactive,
        outcome: outcome({
          mintedBillNo: 'SC-2026-000003',
          mintedReceiptNo: null,
          memberNumber: 900126,
          memberActive: false,
          cycle: 'none_inactive_member',
        }),
      },
      {
        doc: voided,
        outcome: outcome({
          mintedBillNo: 'SC-2026-000004',
          mintedReceiptNo: null,
          memberNumber: 900127,
          cycle: 'none_void',
        }),
      },
      {
        doc: issuedSheetDueOld,
        outcome: outcome({
          mintedBillNo: 'SC-2026-000005',
          mintedReceiptNo: null,
          memberNumber: 900128,
          cycle: 'linked_awaiting',
        }),
      },
      {
        doc: issuedSheetDueNew,
        outcome: outcome({
          mintedBillNo: 'SC-2026-000006',
          mintedReceiptNo: null,
          memberNumber: 900129,
          cycle: 'linked_awaiting',
        }),
      },
    ],
  });

  it('mapping table rows are [rowIndex, origBillNo, origReceiptNo, mintedBillNo, mintedReceiptNo, memberNumber]', () => {
    expect(report.mintedNumberMap).toContainEqual([
      10,
      'MB2026-042',
      'RC2026-041',
      'SC-2026-000001',
      'RC-2026-000001',
      900123,
    ]);
    expect(report.mintedNumberMap).toContainEqual([
      12,
      'MB2026-042',
      null,
      'SC-2026-000002',
      null,
      900125,
    ]);
    expect(report.mintedNumberMap).toHaveLength(7);
  });

  it('counts per status + action + cycles', () => {
    expect(report.totals.docs).toBe(7);
    expect(report.totals.byTargetStatus).toEqual({ paid: 2, issued: 4, void: 1 });
    expect(report.totals.imported).toBe(7);
    expect(report.totals.errors).toBe(0);
    expect(report.cycles).toEqual({
      anchoredUpcoming: 2,
      linkedAwaiting: 3,
      skippedActiveExists: 0,
      noneInactiveMember: 1,
      noneVoid: 1,
    });
  });

  it('operator-attention: lapse list keyed on SYSTEM due (issue+netDays)+60 — never the sheet due (R3-5)', () => {
    expect(report.operatorAttention.issuedPastDuePlus60).toEqual([
      // row 12: both keyings agree (listed) — the sheet due rides along for
      // display only. rows 15/16 are the discriminators (fixture comments).
      { rowIndex: 12, dueDateExcel: '2026-02-10', systemDueDate: '2026-02-09' },
      { rowIndex: 16, dueDateExcel: '2026-07-01', systemDueDate: '2026-02-04' },
    ]);
    const listed = report.operatorAttention.issuedPastDuePlus60.map((a) => a.rowIndex);
    expect(listed).not.toContain(15); // ancient SHEET due alone must not list
    expect(listed).toContain(16); // ancient SYSTEM due must list
  });

  it('operator-attention: paid docs whose coverage already ended (enters COLLECT immediately)', () => {
    expect(report.operatorAttention.paidCoverageEnded).toEqual([
      { rowIndex: 11, coverageTo: '2026-06-10' },
    ]);
  });

  it('operator-attention: issued docs held by inactive members (no cycle)', () => {
    expect(report.operatorAttention.issuedInactiveMember).toEqual([{ rowIndex: 13 }]);
  });

  it('the whole report document is PII-free (no company names, no emails)', () => {
    const json = JSON.stringify(report);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('@');
    expect(json).not.toContain('pending.swecham');
  });
});
