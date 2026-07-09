/**
 * Pure parsing + planning core for `scripts/backfill-cycle-anchors.ts`
 * (renewal-rolling-anchor feature, plan Task 12 — item R4).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * TSCC's pre-system membership records key on COMPANY NAME, not member number
 * (`docs/Membership Database_Since 2025.xlsx` — PII, git-ignored, never
 * committed). Migration 0238 (Task 1) added `renewal_cycles.anchored_at` /
 * `.anchor_invoice_id` so a cycle created at member-registration time (a
 * provisional anchor) can later be re-anchored to the member's REAL first
 * payment date. For members onboarded BEFORE this feature shipped, that
 * re-anchor never happened automatically (there was no live F4 payment event
 * to trigger it) — this script performs that re-anchor retroactively from an
 * operator-supplied CSV of historical payment dates.
 *
 * This module holds ONLY pure, side-effect-free logic (CSV parsing, name
 * normalisation, period derivation, plan building) so it is fully unit
 * testable without a database. The thin CLI wrapper
 * (`scripts/backfill-cycle-anchors.ts`) owns all I/O: reading the CSV file,
 * querying `members` + `renewal_cycles` inside `runInTenant`, and — only when
 * `--confirm-prod` is passed — calling `reanchorPeriodInTx` per planned action.
 *
 * ── CSV format ────────────────────────────────────────────────────────────────
 *   company_name,payment_date,period_from,period_to
 *
 * `period_from` / `period_to` are OPTIONAL columns (may be absent from the
 * header entirely, or present but blank on a given row). When both are
 * present on a row they WIN outright — this covers the ~6 legacy "full year"
 * members who must keep their fixed calendar-year window (e.g.
 * 2026-01-01 → 2026-12-31) rather than a payment-derived rolling window.
 * Otherwise the period is DERIVED: first day of the payment month → + 12
 * months (spec 2026-07-08 rev 3 — TSCC's 19 recorded period pairs all run
 * 1st-of-month → end-of-month).
 *
 * ── Row resolution pipeline (see `buildBackfillPlan`) ────────────────────────
 *   1. Future-dated `payment_date` (> today) is dropped FIRST, per row —
 *      before de-duplication. The workbook contains exactly this anomaly (one
 *      future-dated row that is ALSO a duplicate of a legitimate earlier row
 *      for the same company): if de-dup ran first and naïvely kept
 *      MAX(payment_date), the bogus future-dated row would win and the whole
 *      company would be wrongly skipped. Filtering future-dated rows out
 *      first lets the real, earlier payment survive de-dup.
 *   2. Remaining rows are grouped by normalised company name; a group with
 *      more than one row keeps the row with the latest `payment_date`
 *      (ties broken by first-in-file), the rest become
 *      `duplicate_superseded` skips.
 *   3. The surviving candidate per group is matched against the tenant's
 *      `members.company_name` (via a caller-supplied lookup index — see
 *      below), then against that member's open renewal cycle, then checked
 *      against the `anchored_at IS NULL` guard `reanchorPeriodInTx` itself
 *      enforces (reported here too so a dry-run explains a would-be no-op
 *      before the operator wastes a write attempt).
 */
import { addMonthsUtc } from '@/lib/dates';
import { bangkokLocalDate, isValidCalendarDate } from '@/lib/fiscal-year';
import { normaliseCompanyName as normaliseCompanyNameF6 } from '@/modules/events';

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

const REQUIRED_HEADERS = ['company_name', 'payment_date'] as const;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BackfillCsvHeaderError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `backfill-cycle-anchors: CSV header missing required column(s): ${missing.join(', ')}. ` +
        `Expected at least "company_name,payment_date" (optional: "period_from,period_to").`,
    );
    this.name = 'BackfillCsvHeaderError';
  }
}

export interface BackfillCsvRow {
  /** 1-based line number within the CSV file (header is line 1) — used for operator-facing error/report lines, never PII on its own. */
  readonly lineNumber: number;
  readonly companyNameRaw: string;
  readonly normalizedName: string;
  /**
   * FIX-5 (PR #173 review, 2026-07-09) — F6's `normaliseCompanyName`
   * (corporate-suffix-stripping) applied to `companyNameRaw`. Tried as a
   * FALLBACK match key (see `buildBackfillPlan`) when the primary
   * `normalizedName` (punctuation-only stripping, no suffix removal) finds
   * no member — closes the gap where the CSV name carries a suffix
   * ("Acme Co., Ltd.") but the member's stored `company_name` is bare
   * ("Acme").
   */
  readonly alternateNormalizedName: string;
  /** 'YYYY-MM-DD', already format-validated. */
  readonly paymentDate: string;
  /** 'YYYY-MM-DD' or null — present only when BOTH period_from and period_to are non-blank on this row. */
  readonly periodFromRaw: string | null;
  readonly periodToRaw: string | null;
}

export type CsvRowIssueReason =
  | 'missing_company_name'
  | 'invalid_payment_date'
  | 'incomplete_period_override'
  | 'invalid_period_date'
  /**
   * FIX-5 (PR #173 review, 2026-07-09) — the SHAPE regex (`\d{4}-\d{2}-\d{2}`)
   * accepts calendar-impossible dates like `2026-02-30`. Reported as a
   * distinct structural issue (never silently coerced/rolled-over by a
   * downstream `Date` parse) for `payment_date`, `period_from`, and
   * `period_to` alike.
   */
  | 'invalid_calendar_date'
  | 'period_order_invalid';

export interface CsvRowIssue {
  readonly lineNumber: number;
  readonly reason: CsvRowIssueReason;
}

export interface CsvParseResult {
  readonly header: readonly string[];
  readonly rows: readonly BackfillCsvRow[];
  /** Rows that failed structural validation — excluded from `rows`, reported separately. */
  readonly issues: readonly CsvRowIssue[];
}

/**
 * Normalise a company name for matching: lowercase, strip punctuation
 * (anything that isn't a Unicode letter or number), collapse whitespace.
 * Unicode-aware (`\p{L}`/`\p{N}` with the `u` flag) so non-Latin company
 * names normalise correctly too, not just ASCII ones.
 */
export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Minimal RFC4180-style line splitter: supports double-quoted fields
 * (commas/embedded quotes inside quotes via `""` escaping). Sufficient for an
 * operator-authored backfill CSV; not a general-purpose CSV parser.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Parse the backfill CSV. Throws `BackfillCsvHeaderError` when a required
 * header column is missing (a structural failure, not a per-row issue).
 * Blank lines are skipped. Per-row structural problems are collected into
 * `issues` and excluded from `rows` — the caller decides whether to abort or
 * proceed with the valid subset (this script proceeds and reports both).
 */
export function parseBackfillCsv(text: string): CsvParseResult {
  const lines = text.split(/\r\n|\r|\n/);

  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') {
      headerLineIdx = i;
      break;
    }
  }
  if (headerLineIdx === -1) {
    throw new BackfillCsvHeaderError(REQUIRED_HEADERS as unknown as string[]);
  }

  const headerCells = splitCsvLine(lines[headerLineIdx]!).map((h) => h.trim().toLowerCase());
  const colIndex = new Map<string, number>();
  headerCells.forEach((h, idx) => {
    if (!colIndex.has(h)) colIndex.set(h, idx);
  });

  const missing = REQUIRED_HEADERS.filter((h) => !colIndex.has(h));
  if (missing.length > 0) {
    throw new BackfillCsvHeaderError(missing);
  }

  const rows: BackfillCsvRow[] = [];
  const issues: CsvRowIssue[] = [];

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const lineNumber = i + 1;
    const cells = splitCsvLine(raw);

    const get = (col: string): string | null => {
      const idx = colIndex.get(col);
      if (idx === undefined) return null;
      const v = cells[idx];
      return v === undefined ? null : v.trim();
    };

    const companyNameRaw = get('company_name') ?? '';
    if (companyNameRaw === '') {
      issues.push({ lineNumber, reason: 'missing_company_name' });
      continue;
    }

    const paymentDate = get('payment_date') ?? '';
    if (!DATE_ONLY_RE.test(paymentDate)) {
      issues.push({ lineNumber, reason: 'invalid_payment_date' });
      continue;
    }
    if (!isValidCalendarDate(paymentDate)) {
      issues.push({ lineNumber, reason: 'invalid_calendar_date' });
      continue;
    }

    const periodFromCell = get('period_from');
    const periodToCell = get('period_to');
    const fromPresent = periodFromCell !== null && periodFromCell !== '';
    const toPresent = periodToCell !== null && periodToCell !== '';

    if (fromPresent !== toPresent) {
      issues.push({ lineNumber, reason: 'incomplete_period_override' });
      continue;
    }

    let periodFromRaw: string | null = null;
    let periodToRaw: string | null = null;
    if (fromPresent && toPresent) {
      if (!DATE_ONLY_RE.test(periodFromCell!) || !DATE_ONLY_RE.test(periodToCell!)) {
        issues.push({ lineNumber, reason: 'invalid_period_date' });
        continue;
      }
      if (!isValidCalendarDate(periodFromCell!) || !isValidCalendarDate(periodToCell!)) {
        issues.push({ lineNumber, reason: 'invalid_calendar_date' });
        continue;
      }
      if (periodToCell! <= periodFromCell!) {
        issues.push({ lineNumber, reason: 'period_order_invalid' });
        continue;
      }
      periodFromRaw = periodFromCell;
      periodToRaw = periodToCell;
    }

    rows.push({
      lineNumber,
      companyNameRaw,
      normalizedName: normalizeCompanyName(companyNameRaw),
      alternateNormalizedName: normaliseCompanyNameF6(companyNameRaw),
      paymentDate,
      periodFromRaw,
      periodToRaw,
    });
  }

  return { header: headerCells, rows, issues };
}

// ---------------------------------------------------------------------------
// Period derivation
// ---------------------------------------------------------------------------

function toMidnightIso(dateOnly: string): string {
  return `${dateOnly}T00:00:00.000Z`;
}

/** First day of `dateOnly`'s month, midnight UTC — mirrors `paymentAnchorMonthStartUtc` (Task 5) for the live payment-hook flow. */
function monthStartUtc(dateOnly: string): string {
  return `${dateOnly.slice(0, 7)}-01T00:00:00.000Z`;
}

export type PeriodSource = 'explicit_override' | 'derived_month_start_plus_12';

export interface DerivedPeriod {
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly source: PeriodSource;
}

/**
 * Explicit `period_from`/`period_to` columns WIN when present (legacy
 * full-year members). Otherwise: first day of the payment month, + 12
 * months flat (NOT the cycle's `frozenPlanTermMonths` — spec rev 3 fixes the
 * backfill window at 12 months regardless, matching TSCC's own records).
 */
export function derivePeriod(
  row: Pick<BackfillCsvRow, 'paymentDate' | 'periodFromRaw' | 'periodToRaw'>,
): DerivedPeriod {
  if (row.periodFromRaw !== null && row.periodToRaw !== null) {
    return {
      periodFrom: toMidnightIso(row.periodFromRaw),
      periodTo: toMidnightIso(row.periodToRaw),
      source: 'explicit_override',
    };
  }
  const monthStart = monthStartUtc(row.paymentDate);
  return {
    periodFrom: monthStart,
    periodTo: addMonthsUtc(monthStart, 12),
    source: 'derived_month_start_plus_12',
  };
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

export interface MemberLookupEntry {
  readonly memberId: string;
  /** Original-casing company name, for report display only. */
  readonly companyName: string;
}

export type OpenCycleStatus = 'upcoming' | 'reminded' | 'awaiting_payment';

export interface OpenCycleInfo {
  readonly cycleId: string;
  readonly status: OpenCycleStatus;
  /** Non-null means `reanchorPeriodInTx`'s own guard would reject this cycle — reported as `already_anchored` here too. */
  readonly anchoredAt: string | null;
}

export type PlannedSkipReason =
  | 'future_dated_payment'
  | 'duplicate_superseded'
  | 'unmatched_name'
  | 'ambiguous_name_collision'
  | 'no_open_cycle'
  | 'already_anchored';

export interface ReanchorAction {
  readonly kind: 'reanchor';
  readonly row: BackfillCsvRow;
  readonly memberId: string;
  readonly companyName: string;
  readonly cycleId: string;
  readonly newPeriodFrom: string;
  readonly newPeriodTo: string;
  readonly periodSource: PeriodSource;
}

export interface SkipAction {
  readonly kind: 'skip';
  readonly row: BackfillCsvRow;
  readonly reason: PlannedSkipReason;
  readonly memberId?: string;
}

export type PlannedAction = ReanchorAction | SkipAction;

export interface BackfillPlan {
  readonly actions: readonly PlannedAction[];
}

export interface BuildBackfillPlanInput {
  readonly rows: readonly BackfillCsvRow[];
  /** Keyed by `normalizeCompanyName(members.company_name)`. `'ambiguous'` marks a normalisation collision between ≥2 distinct members — the caller building this index must never silently pick one. */
  readonly memberIndex: ReadonlyMap<string, MemberLookupEntry | 'ambiguous'>;
  /**
   * FIX-5 (PR #173 review, 2026-07-09) — SECOND member index, keyed by F6's
   * `normaliseCompanyName(members.company_name)` (corporate-suffix
   * stripping). Consulted ONLY as a fallback when `memberIndex` finds no
   * match for a row's primary `normalizedName` — see `buildBackfillPlan`.
   * Same `'ambiguous'` collision-detection contract as `memberIndex`: if
   * two distinct members collapse to the same F6-normalised key, the
   * caller building this index must mark it `'ambiguous'`, never guess.
   * Optional — omitting it simply disables the fallback (existing
   * single-key behaviour).
   */
  readonly alternateMemberIndex?: ReadonlyMap<string, MemberLookupEntry | 'ambiguous'>;
  /** Keyed by `memberId`. Absence means "no open cycle for this member". */
  readonly openCycleIndex: ReadonlyMap<string, OpenCycleInfo>;
  /** Injected clock — "today" for the future-dated-payment guard. */
  readonly now: Date;
}

/**
 * Build the full backfill plan (matched reanchors + every skip, with
 * reasons) WITHOUT touching the database. See the module docstring for the
 * resolution pipeline (future-date filter → de-dup → match → cycle lookup →
 * anchored guard → period derivation). Deterministic: `actions` is sorted by
 * the CSV's original `lineNumber` so the report reads in file order
 * regardless of internal grouping.
 */
export function buildBackfillPlan(input: BuildBackfillPlanInput): BackfillPlan {
  const { rows, memberIndex, alternateMemberIndex, openCycleIndex, now } = input;
  // FIX-5 (PR #173 review, 2026-07-09) — the future-dated-payment guard must
  // compare against TSCC's own wall-clock "today" (Asia/Bangkok, UTC+7), not
  // `now`'s raw UTC calendar date. Between 17:00 and 23:59 UTC, the Bangkok
  // calendar date is already the NEXT day — a UTC-sliced "today" would
  // wrongly flag a payment dated "today (Bangkok)" as future-dated during
  // that 7-hour band every single run.
  const today = bangkokLocalDate(now.toISOString());
  const actions: PlannedAction[] = [];

  // Step 1 — drop future-dated payments FIRST (before de-dup): a bogus
  // future-dated row must never win a MAX(payment_date) tie-break against a
  // legitimate earlier duplicate for the same company.
  const validRows: BackfillCsvRow[] = [];
  for (const row of rows) {
    if (row.paymentDate > today) {
      actions.push({ kind: 'skip', row, reason: 'future_dated_payment' });
    } else {
      validRows.push(row);
    }
  }

  // Step 2 — group by normalised name; keep MAX(payment_date) per group.
  const groups = new Map<string, BackfillCsvRow[]>();
  for (const row of validRows) {
    const existing = groups.get(row.normalizedName);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.normalizedName, [row]);
    }
  }

  for (const groupRows of groups.values()) {
    let keep = groupRows[0]!;
    for (const candidate of groupRows.slice(1)) {
      if (candidate.paymentDate > keep.paymentDate) keep = candidate;
    }
    for (const row of groupRows) {
      if (row !== keep) {
        actions.push({ kind: 'skip', row, reason: 'duplicate_superseded' });
      }
    }

    // Step 3 — resolve the surviving candidate. Primary key first; FIX-5
    // (PR #173 review, 2026-07-09) falls back to the F6 suffix-stripping
    // key ONLY when the primary key finds nothing — e.g. a suffixed CSV
    // name ("Acme Co., Ltd.") against a bare stored `company_name`
    // ("Acme"). A primary `'ambiguous'` result is reported immediately,
    // never overridden by the fallback.
    let matched = memberIndex.get(keep.normalizedName);
    if (matched === undefined && alternateMemberIndex) {
      matched = alternateMemberIndex.get(keep.alternateNormalizedName);
    }
    if (matched === undefined) {
      actions.push({ kind: 'skip', row: keep, reason: 'unmatched_name' });
      continue;
    }
    if (matched === 'ambiguous') {
      actions.push({ kind: 'skip', row: keep, reason: 'ambiguous_name_collision' });
      continue;
    }

    const cycle = openCycleIndex.get(matched.memberId);
    if (!cycle) {
      actions.push({
        kind: 'skip',
        row: keep,
        reason: 'no_open_cycle',
        memberId: matched.memberId,
      });
      continue;
    }
    if (cycle.anchoredAt !== null) {
      actions.push({
        kind: 'skip',
        row: keep,
        reason: 'already_anchored',
        memberId: matched.memberId,
      });
      continue;
    }

    const period = derivePeriod(keep);
    actions.push({
      kind: 'reanchor',
      row: keep,
      memberId: matched.memberId,
      companyName: matched.companyName,
      cycleId: cycle.cycleId,
      newPeriodFrom: period.periodFrom,
      newPeriodTo: period.periodTo,
      periodSource: period.source,
    });
  }

  return {
    actions: actions.slice().sort((a, b) => a.row.lineNumber - b.row.lineNumber),
  };
}
