/**
 * Round-3 invoice+receipt importer — CORE (docs/import/ROUND3_PLAN.md
 * § Invoice import, operator-approved 2026-07-29). Driven by the CLI
 * (`scripts/import-round3-invoices.ts`) and by the live-Neon integration test
 * (`tests/integration/scripts/import-round3-invoices.test.ts`).
 *
 * ── What it does (THREE PHASES so both tax-number streams stay date-ordered —
 *    review finding R3-4) ─────────────────────────────────────────────────────
 *   0. PRE-FLIGHT (commit mode only, R3-3): plan EVERY doc first (member
 *      resolution, plan-tier resolution, date guard, resume decision). If ANY
 *      doc has a plan-stage error the run REFUSES to execute — zero writes —
 *      because executing around holes would mint SC/RC numbers whose gaps get
 *      filled out-of-chronology on the fix-up re-run. The refused run returns
 *      the full dry-run-style plan (`commitRefused: true`).
 *   A. ISSUE phase — every doc in ascending Inv Date (rowIndex tiebreak):
 *      1. resolve the member via the Part-1 mockup contact email
 *         (tenant-scoped, lower(email), removed_at IS NULL);
 *      2. `createInvoiceDraft` with `renewalSignal{unitPriceSatang}`
 *         (VAT-exclusive frozen price — suppresses the registration-fee
 *         auto-line + pro-rating) and the TRUE half-open coverage window
 *         `[issueDate, issueDate+12mo)` (both the printed §86/4
 *         `membershipCoverage` and the mig-0281 `coverageWindow`
 *         EXCLUDE-guard axis);
 *      3. `issueInvoice` with a PER-DOC injected ClockPort at
 *         `issueDate`T05:00Z (midday Bangkok — same Bangkok calendar day +
 *         correct bill fiscal year) → mints `bill_document_number_raw`
 *         SC-{FY}-{NNNNNN} + renders the PDF. SC numbers therefore run in
 *         ISSUE-date order within each FY.
 *   B. PAYMENT phase — every PAID doc in ascending PAYMENT date (rowIndex
 *      tiebreak): `recordPayment` (bank_transfer, sheet payment date,
 *      triggeredBy 'admin_offline_mark') → mints RC-{FY(paymentDate)}-{NNNNNN}
 *      + receipt PDF (forced SYNCHRONOUS via `asyncReceiptPdf:false`). RC
 *      numbers therefore run in PAYMENT-date order within each FY — the
 *      tax-register ordering an auditor checks (the old single-pass execution
 *      minted RC in issue-date order, which can disagree). The doc's renewal
 *      cycle (ACTIVE members only) rides this phase: `createCycleInTx`
 *      ('upcoming') + `reanchorPeriodInTx` stamp (`anchored_at`=payment date,
 *      `anchor_invoice_id`=the invoice — NEVER `linked_invoice_id`, schema
 *      comment 0238).
 *   C. VOID + ISSUED-CYCLE phase — ascending Inv Date: void docs →
 *      `voidInvoice` (issue-then-void; bill-stream gaps are legal); issued
 *      docs of ACTIVE members → `createCycleInTx` ('awaiting_payment') +
 *      `linkInvoice` so a later record-payment auto-completes the cycle.
 *
 * ── Flag pinning (deterministic regardless of env) ───────────────────────────
 *   `taxAtPayment: 'on'` + `asyncReceiptPdf: false` are pinned as DEPS-SPREAD
 *   OVERRIDES on the factory outputs (the same seam
 *   tests/integration/invoicing/bill-to-receipt.integration.test.ts uses).
 *   `src/lib/env.ts` caches at first import, so an env-var mutation after any
 *   env-touching import is a no-op — the deps override is the operative
 *   mechanism; the CLI additionally pins the env vars BEFORE its first import
 *   as defence-in-depth.
 *
 * ── Idempotency / resume (re-run MUST be safe + convergent) ──────────────────
 *   - member missing → per-doc error (doc skipped, run continues);
 *   - member already holds a NON-DRAFT membership invoice:
 *       · status == target        → skip 'already_imported' + ENSURE the cycle
 *                                   (createCycleInTx no-ops via
 *                                   findActiveForMemberInTx when it exists);
 *       · 'issued' vs target paid → RESUME: record the payment + cycle;
 *       · 'issued' vs target void → RESUME: void it;
 *       · anything else           → per-doc error 'existing_invoice_status_mismatch';
 *   - member holds ONLY draft membership invoice(s) (a previous run crashed
 *     between draft and issue) → the stale draft(s) are DELETED via
 *     `deleteInvoiceDraft` and the doc imports fresh (chosen strategy: delete,
 *     not reuse — a reused draft would need field-by-field re-verification).
 *
 * ── Failure semantics ────────────────────────────────────────────────────────
 *   Plan-stage errors REFUSE the whole commit before any write (phase 0 above).
 *   Once execution starts, each doc is its own use-case tx sequence within each
 *   phase; an EXECUTION error is recorded, the doc skips its remaining phases,
 *   and the run CONTINUES for the other docs (the CLI exits 1 when any error
 *   occurred). The use-cases are individually transactional, so a doc can never
 *   be half-written; a doc that issued but failed later resumes on re-run
 *   (already-issued docs skip phase A; already-paid docs skip phase B; etc.).
 *
 * ── PII ──────────────────────────────────────────────────────────────────────
 *   The report document carries rowIndex + document numbers + member numbers +
 *   dates + machine codes ONLY (spec § 7 — TSCC doc numbers and member numbers
 *   are not personal data; company names/emails NEVER enter it — a unit test
 *   asserts this). Console output follows the same rule except caught error
 *   MESSAGES, which are operator-terminal-only.
 *
 * ── Module-load discipline ───────────────────────────────────────────────────
 *   Top-level imports are env-free (unit tests import the pure helpers without
 *   DATABASE_URL). Everything that transitively reaches `src/lib/env.ts` (db,
 *   schemas, use-cases, deps factories, the renewals barrel) is loaded LAZILY
 *   inside `loadDbModules()` with the Part-1 `server-only` remediation hint
 *   (tsx runs need TSX_TSCONFIG_PATH=tsconfig.scripts.json).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { addMonthsUtc, bangkokDateOnly } from '@/lib/dates';
import type { TenantContext } from '@/modules/tenants';
import type { BlobStoragePort } from '@/modules/invoicing/application/ports/blob-storage-port';
import type { Round3InvoiceDoc, Round3InvoiceStatus } from './finalized-sheet';
import { thbToSatang } from './money';

// Satang conversion lives in ./money since the exact-guard review fix (R3-2);
// re-exported so existing consumers (unit tests) keep their import path.
export { thbToSatang, vat7Satang } from './money';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — tests/unit/scripts/import-round3-invoices.test.ts)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → midnight UTC ISO instant (coverage-window bound). */
export function midnightUtcIso(dateOnly: string): string {
  return `${dateOnly}T00:00:00.000Z`;
}

/**
 * Per-doc injected ClockPort instant: 05:00Z = midday Bangkok (UTC+7) — safely
 * inside the Bangkok calendar day, so `bangkokLocalDate(now)` == the sheet date
 * and `fiscalYearFromUtcIso` lands in the right FY for the SC bill stream.
 */
export function issueClockIso(dateOnly: string): string {
  return `${dateOnly}T05:00:00.000Z`;
}

/**
 * The TRUE charged coverage window: half-open `[issueDate, issueDate+12mo)` at
 * UTC midnight (operator decision #5 — anchor = Inv Date; renewal = +12 months).
 * `addMonthsUtc` clamps a month-end overflow (Feb 29 + 12mo → Feb 28), matching
 * the renewals period derivation byte-for-byte so the cycle-period equality
 * assert in the cycle step can compare strings directly.
 */
export function coverageWindowFor(issueDate: string): {
  readonly fromIso: string;
  readonly toIso: string;
} {
  const fromIso = midnightUtcIso(issueDate);
  return { fromIso, toIso: addMonthsUtc(fromIso, 12) };
}

/** Date-only + N days (UTC arithmetic — Bangkok has no DST). */
export function addDaysDateOnly(dateOnly: string, days: number): string {
  const d = new Date(midnightUtcIso(dateOnly));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `payment_reference` for a paid doc: the ORIGINAL TSCC document numbers
 * (operator decision #2 — minted numbers are ours; the old MB/RC live here).
 * Capped at 200 (recordPayment schema max).
 */
export function paymentReferenceFor(
  doc: Pick<Round3InvoiceDoc, 'origBillNo' | 'origReceiptNo'>,
): string {
  const ref = `TSCC ${doc.origBillNo}${doc.origReceiptNo ? ` / ${doc.origReceiptNo}` : ''}`;
  return ref.slice(0, 200);
}

/** `void_reason` citing the original TSCC bill number. Capped at 500 (schema max). */
export function voidReasonFor(doc: Pick<Round3InvoiceDoc, 'origBillNo'>): string {
  return `Cancelled per TSCC records (import; original ${doc.origBillNo})`.slice(0, 500);
}

export type DocDateError =
  | 'issue_date_invalid'
  | 'issue_date_in_future'
  | 'paid_missing_payment_date'
  | 'payment_before_issue'
  | 'payment_in_future';

/**
 * Importer-side date guard. `triggeredBy: 'admin_offline_mark'` BYPASSES
 * record-payment's own `[issue_date, today]` dialog-rail guard and the
 * terminated-membership gate — so this validation is the only fence between a
 * bad sheet cell and a mis-dated §86/4 receipt. `todayBangkok` = the Bangkok
 * calendar date of the run instant.
 */
export function validateDocDates(
  doc: Pick<Round3InvoiceDoc, 'issueDate' | 'paymentDate' | 'targetStatus'>,
  todayBangkok: string,
): readonly DocDateError[] {
  const errors: DocDateError[] = [];
  if (!ISO_DATE_RE.test(doc.issueDate)) {
    errors.push('issue_date_invalid');
    return errors; // everything else keys off issueDate
  }
  if (doc.issueDate > todayBangkok) errors.push('issue_date_in_future');
  if (doc.targetStatus === 'paid') {
    if (doc.paymentDate === null || !ISO_DATE_RE.test(doc.paymentDate)) {
      errors.push('paid_missing_payment_date');
    } else {
      if (doc.paymentDate < doc.issueDate) errors.push('payment_before_issue');
      if (doc.paymentDate > todayBangkok) errors.push('payment_in_future');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Report (PII-free by construction — spec § 7)
// ---------------------------------------------------------------------------

export type CycleOutcome =
  | 'anchored_upcoming' // paid arm: cycle created 'upcoming' + anchored_at/anchor_invoice_id stamped
  | 'linked_awaiting' // issued arm: cycle created 'awaiting_payment' + linked_invoice_id set
  | 'skipped_active_exists' // idempotent no-op (re-run)
  | 'none_inactive_member' // member inactive → no cycle (reported)
  | 'none_void' // void doc → no cycle
  | 'none' // not reached (error before the cycle step) / dry-run
  | null;

export interface DocOutcome {
  readonly action: 'imported' | 'resumed' | 'skipped_already_imported' | 'error' | 'planned';
  /** Machine code only (use-case error codes / plan codes) — never free text. */
  readonly errorCode: string | null;
  readonly mintedBillNo: string | null;
  readonly mintedReceiptNo: string | null;
  readonly memberNumber: number | null;
  readonly memberActive: boolean | null;
  readonly cycle: CycleOutcome;
  /** Dry-run/commit step plan, e.g. ['create_draft','issue','record_payment','cycle:anchor']. */
  readonly plannedSteps: readonly string[] | null;
}

export interface DocReportPair {
  readonly doc: Round3InvoiceDoc;
  readonly outcome: DocOutcome;
}

/** [rowIndex, origBillNo, origReceiptNo, mintedBillNo, mintedReceiptNo, memberNumber] */
export type MintedNumberRow = readonly [
  number,
  string,
  string | null,
  string | null,
  string | null,
  number | null,
];

export interface InvoiceImportReportDoc {
  readonly generatedAt: string;
  readonly mode: 'dry-run' | 'commit';
  readonly runId: string;
  readonly todayBangkok: string;
  readonly totals: {
    readonly docs: number;
    readonly byTargetStatus: Readonly<Record<string, number>>;
    readonly imported: number;
    readonly resumed: number;
    readonly skippedAlreadyImported: number;
    readonly planned: number;
    readonly errors: number;
  };
  readonly cycles: {
    readonly anchoredUpcoming: number;
    readonly linkedAwaiting: number;
    readonly skippedActiveExists: number;
    readonly noneInactiveMember: number;
    readonly noneVoid: number;
  };
  readonly mintedNumberMap: readonly MintedNumberRow[];
  readonly skipped: ReadonlyArray<{ readonly rowIndex: number; readonly reason: string }>;
  readonly errors: ReadonlyArray<{ readonly rowIndex: number; readonly code: string }>;
  /** ROUND3_PLAN.md § "จุดที่ต้องเล่าให้ operator" — the three call-out lists. */
  readonly operatorAttention: {
    /**
     * Issued docs already > SYSTEM-due+60 → the first lapse cron after F8
     * re-enable terminates them. Keyed on the SYSTEM due date
     * (issueDate + tenant_invoice_settings.default_net_days) because that is
     * the clock the lapse cron actually reads — the sheet's own due date is
     * shown alongside for the operator but never drives the predicate
     * (review finding R3-5).
     */
    readonly issuedPastDuePlus60: ReadonlyArray<{
      readonly rowIndex: number;
      /** The sheet's own Due Date cell (report-only). */
      readonly dueDateExcel: string;
      /** The due date the SYSTEM mints: issueDate + default_net_days. */
      readonly systemDueDate: string;
    }>;
    /** Paid docs whose coverage already ended → enter-awaiting flips them to COLLECT immediately. */
    readonly paidCoverageEnded: ReadonlyArray<{
      readonly rowIndex: number;
      readonly coverageTo: string;
    }>;
    /** Issued docs held by INACTIVE members — bill stands alone, no cycle. */
    readonly issuedInactiveMember: ReadonlyArray<{ readonly rowIndex: number }>;
  };
}

export function buildInvoiceImportReport(input: {
  readonly mode: 'dry-run' | 'commit';
  readonly generatedAt: string;
  readonly runId: string;
  readonly todayBangkok: string;
  /** tenant_invoice_settings.default_net_days — drives the SYSTEM due date
   *  (issue + netDays) that the lapse-cron call-out list is keyed on. */
  readonly defaultNetDays: number;
  readonly pairs: readonly DocReportPair[];
}): InvoiceImportReportDoc {
  const { pairs, todayBangkok, defaultNetDays } = input;

  const byTargetStatus: Record<string, number> = {};
  let imported = 0;
  let resumed = 0;
  let skippedAlreadyImported = 0;
  let planned = 0;
  let errors = 0;
  const cycles = {
    anchoredUpcoming: 0,
    linkedAwaiting: 0,
    skippedActiveExists: 0,
    noneInactiveMember: 0,
    noneVoid: 0,
  };
  const mintedNumberMap: MintedNumberRow[] = [];
  const skipped: Array<{ rowIndex: number; reason: string }> = [];
  const errorRows: Array<{ rowIndex: number; code: string }> = [];
  const issuedPastDuePlus60: Array<{
    rowIndex: number;
    dueDateExcel: string;
    systemDueDate: string;
  }> = [];
  const paidCoverageEnded: Array<{ rowIndex: number; coverageTo: string }> = [];
  const issuedInactiveMember: Array<{ rowIndex: number }> = [];

  for (const { doc, outcome } of pairs) {
    byTargetStatus[doc.targetStatus] = (byTargetStatus[doc.targetStatus] ?? 0) + 1;
    switch (outcome.action) {
      case 'imported':
        imported += 1;
        break;
      case 'resumed':
        resumed += 1;
        break;
      case 'skipped_already_imported':
        skippedAlreadyImported += 1;
        skipped.push({ rowIndex: doc.rowIndex, reason: 'already_imported' });
        break;
      case 'planned':
        planned += 1;
        break;
      case 'error':
        errors += 1;
        errorRows.push({ rowIndex: doc.rowIndex, code: outcome.errorCode ?? 'unknown' });
        break;
    }
    switch (outcome.cycle) {
      case 'anchored_upcoming':
        cycles.anchoredUpcoming += 1;
        break;
      case 'linked_awaiting':
        cycles.linkedAwaiting += 1;
        break;
      case 'skipped_active_exists':
        cycles.skippedActiveExists += 1;
        break;
      case 'none_inactive_member':
        cycles.noneInactiveMember += 1;
        break;
      case 'none_void':
        cycles.noneVoid += 1;
        break;
      default:
        break;
    }
    if (outcome.mintedBillNo !== null || outcome.mintedReceiptNo !== null) {
      mintedNumberMap.push([
        doc.rowIndex,
        doc.origBillNo,
        doc.origReceiptNo,
        outcome.mintedBillNo,
        outcome.mintedReceiptNo,
        outcome.memberNumber,
      ]);
    }

    // Operator-attention lists (computed on the DOC, independent of run mode,
    // but never for a doc that errored — it does not exist in the system).
    if (outcome.action !== 'error' && ISO_DATE_RE.test(doc.issueDate)) {
      if (doc.targetStatus === 'issued') {
        // The lapse cron's clock is the SYSTEM due date (issue + net days
        // snapshot), never the sheet's Due Date cell — key the predicate on it
        // (R3-5). Both dates are still shown to the operator.
        const systemDueDate = addDaysDateOnly(doc.issueDate, defaultNetDays);
        if (addDaysDateOnly(systemDueDate, 60) < todayBangkok) {
          issuedPastDuePlus60.push({
            rowIndex: doc.rowIndex,
            dueDateExcel: doc.dueDateExcel,
            systemDueDate,
          });
        }
        if (outcome.memberActive === false) {
          issuedInactiveMember.push({ rowIndex: doc.rowIndex });
        }
      }
      if (doc.targetStatus === 'paid') {
        const coverageTo = coverageWindowFor(doc.issueDate).toIso.slice(0, 10);
        // Half-open window: coverage ends AT `toIso` midnight — <= today means ended.
        if (coverageTo <= todayBangkok) {
          paidCoverageEnded.push({ rowIndex: doc.rowIndex, coverageTo });
        }
      }
    }
  }

  mintedNumberMap.sort((a, b) => a[0] - b[0]);

  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    runId: input.runId,
    todayBangkok,
    totals: {
      docs: pairs.length,
      byTargetStatus,
      imported,
      resumed,
      skippedAlreadyImported,
      planned,
      errors,
    },
    cycles,
    mintedNumberMap,
    skipped,
    errors: errorRows,
    operatorAttention: { issuedPastDuePlus60, paidCoverageEnded, issuedInactiveMember },
  };
}

/** Console rendering (PII-free — same currency as the JSON report). */
export function renderInvoiceImportText(report: InvoiceImportReportDoc): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`=== Round-3 invoice import — ${report.mode} (run ${report.runId}) ===`);
  lines.push(
    `Docs: ${report.totals.docs}  (` +
      Object.entries(report.totals.byTargetStatus)
        .sort()
        .map(([s, n]) => `${s} ${n}`)
        .join(' · ') +
      ')',
  );
  lines.push(
    `Actions: imported ${report.totals.imported} · resumed ${report.totals.resumed} · ` +
      `already-imported ${report.totals.skippedAlreadyImported} · planned ${report.totals.planned} · ` +
      `errors ${report.totals.errors}`,
  );
  lines.push(
    `Cycles: anchored(upcoming) ${report.cycles.anchoredUpcoming} · ` +
      `linked(awaiting_payment) ${report.cycles.linkedAwaiting} · ` +
      `skipped(active exists) ${report.cycles.skippedActiveExists} · ` +
      `none(inactive) ${report.cycles.noneInactiveMember} · none(void) ${report.cycles.noneVoid}`,
  );
  if (report.mintedNumberMap.length > 0) {
    lines.push('Minted-number map (row · orig bill · orig RC · minted bill · minted RC · member#):');
    for (const [row, ob, orc, mb, mrc, mn] of report.mintedNumberMap) {
      lines.push(
        `  ${row} · ${ob} · ${orc ?? '-'} · ${mb ?? '-'} · ${mrc ?? '-'} · ${mn ?? '-'}`,
      );
    }
  }
  if (report.errors.length > 0) {
    lines.push('ERRORS (rowIndex · code):');
    for (const e of report.errors) lines.push(`  ${e.rowIndex} · ${e.code}`);
  }
  if (report.skipped.length > 0) {
    lines.push('Skipped (rowIndex · reason):');
    for (const s of report.skipped) lines.push(`  ${s.rowIndex} · ${s.reason}`);
  }
  const att = report.operatorAttention;
  if (att.issuedPastDuePlus60.length > 0) {
    lines.push('OPERATOR — issued bills already past SYSTEM-due+60 (first lapse cron will TERMINATE):');
    for (const a of att.issuedPastDuePlus60) {
      lines.push(
        `  row ${a.rowIndex} · system due ${a.systemDueDate} · sheet due ${a.dueDateExcel || '-'}`,
      );
    }
  }
  if (att.paidCoverageEnded.length > 0) {
    lines.push('OPERATOR — paid members whose coverage already ended (enter COLLECT immediately):');
    for (const a of att.paidCoverageEnded) {
      lines.push(`  row ${a.rowIndex} · coverage ended ${a.coverageTo}`);
    }
  }
  if (att.issuedInactiveMember.length > 0) {
    lines.push('OPERATOR — issued bills held by INACTIVE members (no cycle; bill stands alone):');
    for (const a of att.issuedInactiveMember) lines.push(`  row ${a.rowIndex}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration (lazy DB imports — see module docstring)
// ---------------------------------------------------------------------------

export interface InvoiceImportOverrides {
  /** Test seam (same contract as `InvoicingAdapterOverrides.blob`, PR #280). */
  readonly blob?: BlobStoragePort;
}

export interface RunInvoiceImportInput {
  readonly ctx: TenantContext;
  readonly docs: readonly Round3InvoiceDoc[];
  /** Plan tier label → plan_id (CLI: buildTierResolver vs catalogue year 2026). */
  readonly resolvePlanId: (planTier: string) => string | null;
  readonly commit: boolean;
  /** REQUIRED in commit mode (draft_by_user_id FK / voided_by / audit actor). */
  readonly actorUserId: string | null;
  readonly overrides?: InvoiceImportOverrides;
  /** Injectable run instant (tests); default `new Date().toISOString()`. */
  readonly nowIso?: string;
}

export interface RunInvoiceImportResult {
  readonly report: InvoiceImportReportDoc;
  readonly pairs: readonly DocReportPair[];
  /**
   * TRUE when `commit: true` was requested but the pre-flight found ≥1
   * plan-stage error (R3-3): NOTHING was written and `report.mode` is
   * 'dry-run' (an honest description of what actually ran — the full
   * per-doc plan is in `pairs`). The CLI must exit non-zero.
   */
  readonly commitRefused: boolean;
}

/** Step-tagged typed error — becomes the PII-free `errorCode` in the report. */
class DocStepError extends Error {
  override readonly name = 'DocStepError';
  constructor(
    public readonly step: string,
    public readonly code: string,
  ) {
    super(`${step}_failed:${code}`);
  }
}

/** Part-1 remediation hint for the Next-vendored `server-only` marker. */
function rethrowWithServerOnlyHint(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('server-only')) {
    throw new Error(
      `cannot load the module graph under plain tsx (it reaches the Next-vendored ` +
        `'server-only' marker, which is not installed in node_modules). Re-run with ` +
        `TSX_TSCONFIG_PATH=tsconfig.scripts.json — see scripts/lib/server-only-stub.ts.`,
    );
  }
  throw e;
}

/**
 * Everything that (transitively) touches `src/lib/env.ts` loads HERE, lazily.
 * SEQUENTIAL awaits on purpose — a `Promise.all` of concurrent dynamic imports
 * over the app's overlapping (cyclic) barrel graphs can deadlock the module
 * runner (observed: vitest/vite-node hangs with zero output); one-at-a-time
 * imports resolve each shared subgraph before the next starts.
 */
async function loadDbModules() {
  try {
    const db = await import('@/lib/db');
    const membersSchema = await import('@/modules/members/infrastructure/db/schema-members');
    const contactsSchema = await import('@/modules/members/infrastructure/db/schema-contacts');
    const invoicesSchema = await import('@/modules/invoicing/infrastructure/db/schema-invoices');
    const settingsSchema = await import(
      '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings'
    );
    const draftUc = await import('@/modules/invoicing/application/use-cases/create-invoice-draft');
    const issueUc = await import('@/modules/invoicing/application/use-cases/issue-invoice');
    const payUc = await import('@/modules/invoicing/application/use-cases/record-payment');
    const voidUc = await import('@/modules/invoicing/application/use-cases/void-invoice');
    const deleteUc = await import('@/modules/invoicing/application/use-cases/delete-invoice-draft');
    const depsMod = await import('@/modules/invoicing/application/invoicing-deps');
    const renewalsBarrel = await import('@/modules/renewals');
    const cycleUc = await import('@/modules/renewals/application/use-cases/create-cycle-in-tx');
    const renewalDomain = await import('@/modules/renewals/domain/renewal-cycle');
    const memberDomain = await import('@/modules/members/domain/member');
    const invoiceDomain = await import('@/modules/invoicing/domain/invoice');
    return {
      runInTenant: db.runInTenant,
      members: membersSchema.members,
      contacts: contactsSchema.contacts,
      invoices: invoicesSchema.invoices,
      tenantInvoiceSettings: settingsSchema.tenantInvoiceSettings,
      createInvoiceDraft: draftUc.createInvoiceDraft,
      issueInvoice: issueUc.issueInvoice,
      recordPayment: payUc.recordPayment,
      voidInvoice: voidUc.voidInvoice,
      deleteInvoiceDraft: deleteUc.deleteInvoiceDraft,
      makeCreateInvoiceDraftDeps: depsMod.makeCreateInvoiceDraftDeps,
      makeIssueInvoiceDeps: depsMod.makeIssueInvoiceDeps,
      makeRecordPaymentDeps: depsMod.makeRecordPaymentDeps,
      makeVoidInvoiceDeps: depsMod.makeVoidInvoiceDeps,
      makeDeleteInvoiceDraftDeps: depsMod.makeDeleteInvoiceDraftDeps,
      makeRenewalsDeps: renewalsBarrel.makeRenewalsDeps,
      createCycleInTx: cycleUc.createCycleInTx,
      asCycleId: renewalDomain.asCycleId,
      asMemberId: memberDomain.asMemberId,
      asInvoiceId: invoiceDomain.asInvoiceId,
    };
  } catch (e) {
    rethrowWithServerOnlyHint(e);
  }
}
type DbModules = Awaited<ReturnType<typeof loadDbModules>>;

interface MemberRef {
  readonly memberId: string;
  readonly memberNumber: number;
  readonly active: boolean;
}

interface ExistingInvoiceRef {
  readonly invoiceId: string;
  readonly status: string;
  readonly coverageFromIso: string | null;
  readonly coverageToIso: string | null;
  readonly billNo: string | null;
  readonly receiptNo: string | null;
}

interface PlanContext {
  readonly memberByEmail: ReadonlyMap<string, MemberRef>;
  readonly invoicesByMember: ReadonlyMap<string, readonly ExistingInvoiceRef[]>;
  /** tenant_invoice_settings.default_net_days (30 when no settings row yet) —
   *  the SYSTEM due-date clock the operator lapse call-out is keyed on. */
  readonly defaultNetDays: number;
}

/** One tenant-scoped read pass: mockup-email → member, member → membership
 *  invoices, tenant default_net_days. */
async function loadPlanContext(
  mods: DbModules,
  ctx: TenantContext,
  docs: readonly Round3InvoiceDoc[],
): Promise<PlanContext> {
  const emails = [...new Set(docs.map((d) => d.contactEmail.toLowerCase()))];
  return mods.runInTenant(ctx, async (tx) => {
    const memberByEmail = new Map<string, MemberRef>();
    const invoicesByMember = new Map<string, ExistingInvoiceRef[]>();

    // issueInvoice snapshots settings.defaultNetDays into net_days_snapshot —
    // read the same column so the report's "system due" matches what will be
    // minted (schema default 30 when the tenant has no settings row yet; in
    // that state issueInvoice would refuse anyway).
    const settingsRows = await tx
      .select({ defaultNetDays: mods.tenantInvoiceSettings.defaultNetDays })
      .from(mods.tenantInvoiceSettings)
      .where(eq(mods.tenantInvoiceSettings.tenantId, ctx.slug));
    const defaultNetDays = settingsRows[0]?.defaultNetDays ?? 30;

    if (emails.length === 0) return { memberByEmail, invoicesByMember, defaultNetDays };

    const memberRows = await tx
      .select({
        email: mods.contacts.email,
        memberId: mods.members.memberId,
        memberNumber: mods.members.memberNumber,
        status: mods.members.status,
      })
      .from(mods.contacts)
      .innerJoin(
        mods.members,
        and(
          eq(mods.members.tenantId, mods.contacts.tenantId),
          eq(mods.members.memberId, mods.contacts.memberId),
        ),
      )
      .where(
        and(
          eq(mods.contacts.tenantId, ctx.slug),
          isNull(mods.contacts.removedAt),
          isNull(mods.members.erasedAt),
          inArray(sql`lower(${mods.contacts.email})`, emails),
        ),
      );
    for (const r of memberRows) {
      memberByEmail.set(r.email.toLowerCase(), {
        memberId: r.memberId,
        memberNumber: r.memberNumber,
        active: r.status === 'active',
      });
    }

    const memberIds = [...new Set(memberRows.map((r) => r.memberId))];
    if (memberIds.length > 0) {
      const invoiceRows = await tx
        .select({
          invoiceId: mods.invoices.invoiceId,
          memberId: mods.invoices.memberId,
          status: mods.invoices.status,
          coverageFrom: mods.invoices.coverageFrom,
          coverageTo: mods.invoices.coverageTo,
          billNo: mods.invoices.billDocumentNumberRaw,
          receiptNo: mods.invoices.receiptDocumentNumberRaw,
        })
        .from(mods.invoices)
        .where(
          and(
            eq(mods.invoices.tenantId, ctx.slug),
            eq(mods.invoices.invoiceSubject, 'membership'),
            inArray(mods.invoices.memberId, memberIds),
          ),
        );
      for (const r of invoiceRows) {
        if (r.memberId === null) continue;
        const list = invoicesByMember.get(r.memberId) ?? [];
        list.push({
          invoiceId: r.invoiceId,
          status: r.status,
          coverageFromIso: r.coverageFrom ? r.coverageFrom.toISOString() : null,
          coverageToIso: r.coverageTo ? r.coverageTo.toISOString() : null,
          billNo: r.billNo,
          receiptNo: r.receiptNo,
        });
        invoicesByMember.set(r.memberId, list);
      }
    }

    return { memberByEmail, invoicesByMember, defaultNetDays };
  });
}

type DocPlan =
  | { readonly kind: 'error'; readonly code: string }
  | {
      readonly kind: 'skip_already_imported';
      readonly member: MemberRef;
      readonly planId: string;
      readonly existing: ExistingInvoiceRef;
    }
  | {
      readonly kind: 'resume';
      readonly member: MemberRef;
      readonly planId: string;
      readonly existing: ExistingInvoiceRef;
      readonly step: 'pay' | 'void';
    }
  | {
      readonly kind: 'import';
      readonly member: MemberRef;
      readonly planId: string;
      readonly coverage: { readonly fromIso: string; readonly toIso: string };
      readonly draftsToDelete: readonly string[];
    };

function planDoc(
  doc: Round3InvoiceDoc,
  planCtx: PlanContext,
  resolvePlanId: (planTier: string) => string | null,
  todayBangkok: string,
): DocPlan {
  const dateErrors = validateDocDates(doc, todayBangkok);
  if (dateErrors.length > 0) return { kind: 'error', code: dateErrors.join(',') };

  const member = planCtx.memberByEmail.get(doc.contactEmail.toLowerCase());
  if (!member) return { kind: 'error', code: 'member_not_found' };

  const planId = resolvePlanId(doc.planTier);
  if (planId === null) return { kind: 'error', code: 'plan_tier_unresolved' };

  const existing = planCtx.invoicesByMember.get(member.memberId) ?? [];
  const nonDrafts = existing.filter((i) => i.status !== 'draft');
  const drafts = existing.filter((i) => i.status === 'draft');

  if (nonDrafts.length > 1) return { kind: 'error', code: 'multiple_existing_invoices' };

  const found = nonDrafts[0];
  if (found === undefined) {
    return {
      kind: 'import',
      member,
      planId,
      coverage: coverageWindowFor(doc.issueDate),
      draftsToDelete: drafts.map((d) => d.invoiceId),
    };
  }

  // Resume / skip decision table (see module docstring § Idempotency).
  const target: Round3InvoiceStatus = doc.targetStatus;
  if (found.status === 'void') {
    return target === 'void'
      ? { kind: 'skip_already_imported', member, planId, existing: found }
      : { kind: 'error', code: 'existing_invoice_status_mismatch' };
  }
  if (found.status === 'paid') {
    return target === 'paid'
      ? { kind: 'skip_already_imported', member, planId, existing: found }
      : { kind: 'error', code: 'existing_invoice_status_mismatch' };
  }
  if (found.status === 'issued') {
    if (target === 'issued') {
      return { kind: 'skip_already_imported', member, planId, existing: found };
    }
    return { kind: 'resume', member, planId, existing: found, step: target === 'paid' ? 'pay' : 'void' };
  }
  return { kind: 'error', code: 'existing_invoice_status_mismatch' };
}

function plannedStepsFor(doc: Round3InvoiceDoc, plan: DocPlan): readonly string[] | null {
  switch (plan.kind) {
    case 'error':
      return null;
    case 'skip_already_imported':
      return doc.targetStatus === 'void' || !plan.member.active
        ? ['skip_already_imported']
        : ['skip_already_imported', doc.targetStatus === 'paid' ? 'cycle:anchor' : 'cycle:link'];
    case 'resume': {
      const steps = [plan.step === 'pay' ? 'record_payment' : 'void'];
      if (plan.step === 'pay' && plan.member.active) steps.push('cycle:anchor');
      return steps;
    }
    case 'import': {
      const steps: string[] = [];
      for (const id of plan.draftsToDelete) steps.push(`delete_stale_draft:${id.slice(0, 8)}`);
      steps.push('create_draft', 'issue');
      if (doc.targetStatus === 'paid') steps.push('record_payment');
      if (doc.targetStatus === 'void') steps.push('void');
      if (doc.targetStatus !== 'void' && plan.member.active) {
        steps.push(doc.targetStatus === 'paid' ? 'cycle:anchor' : 'cycle:link');
      }
      return steps;
    }
  }
}

/** Deps builders — factory output + the deterministic per-doc overrides. */
function buildDeps(mods: DbModules, tenantId: string, overrides: InvoiceImportOverrides | undefined) {
  const blobOverride = overrides?.blob ? { blob: overrides.blob } : {};
  return {
    draft: (issueDate: string) => ({
      ...mods.makeCreateInvoiceDraftDeps(tenantId),
      clock: { nowIso: () => issueClockIso(issueDate) },
    }),
    issue: (issueDate: string) => ({
      ...mods.makeIssueInvoiceDeps(tenantId),
      ...blobOverride,
      clock: { nowIso: () => issueClockIso(issueDate) },
      // 088 tax-at-payment flow pinned ON (prod state) — SC bill at issue,
      // §86/4 RC at payment. Deps-spread is the operative pin (env is cached).
      taxAtPayment: 'on' as const,
    }),
    pay: (paymentDate: string) => ({
      ...mods.makeRecordPaymentDeps(tenantId),
      ...blobOverride,
      clock: { nowIso: () => issueClockIso(paymentDate) },
      taxAtPayment: 'on' as const,
      // Force the SYNCHRONOUS receipt render (deterministic import — the RC
      // number + receipt PDF exist when the doc's sequence finishes).
      asyncReceiptPdf: false,
    }),
    void: (issueDate: string) => ({
      ...mods.makeVoidInvoiceDeps(tenantId),
      ...blobOverride,
      clock: { nowIso: () => issueClockIso(issueDate) },
    }),
    deleteDraft: () => mods.makeDeleteInvoiceDraftDeps(tenantId),
  };
}
type DepsBuilders = ReturnType<typeof buildDeps>;

interface CycleRuntime {
  readonly cyclesRepo: ReturnType<DbModules['makeRenewalsDeps']>['cyclesRepo'];
  readonly cycleDeps: {
    readonly cyclesRepo: ReturnType<DbModules['makeRenewalsDeps']>['cyclesRepo'];
    readonly planLookup: ReturnType<DbModules['makeRenewalsDeps']>['planLookupForRenewal'];
    readonly auditEmitter: ReturnType<DbModules['makeRenewalsDeps']>['auditEmitter'];
    readonly idFactory: { cycleId(): ReturnType<DbModules['asCycleId']> };
  };
}

function buildCycleRuntime(mods: DbModules, tenantId: string): CycleRuntime {
  const renewalsDeps = mods.makeRenewalsDeps(tenantId);
  return {
    cyclesRepo: renewalsDeps.cyclesRepo,
    cycleDeps: {
      cyclesRepo: renewalsDeps.cyclesRepo,
      planLookup: renewalsDeps.planLookupForRenewal,
      auditEmitter: renewalsDeps.auditEmitter,
      idFactory: { cycleId: () => mods.asCycleId(randomUUID()) },
    },
  };
}

/**
 * Cycle step (ONLY for active members, paid/issued docs). One `runInTenant` tx:
 * `createCycleInTx` (idempotent) → period==coverage equality assert →
 * paid: `reanchorPeriodInTx` stamp · issued: `linkInvoice`.
 */
async function ensureCycleForDoc(
  mods: DbModules,
  cycleRt: CycleRuntime,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  doc: Round3InvoiceDoc,
  args: {
    readonly memberId: string;
    readonly planId: string;
    readonly invoiceId: string;
    readonly coverageFromIso: string;
    readonly coverageToIso: string;
  },
): Promise<CycleOutcome> {
  return mods.runInTenant(ctx, async (tx) => {
    const outcome = await mods.createCycleInTx(cycleRt.cycleDeps, tx, {
      tenantId: ctx.slug,
      memberId: args.memberId,
      periodFrom: args.coverageFromIso,
      planId: args.planId,
      actorUserId,
      actorRole: 'system',
      correlationId: `import-round3-invoices:${runId}:row${doc.rowIndex}`,
      ...(doc.targetStatus === 'issued' ? { startStatus: 'awaiting_payment' as const } : {}),
    });
    if (outcome.kind === 'skipped_active_exists') return 'skipped_active_exists';

    const cycle = outcome.cycle;
    // The plan term MUST be 12 months so the derived periodTo equals the
    // invoice's half-open coverage_to exactly (same addMonthsUtc arithmetic).
    if (cycle.periodTo !== args.coverageToIso) {
      throw new DocStepError(
        'cycle',
        `period_mismatch_${cycle.periodTo.slice(0, 10)}_vs_${args.coverageToIso.slice(0, 10)}`,
      );
    }

    if (doc.targetStatus === 'paid') {
      // R4 backfill pattern: stamp anchored_at + anchor_invoice_id so the
      // member's NEXT payment classifies 'renewal' (not first_payment). The
      // anchor invoice deliberately NEVER occupies linked_invoice_id.
      const res = await cycleRt.cyclesRepo.reanchorPeriodInTx(tx, ctx.slug, cycle.cycleId, {
        periodFrom: cycle.periodFrom,
        periodTo: cycle.periodTo,
        anchoredAt: midnightUtcIso(doc.paymentDate!),
        anchorInvoiceId: args.invoiceId,
        // Freshly-frozen fields, passed through unchanged (port docstring:
        // "pass current values otherwise").
        frozenPlanPriceThb: cycle.frozenPlanPriceThb,
        frozenPlanTermMonths: cycle.frozenPlanTermMonths,
      });
      if (!res) throw new DocStepError('cycle', 'anchor_guard_matched_0_rows');
      // Principle VIII — the anchor stamp is a state change; audit it in the
      // SAME tx (mirrors scripts/backfill-cycle-anchors.ts's atomic emit).
      await cycleRt.cycleDeps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_cycle_reanchored',
          payload: {
            cycle_id: cycle.cycleId,
            member_id: mods.asMemberId(args.memberId),
            invoice_id: mods.asInvoiceId(args.invoiceId),
            old_period_from: cycle.periodFrom,
            old_period_to: cycle.periodTo,
            new_period_from: res.cycle.periodFrom,
            new_period_to: res.cycle.periodTo,
            old_status: cycle.status,
            refroze_plan_fields: false,
            reminder_events_reset: res.reminderEventsReset,
          },
        },
        {
          tenantId: ctx.slug,
          actorUserId,
          actorRole: 'system',
          correlationId: `import-round3-invoices:${runId}:row${doc.rowIndex}`,
          summary: `Round-3 import: payment-activated historical cycle (sheet row ${doc.rowIndex})`,
        },
      );
      return 'anchored_upcoming';
    }

    await cycleRt.cyclesRepo.linkInvoice(tx, ctx.slug, cycle.cycleId, args.invoiceId);
    return 'linked_awaiting';
  });
}

async function payDoc(
  mods: DbModules,
  deps: DepsBuilders,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  doc: Round3InvoiceDoc,
  invoiceId: string,
): Promise<string | null> {
  const paid = await mods.recordPayment(deps.pay(doc.paymentDate!), {
    tenantId: ctx.slug,
    actorUserId,
    requestId: `r3inv:${runId}:row${doc.rowIndex}:pay`,
    invoiceId,
    paymentMethod: 'bank_transfer',
    paymentReference: paymentReferenceFor(doc),
    paymentDate: doc.paymentDate!,
    suppressReceiptEmail: true,
    // Bypasses the dialog-rail [issue_date, today] guard + terminated gate —
    // `validateDocDates` above is the importer's own fence for both.
    triggeredBy: 'admin_offline_mark',
  });
  if (!paid.ok) throw new DocStepError('pay', paid.error.code);
  return paid.value.receiptDocumentNumberRaw;
}

async function voidDoc(
  mods: DbModules,
  deps: DepsBuilders,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  doc: Round3InvoiceDoc,
  invoiceId: string,
): Promise<void> {
  const voided = await mods.voidInvoice(deps.void(doc.issueDate), {
    tenantId: ctx.slug,
    actorUserId,
    requestId: `r3inv:${runId}:row${doc.rowIndex}:void`,
    invoiceId,
    voidReason: voidReasonFor(doc),
    requireStatus: 'issued',
    suppressCancellationEmail: true,
  });
  if (!voided.ok) throw new DocStepError('void', voided.error.code);
}

// ---------------------------------------------------------------------------
// Phased execution (R3-4) — one mutable record per doc, filled across phases.
// ---------------------------------------------------------------------------

interface DocExecState {
  readonly doc: Round3InvoiceDoc;
  readonly plan: DocPlan;
  /** Set on the first phase error — the doc skips its remaining phases. */
  failed: boolean;
  errorCode: string | null;
  mintedBillNo: string | null;
  mintedReceiptNo: string | null;
  cycle: CycleOutcome;
  invoiceId: string | null;
  coverageFromIso: string | null;
  coverageToIso: string | null;
}

function initDocState(doc: Round3InvoiceDoc, plan: DocPlan): DocExecState {
  const state: DocExecState = {
    doc,
    plan,
    failed: false,
    errorCode: null,
    mintedBillNo: null,
    mintedReceiptNo: null,
    cycle: 'none',
    invoiceId: null,
    coverageFromIso: null,
    coverageToIso: null,
  };
  switch (plan.kind) {
    case 'error':
      // Defensive — the commit pre-flight refuses before execution when any
      // plan errored, so this only carries dry-run-style bookkeeping.
      state.failed = true;
      state.errorCode = plan.code;
      break;
    case 'skip_already_imported':
      state.invoiceId = plan.existing.invoiceId;
      state.mintedBillNo = plan.existing.billNo;
      state.mintedReceiptNo = plan.existing.receiptNo;
      state.coverageFromIso = plan.existing.coverageFromIso;
      state.coverageToIso = plan.existing.coverageToIso;
      break;
    case 'resume':
      state.invoiceId = plan.existing.invoiceId;
      state.mintedBillNo = plan.existing.billNo;
      state.coverageFromIso = plan.existing.coverageFromIso;
      state.coverageToIso = plan.existing.coverageToIso;
      break;
    case 'import':
      break;
  }
  return state;
}

function markDocFailed(state: DocExecState, e: unknown): void {
  state.failed = true;
  state.errorCode =
    e instanceof DocStepError ? e.message : `exception:${e instanceof Error ? e.name : 'unknown'}`;
  // Full message to the operator terminal only (never into the report).
  console.error(
    `[import-round3-invoices] row ${state.doc.rowIndex} FAILED: ` +
      (e instanceof Error ? e.message : String(e)),
  );
}

/** Renewal-cycle step for one doc (no-ops for void docs / inactive members). */
async function ensureCycleForState(
  mods: DbModules,
  cycleRt: CycleRuntime,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  state: DocExecState,
): Promise<void> {
  const { doc, plan } = state;
  if (plan.kind === 'error') return;
  if (doc.targetStatus === 'void') {
    state.cycle = 'none_void';
    return;
  }
  if (!plan.member.active) {
    state.cycle = 'none_inactive_member';
    return;
  }
  if (state.invoiceId === null) throw new DocStepError('cycle', 'invoice_id_missing');
  if (state.coverageFromIso === null || state.coverageToIso === null) {
    throw new DocStepError('cycle', 'existing_invoice_missing_coverage');
  }
  state.cycle = await ensureCycleForDoc(mods, cycleRt, ctx, actorUserId, runId, doc, {
    memberId: plan.member.memberId,
    planId: plan.planId,
    invoiceId: state.invoiceId,
    coverageFromIso: state.coverageFromIso,
    coverageToIso: state.coverageToIso,
  });
}

/**
 * Phase A — ISSUE. `states` arrives in ascending Inv Date order, so
 * SC-{FY}-{NNNNNN} bill numbers run in issue-date order within each FY.
 * Resume/skip docs already hold their bill number and skip the phase.
 */
async function runIssuePhase(
  mods: DbModules,
  deps: DepsBuilders,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  states: readonly DocExecState[],
): Promise<void> {
  for (const state of states) {
    if (state.failed) continue;
    const { doc, plan } = state;
    // Progress breadcrumb (PII-free) — the prod run is ~125 sequential docs
    // with a real PDF render each; the operator needs to see it moving.
    console.log(
      `[import-round3-invoices] phase A row ${doc.rowIndex} (${doc.issueDate} · ${doc.targetStatus}) → ${plan.kind}`,
    );
    if (plan.kind !== 'import') continue;
    try {
      // 0. Stale drafts from a crashed run — DELETE, then import fresh.
      for (const draftId of plan.draftsToDelete) {
        const del = await mods.deleteInvoiceDraft(deps.deleteDraft(), {
          tenantId: ctx.slug,
          actorUserId,
          requestId: `r3inv:${runId}:row${doc.rowIndex}:delete-draft`,
          invoiceId: draftId,
        });
        if (!del.ok && del.error.code !== 'invoice_not_found') {
          throw new DocStepError('delete_stale_draft', del.error.code);
        }
      }

      // 1. Draft — frozen VAT-exclusive price + true half-open coverage window.
      const draft = await mods.createInvoiceDraft(deps.draft(doc.issueDate), {
        tenantId: ctx.slug,
        actorUserId,
        requestId: `r3inv:${runId}:row${doc.rowIndex}:draft`,
        memberId: plan.member.memberId,
        planId: plan.planId,
        planYear: doc.planYear,
        autoEmailOnIssue: false,
        renewalSignal: { unitPriceSatang: thbToSatang(doc.amountThb) },
        membershipCoverage: {
          kind: 'window',
          fromIso: plan.coverage.fromIso,
          toIso: plan.coverage.toIso,
        },
        coverageWindow: { fromIso: plan.coverage.fromIso, toIso: plan.coverage.toIso },
      });
      if (!draft.ok) throw new DocStepError('draft', draft.error.code);
      state.invoiceId = draft.value.invoiceId;
      state.coverageFromIso = plan.coverage.fromIso;
      state.coverageToIso = plan.coverage.toIso;

      // 2. Issue — per-doc clock backdates issue/due dates + the SC bill FY.
      const issued = await mods.issueInvoice(deps.issue(doc.issueDate), {
        tenantId: ctx.slug,
        actorUserId,
        requestId: `r3inv:${runId}:row${doc.rowIndex}:issue`,
        invoiceId: state.invoiceId,
        autoEmailOverride: false,
      });
      if (!issued.ok) throw new DocStepError('issue', issued.error.code);
      state.mintedBillNo = issued.value.billDocumentNumberRaw;
    } catch (e) {
      markDocFailed(state, e);
    }
  }
}

/**
 * Phase B — PAYMENT. Every PAID doc in ascending PAYMENT date (rowIndex
 * tiebreak), so RC-{FY(paymentDate)}-{NNNNNN} receipt numbers run in
 * payment-date order within each FY (the tax-register ordering — R3-4).
 * Already-paid docs skip the payment call but still ensure their cycle.
 */
async function runPaymentPhase(
  mods: DbModules,
  deps: DepsBuilders,
  cycleRt: CycleRuntime,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  states: readonly DocExecState[],
): Promise<void> {
  const paidStates = states
    .filter((s) => s.doc.targetStatus === 'paid')
    .sort((a, b) => {
      const pa = a.doc.paymentDate ?? '';
      const pb = b.doc.paymentDate ?? '';
      return pa < pb ? -1 : pa > pb ? 1 : a.doc.rowIndex - b.doc.rowIndex;
    });
  for (const state of paidStates) {
    if (state.failed) continue;
    const { doc, plan } = state;
    const needsPayment =
      plan.kind === 'import' || (plan.kind === 'resume' && plan.step === 'pay');
    console.log(
      `[import-round3-invoices] phase B row ${doc.rowIndex} (pay ${doc.paymentDate}) → ` +
        (needsPayment ? 'record_payment' : 'ensure_cycle'),
    );
    try {
      if (needsPayment) {
        if (state.invoiceId === null) throw new DocStepError('pay', 'invoice_id_missing');
        state.mintedReceiptNo = await payDoc(mods, deps, ctx, actorUserId, runId, doc, state.invoiceId);
      }
      await ensureCycleForState(mods, cycleRt, ctx, actorUserId, runId, state);
    } catch (e) {
      markDocFailed(state, e);
    }
  }
}

/**
 * Phase C — VOID + ISSUED-CYCLE. Ascending Inv Date (voids mint nothing, so
 * ordering is cosmetic). Void docs issue-then-void; issued docs of active
 * members get their awaiting_payment cycle + linkInvoice.
 */
async function runVoidAndCyclePhase(
  mods: DbModules,
  deps: DepsBuilders,
  cycleRt: CycleRuntime,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  states: readonly DocExecState[],
): Promise<void> {
  for (const state of states) {
    if (state.failed) continue;
    const { doc, plan } = state;
    if (doc.targetStatus === 'paid') continue; // fully handled in phase B
    try {
      if (doc.targetStatus === 'void') {
        const needsVoid =
          plan.kind === 'import' || (plan.kind === 'resume' && plan.step === 'void');
        console.log(
          `[import-round3-invoices] phase C row ${doc.rowIndex} (void) → ` +
            (needsVoid ? 'void' : 'already_void'),
        );
        if (needsVoid) {
          if (state.invoiceId === null) throw new DocStepError('void', 'invoice_id_missing');
          await voidDoc(mods, deps, ctx, actorUserId, runId, doc, state.invoiceId);
        }
        state.cycle = 'none_void';
      } else {
        console.log(
          `[import-round3-invoices] phase C row ${doc.rowIndex} (issued) → ensure_cycle`,
        );
        await ensureCycleForState(mods, cycleRt, ctx, actorUserId, runId, state);
      }
    } catch (e) {
      markDocFailed(state, e);
    }
  }
}

function stateToOutcome(state: DocExecState): DocOutcome {
  const { doc, plan } = state;
  const member = plan.kind === 'error' ? null : plan.member;
  const action: DocOutcome['action'] = state.failed
    ? 'error'
    : plan.kind === 'import'
      ? 'imported'
      : plan.kind === 'resume'
        ? 'resumed'
        : 'skipped_already_imported';
  return {
    action,
    errorCode: state.errorCode,
    mintedBillNo: state.mintedBillNo,
    mintedReceiptNo: state.mintedReceiptNo,
    memberNumber: member?.memberNumber ?? null,
    memberActive: member?.active ?? null,
    cycle: state.cycle,
    plannedSteps: plannedStepsFor(doc, plan),
  };
}

/**
 * Run the Round-3 invoice import. Dry-run (`commit:false`) performs tenant-
 * scoped READS only (member/invoice resolution) and reports the full per-doc
 * plan. `commit:true` first plans EVERY doc and REFUSES (zero writes,
 * `commitRefused: true`) if any doc has a plan-stage error (R3-3), then
 * executes in three phases (module docstring): A issue (ascending Inv Date →
 * SC numbers issue-date-ordered per FY) · B payment (ascending payment date →
 * RC numbers payment-date-ordered per FY) · C voids + issued-doc cycles.
 */
export async function runInvoiceImport(
  input: RunInvoiceImportInput,
): Promise<RunInvoiceImportResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const todayBangkok = bangkokDateOnly(nowIso);
  const runId = randomUUID().slice(0, 8);

  const mods = await loadDbModules();
  const planCtx = await loadPlanContext(mods, input.ctx, input.docs);

  const sorted = [...input.docs].sort((a, b) =>
    a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : a.rowIndex - b.rowIndex,
  );
  const planned = sorted.map((doc) => ({
    doc,
    plan: planDoc(doc, planCtx, input.resolvePlanId, todayBangkok),
  }));

  const buildPlannedPairs = (): DocReportPair[] =>
    planned.map(({ doc, plan }) => {
      const member = plan.kind === 'error' ? null : plan.member;
      return {
        doc,
        outcome: {
          action: plan.kind === 'error' ? ('error' as const) : ('planned' as const),
          errorCode: plan.kind === 'error' ? plan.code : null,
          mintedBillNo: null,
          mintedReceiptNo: null,
          memberNumber: member?.memberNumber ?? null,
          memberActive: member?.active ?? null,
          cycle: 'none' as const,
          plannedSteps: plannedStepsFor(doc, plan),
        },
      };
    });

  const finish = (
    mode: 'dry-run' | 'commit',
    pairs: readonly DocReportPair[],
    commitRefused: boolean,
  ): RunInvoiceImportResult => ({
    report: buildInvoiceImportReport({
      mode,
      generatedAt: nowIso,
      runId,
      todayBangkok,
      defaultNetDays: planCtx.defaultNetDays,
      pairs,
    }),
    pairs,
    commitRefused,
  });

  if (!input.commit) return finish('dry-run', buildPlannedPairs(), false);

  if (input.actorUserId === null) {
    throw new Error('runInvoiceImport: actorUserId is required in commit mode');
  }

  // PRE-FLIGHT GATE (R3-3): a doc that fails planning would leave a hole the
  // fix-up re-run fills with out-of-chronology SC/RC numbers. Refuse the whole
  // commit instead — zero writes, full plan reported, CLI exits 1.
  const planErrors = planned.flatMap((p) =>
    p.plan.kind === 'error' ? [{ rowIndex: p.doc.rowIndex, code: p.plan.code }] : [],
  );
  if (planErrors.length > 0) {
    console.error(
      `[import-round3-invoices] REFUSING --commit: ${planErrors.length} doc(s) failed ` +
        `planning — NOTHING was written. Fix these and re-run (rowIndex · code):`,
    );
    for (const e of planErrors) console.error(`  ${e.rowIndex} · ${e.code}`);
    return finish('dry-run', buildPlannedPairs(), true);
  }

  const deps = buildDeps(mods, input.ctx.slug, input.overrides);
  const cycleRt = buildCycleRuntime(mods, input.ctx.slug);
  const states = planned.map(({ doc, plan }) => initDocState(doc, plan));

  await runIssuePhase(mods, deps, input.ctx, input.actorUserId, runId, states);
  await runPaymentPhase(mods, deps, cycleRt, input.ctx, input.actorUserId, runId, states);
  await runVoidAndCyclePhase(mods, deps, cycleRt, input.ctx, input.actorUserId, runId, states);

  const pairs = states.map((s) => ({ doc: s.doc, outcome: stateToOutcome(s) }));
  return finish('commit', pairs, false);
}
