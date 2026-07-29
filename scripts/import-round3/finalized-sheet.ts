/**
 * Round-3 importer — 'Finalized Member' sheet reader/transformer
 * (docs/import/ROUND3_PLAN.md, operator-approved 2026-07-29).
 *
 * The sheet is 1 row = 1 historical invoice (MB2025 / MB2026 series), ~252 rows
 * across ~150 companies. This module:
 *   1. reads the workbook (cellDates) and ASSERTS the header text at every FIXED
 *      column index (the sheet has TWO duplicate header pairs — 'Member Status'
 *      idx 11/22 and 'Member Type' idx 12/14 — so alias-based mapping via
 *      buildColumnMap silently mis-maps; fixed indexes + a drift assert instead);
 *   2. groups rows by Official name (trim+UPPERCASE key), keeping at most one
 *      row per series (later Inv Date wins; 'paid' wins a same-date tie — the
 *      ROUND3_PLAN duplicate-series rule) — the LATEST row (2026 else 2025)
 *      supplies ALL member fields;
 *   3. emits one `RawRow` per company for the existing validateRows/commitMembers
 *      pipeline, with a synthesized mockup contact email
 *      `<company-slug>@pending.swecham.zyncdata.app` (domain has no MX — mail
 *      never actually delivers; admin verifies + replaces post-import);
 *   4. selects the Part-2 invoice documents (all 2026-series rows + the
 *      2025-series row of Active companies with no 2026 row), applies any
 *      OPERATOR_MONEY_CORRECTIONS (operator-decided replacement triples for
 *      rows whose sheet money is unrepresentable — each application is a
 *      report WARNING; the operator's Excel file is never edited), and
 *      validates the money invariants SATANG-EXACT (vat ===
 *      half-away-from-zero(amount×7%), amount+vat === total — see ./money.ts;
 *      a passing row is guaranteed to mint byte-identical numbers through
 *      issueInvoice).
 *
 * PII: company names/emails live ONLY in the in-memory RawRow/Round3InvoiceDoc
 * structures (like ValidatedMember). `countryDefaults`, `warnings` and `errors`
 * carry rowIndex + code ONLY — safe for the PII-free report (spec § 7).
 */
import * as XLSX from 'xlsx';
import { cellToString } from '../import-members/columns';
import { countryNameToCode } from '../import-members/coerce';
import type { RawRow } from '../import-members/validate';
import { sheetMoneyErrors, thbToSatang } from './money';

export const FINALIZED_SHEET_NAME = 'Finalized Member';

/** Mockup-email domain (operator decision #4 — no MX record, mail cannot deliver). */
export const MOCKUP_EMAIL_DOMAIN = 'pending.swecham.zyncdata.app';

/**
 * Expected header per FIXED column index, normalized like columns.ts normHeader
 * (lowercase, non-alphanumeric runs → single space). Verified against the real
 * workbook 2026-07-29. Any drift (rename / insert / reorder) throws before a
 * single cell is mapped — never import silently mis-aligned columns.
 */
const EXPECTED_HEADERS: readonly string[] = [
  'inv no', // 0
  'inv date', // 1
  'bill to', // 2
  'amount', // 3 (VAT-exclusive)
  'vat 7', // 4
  'total', // 5
  'due date', // 6
  'status', // 7 (paid/unpaid/cancelled)
  'ref tax invoice no', // 8 (RC number; '0'/blank = none)
  'payment date', // 9
  'official name', // 10 (company key)
  'member status', // 11 (Active/Inactive — the REAL one; idx 22 is an empty dup)
  'member type', // 12 (Rolling/Full Year — NOT imported; duplicate header of 14)
  'tax id', // 13
  'member type', // 14 (= legal entity type)
  'country iso post', // 15
  'webiste', // 16 (sheet's own typo)
  'founded year', // 17
  'annual turnover thb', // 18
  'capital registeration', // 19 (sheet's own typo)
  'description', // 20
  'plan', // 21
  'member status', // 22 (empty duplicate)
  'registration date', // 23 (unused — anchor is Inv Date, decision #5)
  'plan year current', // 24 (unused)
  'member in 2025', // 25 (unused)
  'postal code', // 26
  'province state', // 27
  'city distrct', // 28 (sheet's own typo)
  'address line 1', // 29
  'address line 2', // 30
  'first name primary contact', // 31
  'last name primary contact', // 32
];

/** Replicates columns.ts normHeader (module-private there): lowercase, collapse
 *  every run of non-alphanumerics to a single space. */
function normHeader(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Replicates validate.ts normCompanyKey (module-private there) — the key
 *  validateRows groups by, so `planYearByCompanyKey` joins 1:1 with its groups. */
export function normCompanyKeyForValidate(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export type CountryDefaultRule =
  | 'thailand_name' // company name contains '(THAILAND)'
  | 'swedish_ab' // name ends with ' AB' or contains 'AB (PUBL)'
  | 'hong_kong_name' // name contains '(HONG KONG)'
  | 'fallback_th' // everything else (individuals etc.)
  // Operator decision 2026-07-29: an AB-named company whose EXPLICIT country
  // cell says THAILAND but whose tax id is present and NOT Thai-TIN-shaped has
  // a wrong country cell → corrected to SWEDEN. Generic rule (no name keys).
  | 'swedish_ab_thai_country_corrected';

export interface CountryDefault {
  /** 1-based Excel row of the LATEST company row the default was applied to. */
  readonly rowIndex: number;
  readonly rule: CountryDefaultRule;
}

/** Report-safe issue — rowIndex + field + code ONLY (no PII, spec § 7). */
export interface Round3Issue {
  readonly rowIndex: number;
  readonly field: string;
  readonly code: string;
}

export type Round3InvoiceStatus = 'paid' | 'issued' | 'void';
export type Round3Series = '2025' | '2026';

/** One selected historical invoice document (consumed by the Part-2 invoice
 *  importer). Carries the company key + synthesized email IN MEMORY ONLY. */
export interface Round3InvoiceDoc {
  /** trim+UPPERCASE Official name — join/debug key. PII: never write to a report. */
  readonly companyKey: string;
  /** The member's synthesized mockup email — the join key to the imported member. */
  readonly contactEmail: string;
  readonly series: Round3Series;
  readonly origBillNo: string;
  /** Original RC number; '0' / '0.0' / blank → null. */
  readonly origReceiptNo: string | null;
  /** Inv Date as local-ISO YYYY-MM-DD (becomes the system issue_date). */
  readonly issueDate: string;
  /** The sheet's Due Date (report-only — the system will mint issue+30). */
  readonly dueDateExcel: string;
  readonly paymentDate: string | null;
  /** THB, VAT-exclusive (sheet 'Amount'). */
  readonly amountThb: number;
  readonly vatThb: number;
  readonly totalThb: number;
  readonly targetStatus: Round3InvoiceStatus;
  /** The row's Plan cell after literal fixups (Student → 'Thai Alumni/Student'). */
  readonly planTier: string;
  /** Calendar year of issueDate (tenant fiscal year starts month 1). */
  readonly planYear: number;
  /** 1-based Excel row the document came from. */
  readonly rowIndex: number;
}

export interface FinalizedMemberWorkbook {
  /** One RawRow per company (latest row wins) — feed straight into validateRows. */
  readonly memberRows: readonly RawRow[];
  readonly invoices: readonly Round3InvoiceDoc[];
  /** Per-member anchor plan-year (calendar year of the latest row's Inv Date),
   *  keyed like validateRows groups (normCompanyKeyForValidate). */
  readonly planYearByCompanyKey: ReadonlyMap<string, number>;
  readonly countryDefaults: readonly CountryDefault[];
  readonly warnings: readonly Round3Issue[];
  readonly errors: readonly Round3Issue[];
}

/**
 * Literal Plan-cell fixups (keyed by trim+lowercase). tier-resolution derives
 * aliases ONLY from the seeded planId + English plan name, so two sheet labels
 * cannot resolve on their own:
 *   - 'Student' — the catalogue has no student plan; it maps to thai-alumni
 *     (nameEn 'Thai Alumni/Student').
 *   - 'Start-up Corporate' — the seeded nameEn is 'Start-up' (the sheet appends
 *     'Corporate'); without the fixup all 31 rows error tier.unmapped.
 * Every other label ('Premium Corporate', 'Gold Partnership', …) matches a
 * seeded nameEn exactly and passes through untouched.
 */
const PLAN_LABEL_FIXUPS: Readonly<Record<string, string>> = {
  student: 'Thai Alumni/Student',
  'start-up corporate': 'Start-up',
};

function fixupPlanLabel(raw: string): string {
  return PLAN_LABEL_FIXUPS[raw.trim().toLowerCase()] ?? raw.trim();
}

/** Cells meaning "no country recorded" (default rules apply). */
const BLANK_COUNTRY_ALIASES: ReadonlySet<string> = new Set(['', 'n/a', 'na', '-']);

/** Swedish-company name signal shared by the blank-country default and the
 *  wrong-THAILAND correction rule below. */
function isSwedishAbName(companyName: string): boolean {
  const u = companyName.trim().toUpperCase();
  return u.endsWith(' AB') || u.includes('AB (PUBL)');
}

function defaultCountryFor(companyName: string): {
  readonly country: string;
  readonly rule: CountryDefaultRule;
} {
  const u = companyName.trim().toUpperCase();
  if (u.includes('(THAILAND)')) return { country: 'THAILAND', rule: 'thailand_name' };
  if (isSwedishAbName(u)) return { country: 'SWEDEN', rule: 'swedish_ab' };
  if (u.includes('(HONG KONG)')) return { country: 'HONG KONG', rule: 'hong_kong_name' };
  return { country: 'THAILAND', rule: 'fallback_th' };
}

/** Mirrors coerce.ts BLANK_TAX_ALIASES (module-private there) — cells that mean
 *  "no tax id recorded". */
const BLANK_TAX_ALIASES: ReadonlySet<string> = new Set(['', 'n/a', 'na', '-', 'none']);

/** True when a PRESENT tax-id cell can never be a Thai TIN: digits ≠ 12 (Excel
 *  leading-zero loss, pads to 13) and ≠ 13. Blank/zero/'N/A' cells return false
 *  — absence is NOT evidence of a wrong country (blast-radius guard: the real
 *  sheet has one AB-named consulting company with country THAILAND and no TIN,
 *  which must STAY TH). */
function isPresentNonThaiShapedTaxId(taxIdCell: string): boolean {
  if (BLANK_TAX_ALIASES.has(taxIdCell.trim().toLowerCase())) return false;
  const digits = taxIdCell.replace(/\D/g, '');
  return digits.length !== 12 && digits.length !== 13;
}

/** lowercase ASCII slug: non-alphanumeric runs → '-', trimmed, max 50 chars. */
function slugifyCompany(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'member';
}

const INV_SERIES_RE = /^MB(\d{4})-/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The sheet writes the literal 'N/A' into free-text cells (52 real founded-year
 *  rows, plus website/address/…). Blank it so it neither warns as "not a year"
 *  nor gets STORED verbatim as a website/postal-code value. Mirrors the
 *  operator-approved dataset extraction (`s()` nulls exactly 'N/A'). */
function blankNA(s: string): string {
  return s.trim().toUpperCase() === 'N/A' ? '' : s;
}

/** 59 real rows carry Excel numeric 0 in the Tax ID column — TSCC's "no TIN"
 *  marker. An all-zero cell must read as ABSENT, not as a malformed Thai TIN
 *  (otherwise every such TH company errors taxId.th_wrong_format and blocks
 *  --commit; the plan expects tax_id NULL + a missing_for_company warning). */
function blankZeroTaxId(s: string): string {
  const digits = s.replace(/\D/g, '');
  return digits.length > 0 && /^0+$/.test(digits) ? '' : s;
}

function parseMoney(raw: string): number | null {
  const t = raw.replace(/[,\s]/g, '');
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Operator money corrections (decision 2026-07-29 — the workbook itself is
// the operator's file and is NEVER edited by us; corrections apply in-memory
// BEFORE the satang-exact guard).
// ---------------------------------------------------------------------------

export interface MoneyTriple {
  readonly amountThb: number;
  readonly vatThb: number;
  readonly totalThb: number;
}

export interface OperatorMoneyCorrection {
  /** The EXACT triple the sheet carries at that row — the correction only
   *  applies when it matches satang-for-satang (re-sort/typo guard). */
  readonly sheet: MoneyTriple;
  /** The operator-decided triple the system document must carry. */
  readonly corrected: MoneyTriple;
}

/**
 * Keyed by 1-based Excel rowIndex.
 *
 * Row 172 (MB2026-086, paid) — operator decision 2026-07-29: the sheet triple
 * 25,233.65 / 1,766.35 / 27,000.00 was back-computed from a round 27,000.00
 * incl-VAT total, which is UNREACHABLE under total-level 7% half-away-from-
 * zero rounding (amount 25,233.64 → total 26,999.99; amount 25,233.65 →
 * total 27,000.01 — no 2-dp amount lands on 27,000.00 exactly). The system
 * document carries 25,233.64 / 1,766.35 / 26,999.99 — one satang UNDER the
 * cash received, because a receipt must never exceed cash. Logged in
 * docs/import/ROUND3_PLAN.md § Operator data corrections.
 */
export const OPERATOR_MONEY_CORRECTIONS: ReadonlyMap<number, OperatorMoneyCorrection> =
  new Map([
    [
      172,
      {
        sheet: { amountThb: 25_233.65, vatThb: 1_766.35, totalThb: 27_000.0 },
        corrected: { amountThb: 25_233.64, vatThb: 1_766.35, totalThb: 26_999.99 },
      },
    ],
  ]);

/** Satang-exact triple equality (float-literal-safe). */
function tripleEquals(a: MoneyTriple, b: MoneyTriple): boolean {
  return (
    thbToSatang(a.amountThb) === thbToSatang(b.amountThb) &&
    thbToSatang(a.vatThb) === thbToSatang(b.vatThb) &&
    thbToSatang(a.totalThb) === thbToSatang(b.totalThb)
  );
}

interface SheetRow {
  /** 1-based Excel row number (header is row 1). */
  readonly rowIndex: number;
  readonly cells: readonly unknown[];
}

function at(row: SheetRow, i: number): string {
  return cellToString(row.cells[i]);
}

const INVOICE_STATUS_MAP: Readonly<Record<string, Round3InvoiceStatus>> = {
  paid: 'paid',
  unpaid: 'issued',
  cancelled: 'void',
};

/**
 * Read + transform the 'Finalized Member' sheet. Throws on header drift;
 * collects per-row problems into `errors` / `warnings` (rowIndex + code only)
 * so the CLI can render a complete PII-free dry-run report and refuse --commit.
 *
 * `corrections` defaults to the operator-decided OPERATOR_MONEY_CORRECTIONS
 * (parameter exists as a unit-test seam only — production callers pass one arg).
 */
export function readFinalizedMemberWorkbook(
  file: string,
  corrections: ReadonlyMap<number, OperatorMoneyCorrection> = OPERATOR_MONEY_CORRECTIONS,
): FinalizedMemberWorkbook {
  const wb = XLSX.readFile(file, { cellDates: true });
  const ws = wb.Sheets[FINALIZED_SHEET_NAME];
  if (!ws) {
    throw new Error(
      `sheet "${FINALIZED_SHEET_NAME}" not found in ${file}. Available: ${wb.SheetNames.join(', ')}`,
    );
  }
  // blankrows: true keeps empty slots so rowIndex always points at the TRUE
  // spreadsheet row (same rationale as import-members readWorkbook).
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: true,
    defval: '',
  });
  const headers = (aoa[0] ?? []).map((h) => String(h ?? ''));

  // --- 1. Fixed-index header assertion (drift → refuse loudly) ---
  EXPECTED_HEADERS.forEach((expected, i) => {
    const actual = normHeader(headers[i] ?? '');
    if (actual !== expected) {
      throw new Error(
        `[finalized-sheet] header drift at column ${i}: expected "${expected}" but ` +
          `found "${actual}" — the fixed-index column map (ROUND3_PLAN.md § Column map) ` +
          `no longer matches the sheet. Refusing to import; re-verify EVERY index.`,
      );
    }
  });

  const warnings: Round3Issue[] = [];
  const errors: Round3Issue[] = [];
  const warn = (rowIndex: number, field: string, code: string): void => {
    warnings.push({ rowIndex, field, code });
  };
  const err = (rowIndex: number, field: string, code: string): void => {
    errors.push({ rowIndex, field, code });
  };

  // --- 2. Group by company (trim+UPPERCASE), one winner per series ---
  const bySeries = new Map<string, Map<Round3Series, SheetRow>>();
  aoa.slice(1).forEach((cells, i) => {
    const rowIndex = i + 2; // header is Excel row 1
    if (cells.every((c) => cellToString(c).length === 0)) return; // blank separator
    const row: SheetRow = { rowIndex, cells };

    const invNo = at(row, 0).trim();
    const seriesMatch = INV_SERIES_RE.exec(invNo);
    const seriesYear = seriesMatch?.[1];
    if (seriesYear !== '2025' && seriesYear !== '2026') {
      err(rowIndex, 'invNo', 'inv_series_unsupported');
      return;
    }
    const series: Round3Series = seriesYear;

    const companyKey = at(row, 10).trim().toUpperCase();
    if (companyKey.length === 0) {
      err(rowIndex, 'officialName', 'required');
      return;
    }

    const seriesMap = bySeries.get(companyKey) ?? new Map<Round3Series, SheetRow>();
    const prev = seriesMap.get(series);
    if (prev === undefined) {
      seriesMap.set(series, row);
    } else {
      // Same-series duplicate (ROUND3_PLAN rule): keep the LATER Inv Date; on
      // a same-date tie prefer the 'paid' row. Local-ISO strings compare correctly.
      const prevDate = at(prev, 1);
      const curDate = at(row, 1);
      const keepNew =
        curDate > prevDate ||
        (curDate === prevDate && at(row, 7).trim().toLowerCase() === 'paid');
      const dropped = keepNew ? prev : row;
      warn(dropped.rowIndex, 'invNo', 'duplicate_series_row_dropped');
      if (keepNew) seriesMap.set(series, row);
    }
    bySeries.set(companyKey, seriesMap);
  });

  // --- 3. Assign mockup emails in deterministic sorted-company order ---
  const sortedKeys = [...bySeries.keys()].sort();
  const emailByCompany = new Map<string, string>();
  const takenSlugs = new Set<string>();
  for (const key of sortedKeys) {
    const base = slugifyCompany(key);
    let slug = base;
    for (let n = 2; takenSlugs.has(slug); n += 1) slug = `${base}-${n}`;
    takenSlugs.add(slug);
    emailByCompany.set(key, `${slug}@${MOCKUP_EMAIL_DOMAIN}`);
  }

  // --- 4. Build member rows + invoice docs ---
  const memberRows: RawRow[] = [];
  const invoices: Round3InvoiceDoc[] = [];
  const planYearByCompanyKey = new Map<string, number>();
  const countryDefaults: CountryDefault[] = [];
  /** Correction rowIndexes buildDoc actually encountered (match OR mismatch). */
  const correctionRowsSeen = new Set<number>();

  const buildDoc = (
    row: SheetRow,
    series: Round3Series,
    companyKey: string,
    contactEmail: string,
  ): Round3InvoiceDoc | null => {
    const statusRaw = at(row, 7).trim().toLowerCase();
    const targetStatus = INVOICE_STATUS_MAP[statusRaw];
    if (targetStatus === undefined) {
      err(row.rowIndex, 'status', 'invoice_status_unknown');
      return null;
    }

    const issueDate = at(row, 1);
    if (!ISO_DATE_RE.test(issueDate)) {
      err(row.rowIndex, 'invDate', 'issue_date_invalid');
      return null;
    }
    const dueDateExcel = at(row, 6);
    const payRaw = at(row, 9);
    const paymentDate = ISO_DATE_RE.test(payRaw) ? payRaw : null;
    if (targetStatus === 'paid' && paymentDate === null) {
      err(row.rowIndex, 'paymentDate', 'paid_missing_payment_date');
    }

    const rcRaw = at(row, 8).trim();
    const origReceiptNo = rcRaw === '' || rcRaw === '0' || rcRaw === '0.0' ? null : rcRaw;
    if (targetStatus === 'paid' && origReceiptNo === null) {
      warn(row.rowIndex, 'refReceiptNo', 'paid_missing_receipt_no');
    }

    const amountThb = parseMoney(at(row, 3));
    const vatThb = parseMoney(at(row, 4));
    const totalThb = parseMoney(at(row, 5));
    if (amountThb === null || vatThb === null || totalThb === null) {
      err(row.rowIndex, 'amount', 'money_not_numeric');
      return null;
    }

    // Operator money correction (decision 2026-07-29) — applied BEFORE the
    // satang-exact guard, only when the sheet triple matches the recorded
    // original EXACTLY (re-sort guard); every application is a WARNING so it
    // shows in every report. A mismatch is a structural ERROR: the row no
    // longer carries the triple the operator decided about.
    let money: MoneyTriple = { amountThb, vatThb, totalThb };
    const correction = corrections.get(row.rowIndex);
    if (correction !== undefined) {
      correctionRowsSeen.add(row.rowIndex);
      if (tripleEquals(money, correction.sheet)) {
        money = correction.corrected;
        warn(row.rowIndex, 'amount', 'operator_money_correction');
      } else {
        err(row.rowIndex, 'amount', 'operator_money_correction_mismatch');
      }
    }

    // Money invariants — SATANG-EXACT (review finding R3-2; formerly ±0.02/±0.5
    // tolerances). A passing row mints byte-identical vat/total through
    // issueInvoice; any violation is an ERROR that blocks --commit.
    for (const code of sheetMoneyErrors(money)) {
      err(row.rowIndex, code === 'money_vat_not_7pct' ? 'vat' : 'total', code);
    }

    return {
      companyKey,
      contactEmail,
      series,
      origBillNo: at(row, 0).trim(),
      origReceiptNo,
      issueDate,
      dueDateExcel,
      paymentDate,
      amountThb: money.amountThb,
      vatThb: money.vatThb,
      totalThb: money.totalThb,
      targetStatus,
      planTier: fixupPlanLabel(at(row, 21)),
      planYear: Number(issueDate.slice(0, 4)),
      rowIndex: row.rowIndex,
    };
  };

  for (const companyKey of sortedKeys) {
    const seriesMap = bySeries.get(companyKey)!;
    const latest = seriesMap.get('2026') ?? seriesMap.get('2025')!;
    const contactEmail = emailByCompany.get(companyKey)!;
    const companyName = at(latest, 10).trim();

    // Tax id cell (zero-marker blanked) — used for the member row AND the
    // wrong-THAILAND correction rule below.
    const taxIdCell = blankZeroTaxId(at(latest, 13));

    // Country — explicit value or the plan's default rules (recorded, no names).
    const countryRaw = at(latest, 15).trim();
    let country = countryRaw;
    if (BLANK_COUNTRY_ALIASES.has(countryRaw.toLowerCase())) {
      const d = defaultCountryFor(companyName);
      country = d.country;
      countryDefaults.push({ rowIndex: latest.rowIndex, rule: d.rule });
    } else if (isSwedishAbName(companyName) && isPresentNonThaiShapedTaxId(taxIdCell)) {
      // Operator decision 2026-07-29 — generic correction (never name-keyed):
      // an AB-named company whose EXPLICIT country cell resolves to TH but whose
      // tax id is present and NOT Thai-TIN-shaped (digits ≠ 12/13) carries a
      // wrong country cell → treat as SWEDEN; the tax id then flows through the
      // foreign-tax-id path (validate.ts allows 1–50 chars for non-TH). Rows
      // with a blank/zero tax id are NOT touched (an AB-named company can
      // legitimately be TH-registered with no TIN recorded), and rows whose
      // country was empty are handled by the default rules above.
      const resolved = countryNameToCode(countryRaw);
      if (resolved.ok && resolved.value === 'TH') {
        country = 'SWEDEN';
        countryDefaults.push({
          rowIndex: latest.rowIndex,
          rule: 'swedish_ab_thai_country_corrected',
        });
      }
    }

    // Contact — sheet names, else the company name itself (≤100 — the contacts
    // first_name DB CHECK caps at 100; commit writes '-' for the empty surname).
    let contactFirstName = at(latest, 31).trim();
    let contactLastName = at(latest, 32).trim();
    if (contactFirstName.length === 0 && contactLastName.length === 0) {
      contactFirstName = companyName.slice(0, 100);
      contactLastName = '';
    }

    const registrationDate = at(latest, 1); // anchor = Inv Date (decision #5)
    if (ISO_DATE_RE.test(registrationDate)) {
      planYearByCompanyKey.set(
        normCompanyKeyForValidate(companyName),
        Number(registrationDate.slice(0, 4)),
      );
    }
    // else: validateRows errors date.invalid on this row — no planYear entry needed.

    memberRows.push({
      rowIndex: latest.rowIndex,
      companyName,
      legalEntityType: at(latest, 14),
      country,
      taxId: taxIdCell,
      tier: fixupPlanLabel(at(latest, 21)),
      turnover: blankNA(at(latest, 18)),
      registeredCapital: blankNA(at(latest, 19)),
      website: blankNA(at(latest, 16)),
      foundedYear: blankNA(at(latest, 17)),
      description: blankNA(at(latest, 20)),
      registrationDate,
      memberLocale: '',
      status: at(latest, 11),
      city: blankNA(at(latest, 28)),
      province: blankNA(at(latest, 27)),
      postalCode: blankNA(at(latest, 26)),
      addressLine1: blankNA(at(latest, 29)),
      addressLine2: blankNA(at(latest, 30)),
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: '',
      contactRole: '',
      contactLanguage: '',
      isPrimary: 'yes',
    });

    // Invoice selection (operator decision #3): every 2026 row; the 2025 row
    // only when the company has NO 2026 row AND is Active (rolling member still
    // covered by its 2025 payment). Inactive 2025-only = directory record only.
    const memberActive = at(latest, 11).trim().toLowerCase() === 'active';
    const row2026 = seriesMap.get('2026');
    const row2025 = seriesMap.get('2025');
    const selected: ReadonlyArray<readonly [SheetRow, Round3Series]> = row2026
      ? [[row2026, '2026']]
      : memberActive && row2025
        ? [[row2025, '2025']]
        : [];
    for (const [row, series] of selected) {
      const doc = buildDoc(row, series, companyKey, contactEmail);
      if (doc) invoices.push(doc);
    }
  }

  // Every listed correction MUST have met its row among the SELECTED invoice
  // docs — a leftover key means the workbook was re-sorted / re-filtered and
  // the correction would land on the wrong document. Loud structural ERROR
  // (blocks --commit in both CLIs).
  for (const rowIndex of corrections.keys()) {
    if (!correctionRowsSeen.has(rowIndex)) {
      err(rowIndex, 'amount', 'operator_money_correction_row_not_found');
    }
  }

  return { memberRows, invoices, planYearByCompanyKey, countryDefaults, warnings, errors };
}
