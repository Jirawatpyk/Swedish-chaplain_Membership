/**
 * Stage-3 importer — Excel header → RawRow column mapping (spec § 2).
 *
 * Pure (no xlsx import — the CLI parses the workbook and passes plain arrays),
 * so the alias matching + full-name split are unit-tested without I/O (spec § 8).
 * The real Excel headers are confirmed against the workbook at run time; this
 * provides documented aliases + FAILS LOUD (missingRequired) when a required
 * column can't be matched, so the operator fixes the header/map before --commit.
 */
import type { RawRow } from './validate';

type Field = keyof Omit<RawRow, 'rowIndex'>;

const HEADER_ALIASES: Readonly<Record<Field, readonly string[]>> = {
  companyName: ['company name', 'company', 'organisation', 'organization', 'member', 'member name'],
  country: ['country', 'nation'],
  taxId: ['tax id', 'tax number', 'tin', 'vat', 'taxpayer id', 'tax id no', 'tax id number', 'vat number'],
  tier: ['membership tier', 'tier', 'plan', 'membership', 'package', 'membership type', 'member type'],
  turnover: ['turnover', 'annual turnover', 'revenue', 'annual revenue'],
  registrationDate: ['registration date', 'registered', 'join date', 'member since', 'date joined', 'registered date'],
  memberLocale: ['member locale', 'company language', 'locale'],
  city: ['city', 'town'],
  province: ['province', 'state', 'region'],
  postalCode: ['postal code', 'postcode', 'zip', 'zip code', 'post code'],
  contactFirstName: ['first name', 'firstname', 'given name', 'contact first name'],
  contactLastName: ['last name', 'lastname', 'surname', 'family name', 'contact last name'],
  contactEmail: ['email', 'e mail', 'email address', 'contact email'],
  contactPhone: ['phone', 'mobile', 'tel', 'telephone', 'phone number', 'contact phone', 'mobile no', 'mobile number', 'tel no'],
  contactRole: ['role', 'title', 'position', 'job title', 'designation'],
  contactLanguage: ['language', 'preferred language', 'contact language'],
  isPrimary: ['primary', 'primary contact', 'is primary', 'main contact'],
};

const FULLNAME_ALIASES: readonly string[] = ['full name', 'name', 'contact name', 'contact', 'person'];
/** A header MUST resolve for these or the import refuses (member-level + email). */
const REQUIRED_FIELDS: readonly Field[] = ['companyName', 'country', 'tier', 'registrationDate', 'contactEmail'];
const ALL_FIELDS = Object.keys(HEADER_ALIASES) as Field[];

/** lowercase, collapse every run of non-alphanumerics to a single space. */
function normHeader(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface ColumnMap {
  readonly index: Readonly<Record<Field, number | null>>;
  readonly fullNameIndex: number | null;
  readonly unmappedHeaders: readonly string[];
  /** Required columns (or a usable name source) that could not be matched. */
  readonly missingRequired: readonly string[];
}

export function buildColumnMap(headers: readonly string[]): ColumnMap {
  const norm = headers.map(normHeader);
  const index = {} as Record<Field, number | null>;
  const matchedCols = new Set<number>();

  for (const field of ALL_FIELDS) {
    const aliases = HEADER_ALIASES[field];
    const at = norm.findIndex((h) => h.length > 0 && aliases.includes(h));
    index[field] = at === -1 ? null : at;
    if (at !== -1) matchedCols.add(at);
  }

  const fullNameIndex = norm.findIndex((h) => h.length > 0 && FULLNAME_ALIASES.includes(h));
  if (fullNameIndex !== -1) matchedCols.add(fullNameIndex);

  const unmappedHeaders = headers.filter((_, i) => norm[i]!.length > 0 && !matchedCols.has(i));

  const missingRequired = REQUIRED_FIELDS.filter((f) => index[f] === null) as string[];
  // A contact needs a name: either (first AND last) OR a full-name column.
  const hasFirstLast = index.contactFirstName !== null && index.contactLastName !== null;
  if (!hasFirstLast && fullNameIndex === -1) missingRequired.push('contactName');

  return { index, fullNameIndex: fullNameIndex === -1 ? null : fullNameIndex, unmappedHeaders, missingRequired };
}

function cellToString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    // SheetJS cellDates builds dates at LOCAL midnight. Use LOCAL components (NOT
    // toISOString, which is UTC) so the date matches the spreadsheet's displayed
    // value — under Asia/Bangkok (UTC+7) toISOString would shift to the previous
    // day (off-by-one). parseGregorianDate then validates this strict local-ISO.
    const y = v.getFullYear();
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    const da = String(v.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return String(v).trim();
}

/** Split a single "Full Name" cell into first + rest-as-last (spec § 2). */
function splitFullName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: full.trim(), lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

/**
 * Map parsed data rows (array-of-arrays, no header row) to RawRow[]. `firstExcelRow`
 * is the 1-based Excel row number of `dataRows[0]` (so report rowIndex points at the
 * real spreadsheet row). Entirely-blank rows are dropped.
 */
export function mapDataRows(
  dataRows: readonly (readonly unknown[])[],
  map: ColumnMap,
  firstExcelRow: number,
): RawRow[] {
  const at = (row: readonly unknown[], i: number | null): string =>
    i === null ? '' : cellToString(row[i]);

  const out: RawRow[] = [];
  dataRows.forEach((row, i) => {
    if (row.every((c) => cellToString(c).length === 0)) return; // skip blank row

    let firstName = at(row, map.index.contactFirstName);
    let lastName = at(row, map.index.contactLastName);
    if (firstName.length === 0 && lastName.length === 0 && map.fullNameIndex !== null) {
      const split = splitFullName(cellToString(row[map.fullNameIndex]));
      firstName = split.firstName;
      lastName = split.lastName;
    }

    out.push({
      rowIndex: firstExcelRow + i,
      companyName: at(row, map.index.companyName),
      country: at(row, map.index.country),
      taxId: at(row, map.index.taxId),
      tier: at(row, map.index.tier),
      turnover: at(row, map.index.turnover),
      registrationDate: at(row, map.index.registrationDate),
      memberLocale: at(row, map.index.memberLocale),
      city: at(row, map.index.city),
      province: at(row, map.index.province),
      postalCode: at(row, map.index.postalCode),
      contactFirstName: firstName,
      contactLastName: lastName,
      contactEmail: at(row, map.index.contactEmail),
      contactPhone: at(row, map.index.contactPhone),
      contactRole: at(row, map.index.contactRole),
      contactLanguage: at(row, map.index.contactLanguage),
      isPrimary: at(row, map.index.isPrimary),
    });
  });
  return out;
}
