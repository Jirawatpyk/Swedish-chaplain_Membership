/**
 * Stage-3 importer — columns unit tests (spec § 2 / § 8).
 */
import { describe, expect, it } from 'vitest';

const { buildColumnMap, mapDataRows } = await import('@/../scripts/import-members/columns');

const FULL_HEADERS = [
  'Company Name', 'Country', 'Tax ID', 'Membership Tier', 'Turnover',
  'Registration Date', 'City', 'Province', 'Postal Code',
  'First Name', 'Last Name', 'Email', 'Phone', 'Role', 'Language', 'Primary',
];

describe('buildColumnMap (spec § 2)', () => {
  it('resolves documented headers (case/spacing/punct-insensitive)', () => {
    const m = buildColumnMap(FULL_HEADERS);
    expect(m.missingRequired).toEqual([]);
    expect(m.index.companyName).toBe(0);
    expect(m.index.contactEmail).toBe(11);
    expect(m.index.tier).toBe(3);
    expect(m.unmappedHeaders).toEqual([]);
  });

  it('matches aliases ("Organisation"/"E-Mail"/"Plan"/"Surname")', () => {
    const m = buildColumnMap(['Organisation', 'Country', 'Plan', 'Member Since', 'E-Mail', 'Surname', 'Given Name']);
    expect(m.index.companyName).toBe(0);
    expect(m.index.tier).toBe(2);
    expect(m.index.registrationDate).toBe(3);
    expect(m.index.contactEmail).toBe(4);
    expect(m.index.contactLastName).toBe(5);
    expect(m.index.contactFirstName).toBe(6);
    expect(m.missingRequired).toEqual([]);
  });

  it('reports missingRequired when a required column is absent', () => {
    const m = buildColumnMap(['Company Name', 'Country', 'First Name', 'Last Name', 'Email']);
    expect(m.missingRequired).toContain('tier');
    expect(m.missingRequired).toContain('registrationDate');
  });

  it('accepts a single Full Name column (no first/last) as the name source', () => {
    const m = buildColumnMap(['Company', 'Country', 'Tier', 'Registration Date', 'Email', 'Full Name']);
    expect(m.missingRequired).toEqual([]);
    expect(m.fullNameIndex).toBe(5);
  });

  it('flags missing contactName when neither first/last nor full-name present', () => {
    const m = buildColumnMap(['Company', 'Country', 'Tier', 'Registration Date', 'Email']);
    expect(m.missingRequired).toContain('contactName');
  });

  it('lists unmapped headers (so the operator confirms the map)', () => {
    const m = buildColumnMap([...FULL_HEADERS, 'Internal Notes XYZ']);
    expect(m.unmappedHeaders).toEqual(['Internal Notes XYZ']);
  });
});

// The real "Member Data New" headers (cols A..AE; trailing empty cols omitted).
const TSCC_HEADERS = [
  'Name', 'Code', 'Company', 'Tax ID', 'Member Type',
  'Latest Invoice No.', 'Latest INV Date\n(Membership Start)', 'Invoice Status',
  'Receipt No.', 'Receipt Date\n(Payment Date)', 'Renewal date',
  'Country (ISO post)', 'Webiste', 'Founded year', 'Annual Turnover (THB)',
  'Capital registeration', 'Description', 'Note (Admin only)', 'Plan',
  'Member Status', 'Registration date', 'Plan Year (Current)', 'Member In 2025',
  'Postal code', 'Province / State', 'City / Distrct', 'Address Line 1',
  'Address Line 2', 'First name (Primary contact)', 'Last name (Primary contact)',
  'Email (Primary contact)',
];

describe('buildColumnMap — real TSCC "Member Data New" sheet', () => {
  it('resolves the real headers with no missing required column', () => {
    const m = buildColumnMap(TSCC_HEADERS);
    expect(m.missingRequired).toEqual([]);
    expect(m.index.companyName).toBe(2); // C Company
    expect(m.index.legalEntityType).toBe(4); // E Member Type
    expect(m.index.tier).toBe(18); // S Plan (NOT E)
    expect(m.index.country).toBe(11); // L Country (ISO post)
    expect(m.index.turnover).toBe(14); // O Annual Turnover (THB)
    expect(m.index.registeredCapital).toBe(15); // P Capital registeration
    expect(m.index.website).toBe(12); // M Webiste (typo header)
    expect(m.index.foundedYear).toBe(13); // N Founded year
    expect(m.index.description).toBe(16); // Q Description
    expect(m.index.status).toBe(19); // T Member Status
    expect(m.index.registrationDate).toBe(6); // G — NOT the empty U (col 20)
    expect(m.index.postalCode).toBe(23); // X
    expect(m.index.province).toBe(24); // Y Province / State
    expect(m.index.city).toBe(25); // Z City / Distrct (typo header)
    expect(m.index.addressLine1).toBe(26); // AA
    expect(m.index.addressLine2).toBe(27); // AB
    expect(m.index.contactEmail).toBe(30); // AE Email (Primary contact)
    expect(m.fullNameIndex).toBe(0); // A Name (contact-name fallback)
  });

  it('does not let "Member Type" collide with tier (trap #3)', () => {
    const m = buildColumnMap(['Company', 'Member Type', 'Plan', 'Country', 'Registration Date', 'Email']);
    expect(m.index.legalEntityType).toBe(1);
    expect(m.index.tier).toBe(2); // Plan — NOT Member Type
  });
});

describe('mapDataRows (spec § 2)', () => {
  it('extracts RawRow fields + 1-based rowIndex; Date cell → LOCAL-component ISO (no UTC off-by-one)', () => {
    const map = buildColumnMap(FULL_HEADERS);
    // SheetJS cellDates builds dates at LOCAL midnight — mirror that with
    // new Date(y, m, d) so the result is deterministic in any test TZ and proves
    // we format from LOCAL components (toISOString would shift under UTC+7/-5).
    const rows = mapDataRows(
      [['Acme', 'TH', '0105500000000', 'Premium', '1000000', new Date(2026, 0, 15),
        'Bangkok', 'BKK', '10110', 'Jane', 'Doe', 'jane@acme.test', '+66812345678', 'CEO', 'en', 'yes']],
      map,
      2, // header is Excel row 1; first data row = 2
    );
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.rowIndex).toBe(2);
    expect(r.companyName).toBe('Acme');
    expect(r.registrationDate).toBe('2026-01-15');
    expect(r.contactEmail).toBe('jane@acme.test');
    expect(r.isPrimary).toBe('yes');
  });

  it('splits a Full Name column into first + rest-as-last', () => {
    const map = buildColumnMap(['Company', 'Country', 'Tier', 'Registration Date', 'Email', 'Full Name']);
    const rows = mapDataRows(
      [['Acme', 'TH', 'Premium', '2026-01-01', 'a@b.test', 'Somchai Jaidee Junior']],
      map,
      2,
    );
    expect(rows[0]!.contactFirstName).toBe('Somchai');
    expect(rows[0]!.contactLastName).toBe('Jaidee Junior');
  });

  it('skips entirely-blank rows', () => {
    const map = buildColumnMap(FULL_HEADERS);
    const rows = mapDataRows([['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']], map, 2);
    expect(rows).toHaveLength(0);
  });

  it('keeps rowIndex aligned to the real Excel row across an interior blank gap (item 15)', () => {
    const map = buildColumnMap(FULL_HEADERS);
    const blank = Array(FULL_HEADERS.length).fill('');
    const dataRow = (email: string) =>
      ['Acme', 'SE', '', 'Premium', '', '2026-01-01', '', '', '', 'A', 'B', email, '', '', '', 'yes'];
    // Excel: row1=header, row2=A, row3=BLANK, row4=B. With blankrows:true the blank
    // slot is preserved, so B must report rowIndex 4 (not 3).
    const rows = mapDataRows([dataRow('a@x.test'), blank, dataRow('b@x.test')], map, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rowIndex).toBe(2);
    expect(rows[1]!.rowIndex).toBe(4); // NOT 3 — the blank row's slot is preserved
  });
});
