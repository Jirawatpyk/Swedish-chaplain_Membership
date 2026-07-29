/**
 * Round-3 invoice+receipt importer — CORE (docs/import/ROUND3_PLAN.md
 * § Invoice import, operator-approved 2026-07-29). Driven by the CLI
 * (`scripts/import-round3-invoices.ts`) and by the live-Neon integration test
 * (`tests/integration/scripts/import-round3-invoices.test.ts`).
 *
 * ── What it does (per document, ascending Inv Date so minted numbers run
 *    chronologically per fiscal year) ──────────────────────────────────────────
 *   1. resolve the member via the Part-1 mockup contact email
 *      (tenant-scoped, lower(email), removed_at IS NULL);
 *   2. `createInvoiceDraft` with `renewalSignal{unitPriceSatang}` (VAT-exclusive
 *      frozen price — suppresses the registration-fee auto-line + pro-rating)
 *      and the TRUE half-open coverage window `[issueDate, issueDate+12mo)`
 *      (both the printed §86/4 `membershipCoverage` and the mig-0281
 *      `coverageWindow` EXCLUDE-guard axis);
 *   3. `issueInvoice` with a PER-DOC injected ClockPort at `issueDate`T05:00Z
 *      (midday Bangkok — same Bangkok calendar day + correct bill fiscal year)
 *      → mints `bill_document_number_raw` SC-{FY}-{NNNNNN} + renders the PDF;
 *   4. paid → `recordPayment` (bank_transfer, sheet payment date, triggeredBy
 *      'admin_offline_mark') → mints RC-{FY(paymentDate)}-{NNNNNN} + receipt
 *      PDF (forced SYNCHRONOUS via the `asyncReceiptPdf:false` deps override);
 *      void → `voidInvoice` (issue-then-void; bill-stream gaps are legal);
 *   5. renewal cycle for ACTIVE members only: paid → `createCycleInTx`
 *      ('upcoming') + `reanchorPeriodInTx` stamp (`anchored_at`=payment date,
 *      `anchor_invoice_id`=the invoice — NEVER `linked_invoice_id`, schema
 *      comment 0238); issued → `createCycleInTx` ('awaiting_payment') +
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
 *   Each doc is its own use-case tx sequence; an error is recorded and the run
 *   CONTINUES (the CLI exits 1 when any error occurred in --commit mode). The
 *   use-cases are individually transactional, so a doc can never be
 *   half-written; a doc that issued but failed later resumes on re-run.
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

/** THB (possibly float-noisy Excel number) → exact satang bigint. */
export function thbToSatang(thb: number): bigint {
  return BigInt(Math.round(thb * 100));
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
    /** Issued docs already > sheet-due+60 → the first lapse cron after F8 re-enable terminates them. */
    readonly issuedPastDuePlus60: ReadonlyArray<{
      readonly rowIndex: number;
      readonly dueDateExcel: string;
      /** The due date the SYSTEM minted (issue+30) — differs from the sheet's. */
      readonly systemDueDate: string | null;
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
  readonly pairs: readonly DocReportPair[];
}): InvoiceImportReportDoc {
  const { pairs, todayBangkok } = input;

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
    systemDueDate: string | null;
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
        if (
          ISO_DATE_RE.test(doc.dueDateExcel) &&
          addDaysDateOnly(doc.dueDateExcel, 60) < todayBangkok
        ) {
          issuedPastDuePlus60.push({
            rowIndex: doc.rowIndex,
            dueDateExcel: doc.dueDateExcel,
            systemDueDate: addDaysDateOnly(doc.issueDate, 30),
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
    lines.push('OPERATOR — issued bills already past sheet-due+60 (first lapse cron will TERMINATE):');
    for (const a of att.issuedPastDuePlus60) {
      lines.push(
        `  row ${a.rowIndex} · sheet due ${a.dueDateExcel} · system due ${a.systemDueDate ?? '-'}`,
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
}

/** One tenant-scoped read pass: mockup-email → member, member → membership invoices. */
async function loadPlanContext(
  mods: DbModules,
  ctx: TenantContext,
  docs: readonly Round3InvoiceDoc[],
): Promise<PlanContext> {
  const emails = [...new Set(docs.map((d) => d.contactEmail.toLowerCase()))];
  return mods.runInTenant(ctx, async (tx) => {
    const memberByEmail = new Map<string, MemberRef>();
    const invoicesByMember = new Map<string, ExistingInvoiceRef[]>();
    if (emails.length === 0) return { memberByEmail, invoicesByMember };

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

    return { memberByEmail, invoicesByMember };
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

async function importDoc(
  mods: DbModules,
  deps: DepsBuilders,
  cycleRt: CycleRuntime,
  ctx: TenantContext,
  actorUserId: string,
  runId: string,
  doc: Round3InvoiceDoc,
  plan: DocPlan,
): Promise<DocOutcome> {
  const member = plan.kind === 'error' ? null : plan.member;
  let mintedBillNo: string | null = null;
  let mintedReceiptNo: string | null = null;
  let cycle: CycleOutcome = 'none';
  const base = {
    memberNumber: member?.memberNumber ?? null,
    memberActive: member?.active ?? null,
    plannedSteps: plannedStepsFor(doc, plan),
  };

  const ensureCycle = async (invoiceId: string, fromIso: string | null, toIso: string | null) => {
    if (doc.targetStatus === 'void') return (cycle = 'none_void');
    if (!member!.active) return (cycle = 'none_inactive_member');
    if (fromIso === null || toIso === null) {
      throw new DocStepError('cycle', 'existing_invoice_missing_coverage');
    }
    cycle = await ensureCycleForDoc(mods, cycleRt, ctx, actorUserId, runId, doc, {
      memberId: member!.memberId,
      planId: (plan as Extract<DocPlan, { planId: string }>).planId,
      invoiceId,
      coverageFromIso: fromIso,
      coverageToIso: toIso,
    });
    return cycle;
  };

  try {
    switch (plan.kind) {
      case 'error':
        return { ...base, action: 'error', errorCode: plan.code, mintedBillNo, mintedReceiptNo, cycle: 'none' };

      case 'skip_already_imported': {
        mintedBillNo = plan.existing.billNo;
        mintedReceiptNo = plan.existing.receiptNo;
        await ensureCycle(plan.existing.invoiceId, plan.existing.coverageFromIso, plan.existing.coverageToIso);
        return { ...base, action: 'skipped_already_imported', errorCode: null, mintedBillNo, mintedReceiptNo, cycle };
      }

      case 'resume': {
        mintedBillNo = plan.existing.billNo;
        if (plan.step === 'pay') {
          mintedReceiptNo = await payDoc(mods, deps, ctx, actorUserId, runId, doc, plan.existing.invoiceId);
          await ensureCycle(plan.existing.invoiceId, plan.existing.coverageFromIso, plan.existing.coverageToIso);
        } else {
          await voidDoc(mods, deps, ctx, actorUserId, runId, doc, plan.existing.invoiceId);
          cycle = 'none_void';
        }
        return { ...base, action: 'resumed', errorCode: null, mintedBillNo, mintedReceiptNo, cycle };
      }

      case 'import': {
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
          memberId: member!.memberId,
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
        const invoiceId = draft.value.invoiceId;

        // 2. Issue — per-doc clock backdates issue/due dates + the SC bill FY.
        const issued = await mods.issueInvoice(deps.issue(doc.issueDate), {
          tenantId: ctx.slug,
          actorUserId,
          requestId: `r3inv:${runId}:row${doc.rowIndex}:issue`,
          invoiceId,
          autoEmailOverride: false,
        });
        if (!issued.ok) throw new DocStepError('issue', issued.error.code);
        mintedBillNo = issued.value.billDocumentNumberRaw;

        // 3. Target status.
        if (doc.targetStatus === 'paid') {
          mintedReceiptNo = await payDoc(mods, deps, ctx, actorUserId, runId, doc, invoiceId);
        } else if (doc.targetStatus === 'void') {
          await voidDoc(mods, deps, ctx, actorUserId, runId, doc, invoiceId);
        }

        // 4. Renewal cycle.
        await ensureCycle(invoiceId, plan.coverage.fromIso, plan.coverage.toIso);

        return { ...base, action: 'imported', errorCode: null, mintedBillNo, mintedReceiptNo, cycle };
      }
    }
  } catch (e) {
    const code =
      e instanceof DocStepError ? e.message : `exception:${e instanceof Error ? e.name : 'unknown'}`;
    // Full message to the operator terminal only (never into the report).
    console.error(
      `[import-round3-invoices] row ${doc.rowIndex} FAILED: ` +
        (e instanceof Error ? e.message : String(e)),
    );
    return { ...base, action: 'error', errorCode: code, mintedBillNo, mintedReceiptNo, cycle };
  }
}

/**
 * Run the Round-3 invoice import. Dry-run (`commit:false`) performs tenant-
 * scoped READS only (member/invoice resolution) and reports the full per-doc
 * plan; `commit:true` executes. Docs are processed in ascending Inv Date order
 * (rowIndex tiebreak) so SC numbers run chronologically per fiscal year.
 * (RC receipt numbers follow the SAME doc order keyed on FY(paymentDate) —
 * within one FY they can be minted slightly out of payment-date order when the
 * sheet's payment dates are not monotonic in Inv Date; the mapping report
 * preserves the linkage.)
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

  const pairs: DocReportPair[] = [];

  if (!input.commit) {
    for (const doc of sorted) {
      const plan = planDoc(doc, planCtx, input.resolvePlanId, todayBangkok);
      const member = plan.kind === 'error' ? null : plan.member;
      pairs.push({
        doc,
        outcome: {
          action: plan.kind === 'error' ? 'error' : 'planned',
          errorCode: plan.kind === 'error' ? plan.code : null,
          mintedBillNo: null,
          mintedReceiptNo: null,
          memberNumber: member?.memberNumber ?? null,
          memberActive: member?.active ?? null,
          cycle: 'none',
          plannedSteps: plannedStepsFor(doc, plan),
        },
      });
    }
  } else {
    if (input.actorUserId === null) {
      throw new Error('runInvoiceImport: actorUserId is required in commit mode');
    }
    const deps = buildDeps(mods, input.ctx.slug, input.overrides);
    const cycleRt = buildCycleRuntime(mods, input.ctx.slug);
    for (const doc of sorted) {
      const plan = planDoc(doc, planCtx, input.resolvePlanId, todayBangkok);
      // Progress breadcrumb (PII-free) — the prod run is ~125 sequential docs
      // with a real PDF render each; the operator needs to see it moving.
      console.log(
        `[import-round3-invoices] row ${doc.rowIndex} (${doc.issueDate} · ${doc.targetStatus}) → ${plan.kind}`,
      );
      const outcome = await importDoc(
        mods,
        deps,
        cycleRt,
        input.ctx,
        input.actorUserId,
        runId,
        doc,
        plan,
      );
      pairs.push({ doc, outcome });
    }
  }

  const report = buildInvoiceImportReport({
    mode: input.commit ? 'commit' : 'dry-run',
    generatedAt: nowIso,
    runId,
    todayBangkok,
    pairs,
  });
  return { report, pairs };
}
