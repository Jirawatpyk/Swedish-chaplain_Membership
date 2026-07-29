/**
 * Round-3 invoice+receipt importer CLI (Part 2 of the Round-3 import —
 * docs/import/ROUND3_PLAN.md § Invoice import, operator-approved 2026-07-29).
 * Runs AFTER the Part-1 member import (`scripts/import-round3-members.ts`).
 *
 *   # dry-run (safe default — reads members/plans, prints the per-doc plan +
 *   # validation + operator-attention lists, ZERO writes)
 *   TENANT_SLUG=swecham TSX_TSCONFIG_PATH=tsconfig.scripts.json pnpm tsx \
 *       scripts/import-round3-invoices.ts --file "./docs/import/Round 3/….xlsx"
 *
 *   # real import (only after a clean dry-run; prod per the ROUND3_PLAN window)
 *   TENANT_SLUG=swecham TSX_TSCONFIG_PATH=tsconfig.scripts.json \
 *       BOOTSTRAP_ADMIN_EMAIL=admin@… pnpm tsx \
 *       scripts/import-round3-invoices.ts --file "./docs/import/Round 3/….xlsx" --commit
 *
 * REQUIREMENTS
 *   - `TSX_TSCONFIG_PATH=tsconfig.scripts.json` is REQUIRED in both modes: the
 *     import graph (invoicing use-cases + deps factories + the renewals barrel
 *     → payments infrastructure) reaches the Next-vendored `server-only`
 *     marker, which does not exist in node_modules under plain tsx;
 *     tsconfig.scripts.json aliases it to scripts/lib/server-only-stub.ts.
 *     Forgetting it fails LOUD with this exact remediation.
 *   - Run from the REPO ROOT: the PDF renderer registers Sarabun from
 *     `process.cwd()/public/fonts/sarabun` at module init.
 *   - `BLOB_READ_WRITE_TOKEN` must point at the TARGET env's live Blob store —
 *     every issue/payment/void renders + uploads a real PDF inside its tx.
 *   - Env loading: `.env.local` is auto-filled below (never overriding vars
 *     already in the environment); for prod use
 *     `node --env-file=.env.production --import tsx …` per the run-scripts
 *     runbook so DATABASE_URL points at prod BEFORE this file loads.
 *
 * FLAG PINNING (deterministic regardless of env)
 *   - The receipt render is forced SYNCHRONOUS and the 088 tax-at-payment flow
 *     forced ON via DEPS-SPREAD OVERRIDES inside the core
 *     (`asyncReceiptPdf: false`, `taxAtPayment: 'on'` — the operative
 *     mechanism; see invoice-import-core.ts § Flag pinning).
 *   - `FEATURE_F5_ASYNC_RECEIPT_PDF=false` is ALSO pinned into process.env as
 *     the very first statement (defence-in-depth): it runs before any
 *     env-reaching import, and `process.loadEnvFile` never overrides an
 *     already-set var, so a stray `true` in the env file cannot re-enable the
 *     async path for this process.
 *
 * PII: the workbook is gitignored + runs only on the operator's machine. The
 * written report + console output are PII-free (rowIndex + document numbers +
 * member numbers + dates + machine codes only — spec § 7); original TSCC
 * MB/RC numbers appear in the mapping table per operator decision #2.
 */
// MUST be the first statement — before any import that touches src/lib/env.ts
// (static imports in THIS file are env-free by design; everything env-reaching
// is imported lazily below).
process.env.FEATURE_F5_ASYNC_RECEIPT_PDF = 'false';

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Fill in any vars the operator's shell / --env-file did not already supply
// (loadEnvFile never overrides existing vars — the pin above always wins).
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

import type { TenantContext } from '@/modules/tenants';
import { asPlanYear } from '@/modules/plans/domain/plan';
import { buildTierResolver, type PlanLite } from './import-members/tier-resolution';
import {
  readFinalizedMemberWorkbook,
  type Round3InvoiceDoc,
  type Round3Issue,
} from './import-round3/finalized-sheet';
import { thbToSatang } from './import-round3/money';
import {
  renderInvoiceImportText,
  runInvoiceImport,
  type DocReportPair,
  type InvoiceImportReportDoc,
} from './import-round3/invoice-import-core';

/** Tier catalogue names are identical across plan years — resolve against 2026
 *  (fully seeded); each doc's INSERT still uses its own `planYear`. */
const TIER_CATALOGUE_YEAR = 2026;

interface Args {
  readonly file: string;
  readonly commit: boolean;
  readonly reportDir: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const file = get('--file');
  if (!file) {
    throw new Error(
      'usage: import-round3-invoices.ts --file <xlsx> [--commit] [--report-dir <dir>]',
    );
  }
  return {
    file,
    commit: argv.includes('--commit'),
    reportDir: get('--report-dir') ?? process.cwd(),
  };
}

/** Rethrow a dynamic-import failure with the tsx remediation when the cause is
 *  the Next-vendored `server-only` marker (absent from node_modules). */
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

/** Mirrors import-round3-members.ts loadTierResolver (lazy planRepo import). */
async function loadTierResolver(ctx: TenantContext, planYear: number) {
  const { planRepo } = await import('@/modules/plans/infrastructure/db/plan-repo').catch(
    rethrowWithServerOnlyHint,
  );
  const plans = await planRepo.findByTenantAndYear(ctx, {
    year: asPlanYear(planYear),
    showDeleted: false,
  });
  if (plans.length === 0) {
    throw new Error(
      `no seeded plans for ${ctx.slug} year ${planYear} — run scripts/seed-swecham-2026-plans.ts first.`,
    );
  }
  const lite: PlanLite[] = plans.map((p) => ({
    planId: p.plan_id,
    nameEn: p.plan_name.en,
    memberTypeScope: p.member_type_scope,
  }));
  return buildTierResolver(lite);
}

// --- Catalogue-price cross-check (review finding R3-7) -----------------------

interface CataloguePriceMismatch {
  readonly rowIndex: number;
  readonly planYear: number;
}

interface CataloguePriceSection {
  readonly count: number;
  readonly rows: readonly CataloguePriceMismatch[];
}

/**
 * Compare each doc's sheet Amount (satang) against the seeded catalogue's
 * `annual_fee_minor_units` for (resolved planId, doc.planYear). A mismatch is
 * NOT an error — historical prices legitimately differ — but the operator must
 * know: the NEXT renewal bills at the catalogue price, not the imported one.
 * Plan-years with no seeded catalogue are skipped (commit would refuse on the
 * FK anyway); unresolved tiers are skipped (already a per-doc plan error).
 */
async function findCataloguePriceMismatches(
  ctx: TenantContext,
  docs: readonly Round3InvoiceDoc[],
  resolvePlanId: (planTier: string) => string | null,
): Promise<CataloguePriceSection> {
  const { planRepo } = await import('@/modules/plans/infrastructure/db/plan-repo').catch(
    rethrowWithServerOnlyHint,
  );
  const years = [...new Set(docs.map((d) => d.planYear))].sort();
  const feeByYearAndPlanId = new Map<number, ReadonlyMap<string, number>>();
  for (const year of years) {
    const plans = await planRepo.findByTenantAndYear(ctx, {
      year: asPlanYear(year),
      showDeleted: false,
    });
    feeByYearAndPlanId.set(
      year,
      new Map(plans.map((p) => [p.plan_id, p.annual_fee_minor_units])),
    );
  }
  const rows: CataloguePriceMismatch[] = [];
  for (const doc of docs) {
    const planId = resolvePlanId(doc.planTier);
    if (planId === null) continue;
    const fee = feeByYearAndPlanId.get(doc.planYear)?.get(planId);
    if (fee === undefined) continue;
    if (thbToSatang(doc.amountThb) !== BigInt(fee)) {
      rows.push({ rowIndex: doc.rowIndex, planYear: doc.planYear });
    }
  }
  rows.sort((a, b) => a.rowIndex - b.rowIndex);
  return { count: rows.length, rows };
}

function renderCataloguePriceMismatches(section: CataloguePriceSection): string {
  if (section.count === 0) return '';
  const lines: string[] = [];
  lines.push(
    `OPERATOR — ${section.count} doc(s) whose historical price differs from the ` +
      `catalogue — next renewal bills at catalogue price (row · planYear):`,
  );
  for (const r of section.rows) lines.push(`  ${r.rowIndex} · ${r.planYear}`);
  return lines.join('\n');
}

/** Dry-run detail: PII-free per-doc plan lines (rowIndex + steps + member#). */
function renderPlannedSteps(pairs: readonly DocReportPair[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Per-doc plan (row · target · member# · steps):');
  for (const { doc, outcome } of pairs) {
    const member =
      outcome.memberNumber !== null
        ? `#${outcome.memberNumber}${outcome.memberActive === false ? ' (inactive)' : ''}`
        : '-';
    const steps =
      outcome.action === 'error'
        ? `ERROR ${outcome.errorCode ?? 'unknown'}`
        : (outcome.plannedSteps ?? []).join(' → ');
    lines.push(`  ${doc.rowIndex} · ${doc.targetStatus} · ${member} · ${steps}`);
  }
  return lines.join('\n');
}

/** Written JSON = core report + CLI-level extras (catalogue cross-check +
 *  sheet warnings, e.g. `operator_money_correction` — must show in EVERY report). */
type WrittenReportDoc = InvoiceImportReportDoc & {
  readonly cataloguePriceMismatches: CataloguePriceSection;
  readonly sheetWarnings: readonly Round3Issue[];
};

function writeReportFile(report: WrittenReportDoc, dir: string): string {
  const safeTs = report.generatedAt.replace(/[:.]/g, '-');
  const path = join(dir, `round3-invoice-import-report-${report.mode}-${safeTs}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Lazy — reaches '@/lib/db' → src/lib/env.ts (validated AFTER the env
  // pin + .env.local fill-in above).
  const { requireSwechamTenant, findActorUserId } = await import('./seed-demo-members').catch(
    rethrowWithServerOnlyHint,
  );
  const ctx = requireSwechamTenant();

  const parsed = readFinalizedMemberWorkbook(args.file);
  if (parsed.errors.length > 0) {
    console.error(`[import-round3-invoices] sheet ERRORS (rowIndex · field · code):`);
    for (const e of parsed.errors) console.error(`  ${e.rowIndex} · ${e.field} · ${e.code}`);
  }
  if (parsed.warnings.length > 0) {
    // Includes every applied operator_money_correction — visible in EVERY run.
    console.log(`[import-round3-invoices] sheet warnings (rowIndex · field · code):`);
    for (const w of parsed.warnings) console.log(`  ${w.rowIndex} · ${w.field} · ${w.code}`);
  }

  const tierResolver = await loadTierResolver(ctx, TIER_CATALOGUE_YEAR);
  const resolvePlanId = (label: string): string | null => {
    const r = tierResolver.resolve(label);
    return r.ok ? r.value.planId : null;
  };

  // Two-stage commit gate:
  //   1. Part-1 discipline — any sheet-STRUCTURAL error blocks --commit here.
  //   2. Core pre-flight (R3-3) — the core plans EVERY doc first and refuses
  //      (zero writes, `commitRefused`) when any doc fails planning
  //      (member_not_found, plan_tier_unresolved, date guard, …), because
  //      executing around holes would mint SC/RC numbers whose gaps get
  //      filled out-of-chronology on the fix-up re-run.
  const commitAllowed = args.commit && parsed.errors.length === 0;
  if (args.commit && !commitAllowed) {
    console.error(
      `[import-round3-invoices] REFUSING --commit: ${parsed.errors.length} sheet error(s). ` +
        `Fix the sheet (see above) and re-run a clean dry-run first.`,
    );
  }
  const actorUserId = commitAllowed ? await findActorUserId(ctx) : null;

  const { report, pairs, commitRefused } = await runInvoiceImport({
    ctx,
    docs: parsed.invoices,
    resolvePlanId,
    commit: commitAllowed,
    actorUserId,
  });
  if (commitRefused) {
    console.error(
      `[import-round3-invoices] --commit REFUSED by the pre-flight gate (see plan ` +
        `errors above) — ZERO writes were performed; the output below is the plan.`,
    );
  }

  // R3-7 — historical price vs catalogue cross-check (warning, never blocking).
  const priceMismatches = await findCataloguePriceMismatches(
    ctx,
    parsed.invoices,
    resolvePlanId,
  );

  if (!commitAllowed || commitRefused) console.log(renderPlannedSteps(pairs));
  console.log(renderInvoiceImportText(report));
  const priceText = renderCataloguePriceMismatches(priceMismatches);
  if (priceText.length > 0) console.log(priceText);
  const reportPath = writeReportFile(
    { ...report, cataloguePriceMismatches: priceMismatches, sheetWarnings: parsed.warnings },
    args.reportDir,
  );
  console.log(`\n[import-round3-invoices] report written: ${reportPath}`);

  const totalErrors = parsed.errors.length + report.totals.errors;
  process.exit(totalErrors > 0 || commitRefused ? 1 : 0);
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('import-round3-invoices.ts')) {
  main().catch((e: unknown) => {
    console.error(
      '[import-round3-invoices] crashed:',
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}
