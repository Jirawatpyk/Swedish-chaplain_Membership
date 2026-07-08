import { describe, expect, it } from 'vitest';
import {
  BackfillCsvHeaderError,
  buildBackfillPlan,
  derivePeriod,
  normalizeCompanyName,
  parseBackfillCsv,
  type BackfillCsvRow,
  type MemberLookupEntry,
  type OpenCycleInfo,
} from '../../../scripts/lib/backfill-cycle-anchors-core';

describe('normalizeCompanyName', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeCompanyName('  ACME,  Inc.  ')).toBe('acme inc');
  });

  it('treats differently-punctuated variants of the same name as equal', () => {
    expect(normalizeCompanyName('Acme Co., Ltd.')).toBe(
      normalizeCompanyName('ACME CO LTD'),
    );
  });

  it('collapses multiple internal whitespace/punctuation runs to one space', () => {
    expect(normalizeCompanyName('Acme   &   Sons--Trading')).toBe('acme sons trading');
  });
});

describe('parseBackfillCsv', () => {
  it('parses a minimal 2-column CSV', () => {
    const csv = ['company_name,payment_date', 'Acme Co.,2026-03-16'].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      lineNumber: 2,
      companyNameRaw: 'Acme Co.',
      normalizedName: 'acme co',
      paymentDate: '2026-03-16',
      periodFromRaw: null,
      periodToRaw: null,
    });
  });

  it('parses explicit period_from/period_to columns when both are present', () => {
    const csv = [
      'company_name,payment_date,period_from,period_to',
      'Legacy Co,2025-11-01,2026-01-01,2026-12-31',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      periodFromRaw: '2026-01-01',
      periodToRaw: '2026-12-31',
    });
  });

  it('supports quoted fields with embedded commas', () => {
    const csv = [
      'company_name,payment_date',
      '"Acme, Inc.",2026-03-16',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]?.companyNameRaw).toBe('Acme, Inc.');
  });

  it('skips blank lines', () => {
    const csv = [
      'company_name,payment_date',
      '',
      'Acme Co.,2026-03-16',
      '   ',
      'Beta Co.,2026-04-01',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.rows).toHaveLength(2);
  });

  it('is header-order independent and case-insensitive', () => {
    const csv = [
      'PAYMENT_DATE,COMPANY_NAME',
      '2026-03-16,Acme Co.',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      companyNameRaw: 'Acme Co.',
      paymentDate: '2026-03-16',
    });
  });

  it('throws BackfillCsvHeaderError when a required column is missing', () => {
    const csv = ['company_name', 'Acme Co.'].join('\n');
    expect(() => parseBackfillCsv(csv)).toThrow(BackfillCsvHeaderError);
  });

  it('flags a row with a blank company name as an issue, excluded from rows', () => {
    const csv = ['company_name,payment_date', ',2026-03-16'].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([{ lineNumber: 2, reason: 'missing_company_name' }]);
  });

  it('flags a malformed payment_date as an issue', () => {
    const csv = ['company_name,payment_date', 'Acme Co.,16/03/2026'].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([{ lineNumber: 2, reason: 'invalid_payment_date' }]);
  });

  it('flags a row with only ONE of period_from/period_to set', () => {
    const csv = [
      'company_name,payment_date,period_from,period_to',
      'Acme Co.,2026-03-16,2026-01-01,',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([
      { lineNumber: 2, reason: 'incomplete_period_override' },
    ]);
  });

  it('flags period_to <= period_from as an issue', () => {
    const csv = [
      'company_name,payment_date,period_from,period_to',
      'Acme Co.,2026-03-16,2026-12-31,2026-01-01',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.issues).toEqual([{ lineNumber: 2, reason: 'period_order_invalid' }]);
  });

  it('reports correct line numbers across a mix of valid and invalid rows', () => {
    const csv = [
      'company_name,payment_date',
      'Acme Co.,2026-03-16',
      ',2026-04-01',
      'Beta Co.,2026-05-01',
    ].join('\n');
    const result = parseBackfillCsv(csv);
    expect(result.rows.map((r) => r.lineNumber)).toEqual([2, 4]);
    expect(result.issues).toEqual([{ lineNumber: 3, reason: 'missing_company_name' }]);
  });
});

describe('derivePeriod', () => {
  it('derives month-start + 12 months when no explicit period is given', () => {
    const period = derivePeriod({
      paymentDate: '2026-03-16',
      periodFromRaw: null,
      periodToRaw: null,
    });
    expect(period).toEqual({
      periodFrom: '2026-03-01T00:00:00.000Z',
      periodTo: '2027-03-01T00:00:00.000Z',
      source: 'derived_month_start_plus_12',
    });
  });

  it('prefers the explicit period_from/period_to override when present', () => {
    const period = derivePeriod({
      paymentDate: '2025-11-01',
      periodFromRaw: '2026-01-01',
      periodToRaw: '2026-12-31',
    });
    expect(period).toEqual({
      periodFrom: '2026-01-01T00:00:00.000Z',
      periodTo: '2026-12-31T00:00:00.000Z',
      source: 'explicit_override',
    });
  });

  it('derives from the payment month even when payment lands mid-month late in the year', () => {
    const period = derivePeriod({
      paymentDate: '2025-06-08',
      periodFromRaw: null,
      periodToRaw: null,
    });
    expect(period.periodFrom).toBe('2025-06-01T00:00:00.000Z');
    expect(period.periodTo).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('buildBackfillPlan', () => {
  const now = new Date('2026-07-09T12:00:00.000Z');

  function row(overrides: Partial<BackfillCsvRow>): BackfillCsvRow {
    return {
      lineNumber: 2,
      companyNameRaw: 'Acme Co.',
      normalizedName: 'acme co',
      paymentDate: '2026-03-16',
      periodFromRaw: null,
      periodToRaw: null,
      ...overrides,
    };
  }

  it('plans a reanchor for a matched member with an un-anchored open cycle', () => {
    const r = row({});
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const openCycleIndex = new Map<string, OpenCycleInfo>([
      ['member-1', { cycleId: 'cycle-1', status: 'upcoming', anchoredAt: null }],
    ]);

    const plan = buildBackfillPlan({ rows: [r], memberIndex, openCycleIndex, now });

    expect(plan.actions).toEqual([
      {
        kind: 'reanchor',
        row: r,
        memberId: 'member-1',
        companyName: 'Acme Co.',
        cycleId: 'cycle-1',
        newPeriodFrom: '2026-03-01T00:00:00.000Z',
        newPeriodTo: '2027-03-01T00:00:00.000Z',
        periodSource: 'derived_month_start_plus_12',
      },
    ]);
  });

  it('skips unmatched company names', () => {
    const r = row({});
    const plan = buildBackfillPlan({
      rows: [r],
      memberIndex: new Map(),
      openCycleIndex: new Map(),
      now,
    });
    expect(plan.actions).toEqual([{ kind: 'skip', row: r, reason: 'unmatched_name' }]);
  });

  it('skips an ambiguous name-normalisation collision without guessing', () => {
    const r = row({});
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', 'ambiguous'],
    ]);
    const plan = buildBackfillPlan({
      rows: [r],
      memberIndex,
      openCycleIndex: new Map(),
      now,
    });
    expect(plan.actions).toEqual([
      { kind: 'skip', row: r, reason: 'ambiguous_name_collision' },
    ]);
  });

  it('skips a matched member with no open cycle', () => {
    const r = row({});
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const plan = buildBackfillPlan({
      rows: [r],
      memberIndex,
      openCycleIndex: new Map(),
      now,
    });
    expect(plan.actions).toEqual([
      { kind: 'skip', row: r, reason: 'no_open_cycle', memberId: 'member-1' },
    ]);
  });

  it('skips a cycle that is already anchored (mirrors the repo guard)', () => {
    const r = row({});
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const openCycleIndex = new Map<string, OpenCycleInfo>([
      [
        'member-1',
        { cycleId: 'cycle-1', status: 'upcoming', anchoredAt: '2026-01-01T00:00:00.000Z' },
      ],
    ]);
    const plan = buildBackfillPlan({ rows: [r], memberIndex, openCycleIndex, now });
    expect(plan.actions).toEqual([
      { kind: 'skip', row: r, reason: 'already_anchored', memberId: 'member-1' },
    ]);
  });

  it('skips a future-dated payment (> today)', () => {
    const r = row({ paymentDate: '2026-12-18' });
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const openCycleIndex = new Map<string, OpenCycleInfo>([
      ['member-1', { cycleId: 'cycle-1', status: 'upcoming', anchoredAt: null }],
    ]);
    const plan = buildBackfillPlan({ rows: [r], memberIndex, openCycleIndex, now });
    expect(plan.actions).toEqual([
      { kind: 'skip', row: r, reason: 'future_dated_payment' },
    ]);
  });

  it('keeps the MAX(payment_date) row among duplicates and supersedes the rest', () => {
    const early = row({ lineNumber: 2, paymentDate: '2026-01-10' });
    const late = row({ lineNumber: 3, paymentDate: '2026-03-16' });
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const openCycleIndex = new Map<string, OpenCycleInfo>([
      ['member-1', { cycleId: 'cycle-1', status: 'upcoming', anchoredAt: null }],
    ]);
    const plan = buildBackfillPlan({
      rows: [early, late],
      memberIndex,
      openCycleIndex,
      now,
    });

    // Sorted by lineNumber: early (superseded) first, then late (reanchor).
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toEqual({
      kind: 'skip',
      row: early,
      reason: 'duplicate_superseded',
    });
    expect(plan.actions[1]).toMatchObject({ kind: 'reanchor', row: late });
  });

  it('the workbook anomaly: a future-dated duplicate must NOT eclipse the legitimate earlier payment', () => {
    // Real anomaly (spec 2026-07-08): a legitimate early payment has a
    // duplicate row that is ALSO future-dated (data-entry error). If de-dup
    // ran first and naively kept MAX(payment_date), the bogus future row
    // would win the tie-break and the WHOLE company would be wrongly
    // skipped. Filtering future-dated rows out first lets the legitimate
    // earlier row survive de-dup (there's nothing left to dedupe against)
    // and reanchor normally.
    const legit = row({ lineNumber: 2, paymentDate: '2025-06-08' });
    const bogusFuture = row({ lineNumber: 3, paymentDate: '2026-12-18' });
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const openCycleIndex = new Map<string, OpenCycleInfo>([
      ['member-1', { cycleId: 'cycle-1', status: 'upcoming', anchoredAt: null }],
    ]);
    const plan = buildBackfillPlan({
      rows: [legit, bogusFuture],
      memberIndex,
      openCycleIndex,
      now,
    });

    // Sorted by lineNumber: legit (line 2, reanchored) then bogusFuture (line 3, skipped).
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toMatchObject({ kind: 'reanchor', row: legit });
    expect(plan.actions[1]).toEqual({
      kind: 'skip',
      row: bogusFuture,
      reason: 'future_dated_payment',
    });
  });

  it('honours an explicit period_from/period_to override in the resulting reanchor action', () => {
    const r = row({
      paymentDate: '2025-11-01',
      periodFromRaw: '2026-01-01',
      periodToRaw: '2026-12-31',
    });
    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>([
      ['acme co', { memberId: 'member-1', companyName: 'Acme Co.' }],
    ]);
    const openCycleIndex = new Map<string, OpenCycleInfo>([
      ['member-1', { cycleId: 'cycle-1', status: 'upcoming', anchoredAt: null }],
    ]);
    const plan = buildBackfillPlan({ rows: [r], memberIndex, openCycleIndex, now });
    expect(plan.actions).toEqual([
      {
        kind: 'reanchor',
        row: r,
        memberId: 'member-1',
        companyName: 'Acme Co.',
        cycleId: 'cycle-1',
        newPeriodFrom: '2026-01-01T00:00:00.000Z',
        newPeriodTo: '2026-12-31T00:00:00.000Z',
        periodSource: 'explicit_override',
      },
    ]);
  });
});
