/**
 * Round-3 importer — 'Finalized Member' sheet reader/transformer unit tests.
 *
 * SYNTHETIC fixtures only (built in-memory via xlsx aoa_to_sheet) — never real
 * company names (docs/import/ is gitignored PII; ROUND3_PLAN.md § PII rule).
 * Covers: fixed-index header assertion, latest-row-wins grouping + same-series
 * duplicate rule, plan-label fixups (Student / Start-up Corporate), country
 * default rules + countryDefaults recording, mockup-email slugify + collision,
 * local-component date reads (no −1 day under Asia/Bangkok), invoice-selection
 * scope, planYear derivation, and the money-invariant guard.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readFinalizedMemberWorkbook } = await import(
  '@/../scripts/import-round3/finalized-sheet'
);
const { validateRows } = await import('@/../scripts/import-members/validate');
const { buildTierResolver } = await import('@/../scripts/import-members/tier-resolution');

/** The REAL 'Finalized Member' header row (verified against the workbook 2026-07-29).
 *  Duplicated here on purpose — pins drift in BOTH the sheet and the module map. */
const HEADERS: readonly string[] = [
  'Inv No', 'Inv Date', 'Bill To', 'Amount', 'Vat 7%', 'Total', 'Due Date', 'Status',
  'Ref. Tax Invoice No', 'Payment Date', 'Official name', 'Member Status', 'Member Type',
  'Tax ID', 'Member Type', 'Country (ISO post)', 'Webiste', 'Founded year',
  'Annual Turnover (THB)', 'Capital registeration', 'Description', 'Plan', 'Member Status',
  'Registration date', 'Plan Year (Current)', 'Member In 2025', 'Postal code',
  'Province / State', 'City / Distrct', 'Address Line 1 ', 'Address Line 2',
  'First name (Primary contact)', 'Last name (Primary contact)',
];

interface FxRow {
  readonly inv: string;
  readonly invDate: Date;
  readonly official: string;
  readonly amount?: number;
  readonly vat?: number;
  readonly total?: number;
  readonly due?: Date;
  readonly status?: string;
  readonly rc?: string | number;
  readonly payDate?: Date | string;
  readonly memberStatus?: string;
  readonly taxId?: string | number;
  readonly entity?: string;
  readonly country?: string;
  readonly plan?: string;
  readonly first?: string;
  readonly last?: string;
}

/** One synthetic 33-cell sheet row. Money defaults to a consistent 7%-VAT set. */
function fxRow(r: FxRow): unknown[] {
  const amount = r.amount ?? 16000;
  const vat = r.vat ?? amount * 0.07;
  const total = r.total ?? amount + vat;
  const status = r.status ?? 'paid';
  const cells: unknown[] = new Array<unknown>(33).fill('');
  cells[0] = r.inv;
  cells[1] = r.invDate;
  cells[2] = r.official; // Bill To (unused by the importer)
  cells[3] = amount;
  cells[4] = vat;
  cells[5] = total;
  cells[6] = r.due ?? new Date(r.invDate.getFullYear(), r.invDate.getMonth() + 1, 1);
  cells[7] = status;
  cells[8] = r.rc ?? (status.toLowerCase() === 'paid' ? 'RC2026-999' : '');
  cells[9] = r.payDate ?? (status.toLowerCase() === 'paid' ? r.invDate : '');
  cells[10] = r.official;
  cells[11] = r.memberStatus ?? 'Active';
  cells[12] = 'Full Year Member';
  cells[13] = r.taxId ?? '';
  cells[14] = r.entity ?? 'Private Limited Company (Company Limited)';
  cells[15] = r.country ?? 'THAILAND';
  cells[16] = '';
  cells[17] = '';
  cells[18] = '';
  cells[19] = '';
  cells[20] = '';
  cells[21] = r.plan ?? 'Regular Corporate';
  cells[26] = 10110;
  cells[27] = 'Bangkok';
  cells[28] = 'Watthana';
  cells[29] = '1 Anon Test Rd';
  cells[30] = '';
  cells[31] = r.first ?? 'Anon';
  cells[32] = r.last ?? 'Tester';
  return cells;
}

/** Write a temp .xlsx whose 'Finalized Member' sheet holds `rows` under HEADERS. */
function writeFixture(
  rows: readonly (readonly unknown[])[],
  headers: readonly string[] = HEADERS,
): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'round3-fixture-'));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers as unknown[], ...(rows as unknown[][])], {
    cellDates: true,
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Finalized Member');
  const file = join(dir, 'fixture.xlsx');
  XLSX.writeFile(wb, file, { cellDates: true });
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function withFixture<T>(
  rows: readonly (readonly unknown[])[],
  fn: (parsed: ReturnType<typeof readFinalizedMemberWorkbook>) => T,
  headers: readonly string[] = HEADERS,
): T {
  const { file, cleanup } = writeFixture(rows, headers);
  try {
    return fn(readFinalizedMemberWorkbook(file));
  } finally {
    cleanup();
  }
}

describe('readFinalizedMemberWorkbook — header assertion (fixed-index map)', () => {
  it('accepts the real header row', () => {
    withFixture([fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 15), official: 'ANON ALPHA CO., LTD.' })], (parsed) => {
      expect(parsed.errors).toEqual([]);
      expect(parsed.memberRows).toHaveLength(1);
    });
  });

  it('throws with a clear message when a used column header drifts', () => {
    const drifted = [...HEADERS];
    drifted[21] = 'Plans'; // Plan → Plans
    const { file, cleanup } = writeFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 15), official: 'ANON ALPHA CO., LTD.' })],
      drifted,
    );
    try {
      expect(() => readFinalizedMemberWorkbook(file)).toThrow(/column 21.*"plan".*"plans"/i);
    } finally {
      cleanup();
    }
  });

  it('throws when a column is inserted (everything shifts right)', () => {
    const shifted = ['Extra', ...HEADERS];
    const { file, cleanup } = writeFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 15), official: 'ANON ALPHA CO., LTD.' })],
      shifted,
    );
    try {
      expect(() => readFinalizedMemberWorkbook(file)).toThrow(/column 0/i);
    } finally {
      cleanup();
    }
  });
});

describe('grouping — latest row wins + same-series duplicate rule', () => {
  it('2026 row supplies ALL member fields when both series exist; only the 2026 doc is selected', () => {
    withFixture(
      [
        fxRow({
          inv: 'MB2025-010', invDate: new Date(2025, 0, 10), official: 'ANON ALPHA CO., LTD.',
          plan: 'Regular Corporate', country: 'THAILAND', taxId: '0105561234560',
        }),
        fxRow({
          inv: 'MB2026-020', invDate: new Date(2026, 0, 12), official: 'ANON ALPHA CO., LTD.',
          plan: 'Premium Corporate', amount: 36000, country: 'SWEDEN', taxId: '',
        }),
      ],
      (parsed) => {
        expect(parsed.errors).toEqual([]);
        expect(parsed.memberRows).toHaveLength(1);
        const m = parsed.memberRows[0]!;
        expect(m.tier).toBe('Premium Corporate');
        expect(m.country).toBe('SWEDEN');
        expect(m.registrationDate).toBe('2026-01-12');
        expect(m.rowIndex).toBe(3); // Excel row of the 2026 (latest) row
        expect(parsed.invoices).toHaveLength(1);
        expect(parsed.invoices[0]!.origBillNo).toBe('MB2026-020');
        expect(parsed.invoices[0]!.series).toBe('2026');
      },
    );
  });

  it('same-series duplicate: LATER Inv Date wins; a warning records the dropped row', () => {
    withFixture(
      [
        fxRow({ inv: 'MB2025-086', invDate: new Date(2025, 2, 1), official: 'ANON DUP CO., LTD.', status: 'paid' }),
        fxRow({ inv: 'MB2025-089', invDate: new Date(2025, 2, 5), official: 'ANON DUP CO., LTD.', status: 'cancelled', rc: '' }),
      ],
      (parsed) => {
        expect(parsed.memberRows).toHaveLength(1);
        expect(parsed.invoices).toHaveLength(1);
        expect(parsed.invoices[0]!.origBillNo).toBe('MB2025-089'); // later date wins
        expect(parsed.invoices[0]!.targetStatus).toBe('void');
        expect(
          parsed.warnings.some((w) => w.code === 'duplicate_series_row_dropped' && w.rowIndex === 2),
        ).toBe(true);
      },
    );
  });

  it('same-series duplicate on the SAME date: paid wins the tie (both orders)', () => {
    const d = new Date(2025, 2, 1);
    const paidFirst = [
      fxRow({ inv: 'MB2025-086', invDate: d, official: 'ANON DUP CO., LTD.', status: 'paid' }),
      fxRow({ inv: 'MB2025-089', invDate: d, official: 'ANON DUP CO., LTD.', status: 'cancelled', rc: '' }),
    ];
    const paidSecond = [paidFirst[1]!, paidFirst[0]!];
    for (const rows of [paidFirst, paidSecond]) {
      withFixture(rows, (parsed) => {
        expect(parsed.invoices).toHaveLength(1);
        expect(parsed.invoices[0]!.origBillNo).toBe('MB2025-086');
        expect(parsed.invoices[0]!.targetStatus).toBe('paid');
      });
    }
  });

  it('keeps true Excel row indices across blank separator rows', () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 15), official: 'ANON ALPHA CO., LTD.' }),
        new Array<unknown>(33).fill(''), // blank Excel row 3
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 16), official: 'ANON BETA CO., LTD.' }),
      ],
      (parsed) => {
        const beta = parsed.memberRows.find((m) => m.companyName.startsWith('ANON BETA'))!;
        expect(beta.rowIndex).toBe(4); // header=1, alpha=2, blank=3, beta=4
      },
    );
  });
});

describe('plan-label fixups', () => {
  it("maps the literal 'Student' → 'Thai Alumni/Student' and 'Start-up Corporate' → 'Start-up'", () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'MS. ANON STU', plan: 'Student', entity: 'Individual', amount: 1000 }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON START CO., LTD.', plan: 'Start-up Corporate', amount: 10000 }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 7), official: 'ANON PREM CO., LTD.', plan: 'Premium Corporate', amount: 36000 }),
      ],
      (parsed) => {
        const tiers = new Map(parsed.memberRows.map((m) => [m.companyName, m.tier]));
        expect(tiers.get('MS. ANON STU')).toBe('Thai Alumni/Student');
        expect(tiers.get('ANON START CO., LTD.')).toBe('Start-up');
        expect(tiers.get('ANON PREM CO., LTD.')).toBe('Premium Corporate'); // untouched
        // the invoice docs carry the SAME fixed-up labels
        const docTiers = new Map(parsed.invoices.map((d) => [d.origBillNo, d.planTier]));
        expect(docTiers.get('MB2026-001')).toBe('Thai Alumni/Student');
        expect(docTiers.get('MB2026-002')).toBe('Start-up');
      },
    );
  });
});

describe('country default rules (empty / N/A cells)', () => {
  it('applies all 4 rules, records countryDefaults (rowIndex + rule, NO names), passes explicit values through', () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON WIDGETS (THAILAND) CO., LTD.', country: 'N/A' }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON NORDIC AB', country: '' }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 7), official: 'ANON HOLDINGS AB (PUBL)', country: 'N/A' }),
        fxRow({ inv: 'MB2026-004', invDate: new Date(2026, 0, 8), official: 'ANON TRADING (HONG KONG) LIMITED', country: 'N/A' }),
        fxRow({ inv: 'MB2026-005', invDate: new Date(2026, 0, 9), official: 'MR. ANON PERSON', country: 'N/A', plan: 'Individual', entity: 'Individual', amount: 6000 }),
        fxRow({ inv: 'MB2026-006', invDate: new Date(2026, 0, 10), official: 'ANON EXPLICIT PTE. LTD.', country: 'SINGAPORE' }),
      ],
      (parsed) => {
        const byName = new Map(parsed.memberRows.map((m) => [m.companyName, m]));
        expect(byName.get('ANON WIDGETS (THAILAND) CO., LTD.')!.country).toBe('THAILAND');
        expect(byName.get('ANON NORDIC AB')!.country).toBe('SWEDEN');
        expect(byName.get('ANON HOLDINGS AB (PUBL)')!.country).toBe('SWEDEN');
        expect(byName.get('ANON TRADING (HONG KONG) LIMITED')!.country).toBe('HONG KONG');
        expect(byName.get('MR. ANON PERSON')!.country).toBe('THAILAND');
        expect(byName.get('ANON EXPLICIT PTE. LTD.')!.country).toBe('SINGAPORE');

        const rules = new Map(parsed.countryDefaults.map((d) => [d.rowIndex, d.rule]));
        expect(rules.get(2)).toBe('thailand_name');
        expect(rules.get(3)).toBe('swedish_ab');
        expect(rules.get(4)).toBe('swedish_ab');
        expect(rules.get(5)).toBe('hong_kong_name');
        expect(rules.get(6)).toBe('fallback_th');
        expect(rules.has(7)).toBe(false); // explicit country → NOT recorded
        // no PII in the defaults records
        expect(JSON.stringify(parsed.countryDefaults)).not.toContain('ANON');
      },
    );
  });
});

describe('Swedish-AB Thai-country correction (operator decision 2026-07-29)', () => {
  // Generic rule (NO name-keyed override, PII rule): explicit THAILAND country +
  // AB-suffixed name + a PRESENT tax id that is NOT Thai-TIN-shaped (digits ≠
  // 12/13) → the country cell is wrong; treat as SWEDEN. The tax id then flows
  // through as a foreign tax id (validate.ts allows 1–50 chars for non-TH).
  it('fires for AB-suffix + explicit THAILAND + 10-digit tax id → SWEDEN + recorded', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON SVENSK AB', country: 'THAILAND', taxId: '0105-561234' })],
      (parsed) => {
        const m = parsed.memberRows[0]!;
        expect(m.country).toBe('SWEDEN');
        expect(m.taxId).toBe('0105-561234'); // preserved — foreign tax id path
        expect(parsed.countryDefaults).toEqual([
          { rowIndex: 2, rule: 'swedish_ab_thai_country_corrected' },
        ]);
        expect(JSON.stringify(parsed.countryDefaults)).not.toContain('ANON');
      },
    );
  });

  it('does NOT fire for AB-suffix + THAILAND + empty/zero/N-A tax id (the consulting-AB row stays TH)', () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON CONSULT AB', country: 'THAILAND', taxId: '' }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON NOLL AB', country: 'THAILAND', taxId: 0 }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 7), official: 'ANON EJ AB', country: 'THAILAND', taxId: 'N/A' }),
      ],
      (parsed) => {
        for (const m of parsed.memberRows) expect(m.country).toBe('THAILAND');
        expect(parsed.countryDefaults).toEqual([]);
      },
    );
  });

  it('does NOT fire for AB-suffix + THAILAND + a Thai-shaped (12/13-digit) tax id', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON THAI AB', country: 'THAILAND', taxId: '0105561234560' })],
      (parsed) => {
        expect(parsed.memberRows[0]!.country).toBe('THAILAND');
        expect(parsed.countryDefaults).toEqual([]);
      },
    );
  });

  it('non-AB name + bad TH tax id → country untouched, still a fail-loud validation error', () => {
    const RESOLVER = buildTierResolver([
      { planId: 'regular', nameEn: 'Regular Corporate', memberTypeScope: 'company' },
    ]);
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON BROKEN CO., LTD.', country: 'THAILAND', taxId: '0105-561234' })],
      (parsed) => {
        expect(parsed.memberRows[0]!.country).toBe('THAILAND');
        expect(parsed.countryDefaults).toEqual([]);
        const report = validateRows(parsed.memberRows, RESOLVER);
        expect(
          report.issues.some(
            (i) => i.severity === 'error' && i.field === 'taxId' && i.code === 'taxId.th_wrong_format',
          ),
        ).toBe(true);
      },
    );
  });
});

describe('mockup contact email — slugify + collision', () => {
  it('slugifies the official name into <slug>@pending.swecham.zyncdata.app', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON ALPHA CO., LTD.' })],
      (parsed) => {
        expect(parsed.memberRows[0]!.contactEmail).toBe(
          'anon-alpha-co-ltd@pending.swecham.zyncdata.app',
        );
      },
    );
  });

  it("appends '-2' on slug collision (deterministic sorted-company order) and caps the slug at 50 chars", () => {
    const long = 'ANON VERY LONG COMPANY NAME THAT KEEPS GOING AND GOING AND GOING CO., LTD.';
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON GAMMA LTD' }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON-GAMMA, LTD.' }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 7), official: long }),
      ],
      (parsed) => {
        const emails = parsed.memberRows.map((m) => m.contactEmail).sort();
        expect(emails).toContain('anon-gamma-ltd@pending.swecham.zyncdata.app');
        expect(emails).toContain('anon-gamma-ltd-2@pending.swecham.zyncdata.app');
        // sorted company keys: 'ANON GAMMA LTD' (space < '-') gets the base slug
        const gamma = parsed.memberRows.find((m) => m.companyName === 'ANON GAMMA LTD')!;
        expect(gamma.contactEmail).toBe('anon-gamma-ltd@pending.swecham.zyncdata.app');
        const longMember = parsed.memberRows.find((m) => m.companyName === long)!;
        const localPart = longMember.contactEmail.split('@')[0]!;
        expect(localPart.length).toBeLessThanOrEqual(50);
        expect(localPart.endsWith('-')).toBe(false);
      },
    );
  });

  it('invoice docs carry the member’s synthesized email as the join key', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON ALPHA CO., LTD.' })],
      (parsed) => {
        expect(parsed.invoices[0]!.contactEmail).toBe(parsed.memberRows[0]!.contactEmail);
      },
    );
  });
});

describe('date cells — LOCAL components (no −1 day shift)', () => {
  it('a Date at local midnight round-trips to the same calendar date', () => {
    // Under Asia/Bangkok (UTC+7) toISOString() on this Date yields the PREVIOUS
    // day — the exact Round-2 bug. The reader must use local components.
    const localMidnight = new Date(2026, 0, 15);
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: localMidnight, payDate: localMidnight, official: 'ANON ALPHA CO., LTD.' })],
      (parsed) => {
        expect(parsed.memberRows[0]!.registrationDate).toBe('2026-01-15');
        expect(parsed.invoices[0]!.issueDate).toBe('2026-01-15');
        expect(parsed.invoices[0]!.paymentDate).toBe('2026-01-15');
      },
    );
  });
});

describe('invoice selection scope', () => {
  it('2026 rows are ALWAYS selected (even for an Inactive member, e.g. a void bill)', () => {
    withFixture(
      [
        fxRow({
          inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON GONE CO., LTD.',
          memberStatus: 'Inactive', status: 'Cancelled', rc: '',
        }),
      ],
      (parsed) => {
        expect(parsed.invoices).toHaveLength(1);
        expect(parsed.invoices[0]!.targetStatus).toBe('void'); // 'Cancelled' capitalized in the sheet
      },
    );
  });

  it('a 2025-only ACTIVE member contributes its 2025 doc; a 2025-only INACTIVE member contributes none', () => {
    withFixture(
      [
        fxRow({ inv: 'MB2025-010', invDate: new Date(2025, 4, 1), official: 'ANON ROLLING CO., LTD.', memberStatus: 'Active' }),
        fxRow({ inv: 'MB2025-011', invDate: new Date(2025, 4, 2), official: 'ANON LEFT CO., LTD.', memberStatus: 'Inactive', status: 'paid' }),
      ],
      (parsed) => {
        expect(parsed.invoices).toHaveLength(1);
        expect(parsed.invoices[0]!.origBillNo).toBe('MB2025-010');
        // the inactive 2025-only company is STILL a member row (directory record)
        expect(parsed.memberRows).toHaveLength(2);
      },
    );
  });

  it("maps paid/unpaid/cancelled → paid/issued/void and errors on anything else", () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON A CO., LTD.', status: 'paid' }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON B CO., LTD.', status: 'unpaid', rc: '', payDate: '' }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 7), official: 'ANON C CO., LTD.', status: 'Cancelled', rc: '' }),
        fxRow({ inv: 'MB2026-004', invDate: new Date(2026, 0, 8), official: 'ANON D CO., LTD.', status: 'pending', rc: '' }),
      ],
      (parsed) => {
        const byNo = new Map(parsed.invoices.map((d) => [d.origBillNo, d.targetStatus]));
        expect(byNo.get('MB2026-001')).toBe('paid');
        expect(byNo.get('MB2026-002')).toBe('issued');
        expect(byNo.get('MB2026-003')).toBe('void');
        expect(byNo.has('MB2026-004')).toBe(false); // unknown status → no doc
        expect(
          parsed.errors.some((e) => e.code === 'invoice_status_unknown' && e.rowIndex === 5),
        ).toBe(true);
      },
    );
  });

  it("treats Ref RC '0' / '0.0' / empty as null and keeps a real RC number", () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON A CO., LTD.', rc: 0 }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON B CO., LTD.', rc: '0.0' }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 7), official: 'ANON C CO., LTD.', rc: 'RC2026-100' }),
      ],
      (parsed) => {
        const byNo = new Map(parsed.invoices.map((d) => [d.origBillNo, d.origReceiptNo]));
        expect(byNo.get('MB2026-001')).toBeNull();
        expect(byNo.get('MB2026-002')).toBeNull();
        expect(byNo.get('MB2026-003')).toBe('RC2026-100');
      },
    );
  });
});

describe('planYear derivation (calendar year of Inv Date — fiscal year starts month 1)', () => {
  it('a 2025-series bill issued in calendar 2024 gets planYear 2024 (doc AND member anchor)', () => {
    withFixture(
      [
        fxRow({ inv: 'MB2025-004', invDate: new Date(2024, 11, 20), official: 'ANON EARLY CO., LTD.', memberStatus: 'Active' }),
        fxRow({ inv: 'MB2026-050', invDate: new Date(2026, 2, 3), official: 'ANON LATER CO., LTD.' }),
      ],
      (parsed) => {
        const early = parsed.invoices.find((d) => d.origBillNo === 'MB2025-004')!;
        expect(early.planYear).toBe(2024);
        const later = parsed.invoices.find((d) => d.origBillNo === 'MB2026-050')!;
        expect(later.planYear).toBe(2026);
        // member anchor plan-year keyed the way validateRows groups (lowercase collapse)
        expect(parsed.planYearByCompanyKey.get('anon early co., ltd.')).toBe(2024);
        expect(parsed.planYearByCompanyKey.get('anon later co., ltd.')).toBe(2026);
      },
    );
  });
});

describe('money invariants (amount+vat≈total ±0.02 · vat≈7% ±0.5)', () => {
  it('flags a total that does not equal amount+vat', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON A CO., LTD.', amount: 16000, vat: 1120, total: 18000 })],
      (parsed) => {
        expect(parsed.errors.some((e) => e.code === 'money_total_mismatch' && e.rowIndex === 2)).toBe(true);
      },
    );
  });

  it('flags a VAT that is not 7% of the amount', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON A CO., LTD.', amount: 16000, vat: 999, total: 16999 })],
      (parsed) => {
        expect(parsed.errors.some((e) => e.code === 'money_vat_not_7pct' && e.rowIndex === 2)).toBe(true);
      },
    );
  });

  it('accepts a consistent 7%-VAT row (zero errors)', () => {
    withFixture(
      [fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON A CO., LTD.', amount: 36000, vat: 2520, total: 38520 })],
      (parsed) => {
        expect(parsed.errors).toEqual([]);
      },
    );
  });
});

describe('sheet cell fixups (verified against the real workbook 2026-07-29)', () => {
  it("treats an all-zero Tax ID cell (Excel numeric 0 — 59 real rows) as 'no TIN'", () => {
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON ZERO CO., LTD.', taxId: 0 }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON REAL CO., LTD.', taxId: '0105561234560' }),
      ],
      (parsed) => {
        const byName = new Map(parsed.memberRows.map((m) => [m.companyName, m.taxId]));
        expect(byName.get('ANON ZERO CO., LTD.')).toBe('');
        expect(byName.get('ANON REAL CO., LTD.')).toBe('0105561234560');
      },
    );
  });

  it("treats 'N/A' free-text cells (founded year / website / … — 52 real founded-year rows) as blank", () => {
    const row = fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: 'ANON NA CO., LTD.' });
    row[16] = 'N/A'; // website
    row[17] = 'N/A'; // founded year
    row[18] = 'N/A'; // turnover
    row[19] = 'N/A'; // capital
    row[20] = 'N/A'; // description
    row[26] = 'N/A'; // postal
    row[27] = 'N/A'; // province
    row[28] = 'N/A'; // city
    row[29] = 'N/A'; // address line 1
    row[30] = 'N/A'; // address line 2
    withFixture([row], (parsed) => {
      const m = parsed.memberRows[0]!;
      expect(m.website).toBe('');
      expect(m.foundedYear).toBe('');
      expect(m.turnover).toBe('');
      expect(m.registeredCapital).toBe('');
      expect(m.description).toBe('');
      expect(m.postalCode).toBe('');
      expect(m.province).toBe('');
      expect(m.city).toBe('');
      expect(m.addressLine1).toBe('');
      expect(m.addressLine2).toBe('');
    });
  });
});

describe('contact mapping', () => {
  it('falls back to companyName (≤100 chars) as first name when BOTH name cells are empty', () => {
    const long = `ANON ${'X'.repeat(120)} CO., LTD.`;
    withFixture(
      [
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 5), official: long, first: '', last: '' }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 6), official: 'ANON NAMED CO., LTD.', first: 'Nina', last: 'Named' }),
      ],
      (parsed) => {
        const anon = parsed.memberRows.find((m) => m.companyName === long)!;
        expect(anon.contactFirstName).toBe(long.slice(0, 100));
        expect(anon.contactLastName).toBe('');
        const named = parsed.memberRows.find((m) => m.companyName === 'ANON NAMED CO., LTD.')!;
        expect(named.contactFirstName).toBe('Nina');
        expect(named.contactLastName).toBe('Named');
      },
    );
  });
});

describe('end-to-end chain — memberRows validate cleanly through validateRows', () => {
  it('a representative synthetic sheet produces zero validation errors and resolved plan ids', () => {
    const RESOLVER = buildTierResolver([
      { planId: 'premium', nameEn: 'Premium Corporate', memberTypeScope: 'company' },
      { planId: 'regular', nameEn: 'Regular Corporate', memberTypeScope: 'company' },
      { planId: 'start-up', nameEn: 'Start-up', memberTypeScope: 'company' },
      { planId: 'individual', nameEn: 'Individual', memberTypeScope: 'individual' },
      { planId: 'thai-alumni', nameEn: 'Thai Alumni/Student', memberTypeScope: 'individual' },
    ]);
    withFixture(
      [
        fxRow({ inv: 'MB2025-001', invDate: new Date(2025, 0, 10), official: 'ANON ALPHA CO., LTD.', plan: 'Regular Corporate', taxId: '0105561234560' }),
        fxRow({ inv: 'MB2026-001', invDate: new Date(2026, 0, 12), official: 'ANON ALPHA CO., LTD.', plan: 'Premium Corporate', amount: 36000, taxId: '0105561234560' }),
        fxRow({ inv: 'MB2026-002', invDate: new Date(2026, 0, 13), official: 'ANON START CO., LTD.', plan: 'Start-up Corporate', amount: 10000 }),
        fxRow({ inv: 'MB2026-003', invDate: new Date(2026, 0, 14), official: 'MS. ANON STU', plan: 'Student', entity: 'Individual', amount: 1000, country: 'N/A', first: '', last: '' }),
      ],
      (parsed) => {
        expect(parsed.errors).toEqual([]);
        const report = validateRows(parsed.memberRows, RESOLVER);
        expect(report.stats.errorCount).toBe(0);
        expect(report.members).toHaveLength(3);
        const plans = new Map(report.members.map((m) => [m.companyName, m.planId]));
        expect(plans.get('ANON ALPHA CO., LTD.')).toBe('premium');
        expect(plans.get('ANON START CO., LTD.')).toBe('start-up');
        expect(plans.get('MS. ANON STU')).toBe('thai-alumni');
        // every member is groupable in planYearByCompanyKey under the validate key
        for (const m of report.members) {
          const key = m.companyName.trim().toLowerCase().replace(/\s+/g, ' ');
          expect(parsed.planYearByCompanyKey.has(key)).toBe(true);
        }
      },
    );
  });
});
