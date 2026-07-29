/**
 * Round-3 member importer CLI (docs/import/ROUND3_PLAN.md, 2026-07-29).
 *
 *   # dry-run (safe, default — validate + report, ZERO writes; .env.local is
 *   # auto-filled below, so a fresh shell works)
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json TENANT_SLUG=swecham pnpm tsx \
 *       scripts/import-round3-members.ts --file "./docs/import/Round 3/….xlsx"
 *
 *   # real import (only after a clean dry-run + the wipe + 2024-plan seed).
 *   # PROD: use --env-file so DATABASE_URL points at prod BEFORE this file
 *   # loads (run-scripts runbook; the .env.local fill-in never overrides it).
 *   TSX_TSCONFIG_PATH=tsconfig.scripts.json TENANT_SLUG=swecham \
 *       BOOTSTRAP_ADMIN_EMAIL=<admin email> \
 *       node --env-file=.env.production --import tsx \
 *       scripts/import-round3-members.ts --file "./docs/import/Round 3/….xlsx" --commit
 *
 * BOOTSTRAP_ADMIN_EMAIL is REQUIRED for --commit on a freshly-wiped tenant:
 * `findActorUserId` otherwise resolves the actor via an admin user linked from
 * a tenant CONTACT — and the wipe removed every contact link, so the lookup
 * fails. The env var pins the actor by exact email instead.
 *
 * TSX_TSCONFIG_PATH is REQUIRED in both modes: the tier resolver (plan-repo →
 * members barrel) and commitMembers (renewals barrel) both transitively reach
 * the Next-vendored `server-only` marker, which does not exist in node_modules
 * under plain tsx; tsconfig.scripts.json aliases it to
 * scripts/lib/server-only-stub.ts. Forgetting it fails LOUD with this exact
 * remediation (never a silent partial run).
 *
 * Env loading (R3-6 — parity with import-round3-invoices.ts): `.env.local` is
 * filled in below (never overriding vars already in the environment). Every
 * env-reaching module (`./seed-demo-members` → '@/lib/db' → src/lib/env.ts,
 * plan-repo, commitMembers) is imported LAZILY inside main() — under tsx a
 * statement between static imports does NOT run before later static imports,
 * so a static env-reaching import would validate an EMPTY environment.
 *
 * Reads the 'Finalized Member' sheet (1 row = 1 historical invoice) via the
 * fixed-index reader, collapses it to one RawRow per company (latest row wins),
 * validates through the existing Stage-3 pipeline, and commits via
 * `commitMembers` with Round-3 options: NO renewal cycles (the Part-2 invoice
 * importer creates them anchored at invoice coverage) and a PER-MEMBER plan
 * year = calendar year of the member's anchor Inv Date (needs the 2024 plan
 * catalogue seeded alongside 2025/2026).
 *
 * PII: the workbook is gitignored + runs only on the operator's machine. The
 * written report is PII-free (counts + row indices only — spec § 7); the
 * Round-3 additions carry rule/series/status COUNTS and rowIndex refs only.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Fill in any vars the operator's shell / --env-file did not already supply
// (loadEnvFile never overrides existing vars). Static imports in THIS file are
// env-free by design — everything env-reaching is imported lazily in main().
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

import type { TenantContext } from '@/modules/tenants';
import { asPlanYear } from '@/modules/plans/domain/plan';
import { buildTierResolver, type PlanLite } from './import-members/tier-resolution';
import { validateRows, type ValidatedMember } from './import-members/validate';
// NOTE: `requireSwechamTenant`/`findActorUserId` (seed-demo-members → '@/lib/db'
// → src/lib/env.ts), `planRepo` and `commitMembers` are ALL imported LAZILY
// (inside main() / loadTierResolver / the --commit branch), for two reasons:
//   1. env: they must not evaluate before the .env.local fill-in above (tsx
//      hoists static imports past it — R3-6);
//   2. server-only: both graphs reach the Next-vendored `server-only` marker
//      under plain tsx (plan-repo → members barrel → renewals → invoicing →
//      payments; import-members → renewals barrel → same) — a static import
//      would crash at load time with a bare MODULE_NOT_FOUND. The dynamic
//      imports let us catch that and print the TSX_TSCONFIG_PATH remediation
//      (tsconfig.scripts.json aliases server-only to scripts/lib/server-only-stub.ts).
import {
  buildReportDocument,
  renderReportText,
  type CommitOutcome,
  type ReportDocument,
} from './import-members/report';
import {
  readFinalizedMemberWorkbook,
  normCompanyKeyForValidate,
  type FinalizedMemberWorkbook,
  type Round3Issue,
} from './import-round3/finalized-sheet';

/** The tier catalogue names are identical across plan years — resolve against
 *  2026 (the fully-seeded year); the per-member INSERT still uses its own year. */
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
      'usage: import-round3-members.ts --file <xlsx> [--commit] [--report-dir <dir>]',
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

/** Mirrors import-members.ts loadTierResolver (module-private there). */
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

/** PII-free Round-3 report section — counts, histograms, rowIndex refs only. */
interface Round3ReportSection {
  readonly planYearHistogram: Readonly<Record<string, number>>;
  readonly countryDefaultsByRule: Readonly<Record<string, number>>;
  readonly synthesizedEmailCount: number;
  readonly invoiceSelection: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly bySeries: Readonly<Record<string, Readonly<Record<string, number>>>>;
  };
  readonly sheetWarnings: readonly Round3Issue[];
  readonly sheetErrors: readonly Round3Issue[];
}

export function buildRound3Section(parsed: FinalizedMemberWorkbook): Round3ReportSection {
  const planYearHistogram: Record<string, number> = {};
  for (const y of parsed.planYearByCompanyKey.values()) {
    planYearHistogram[String(y)] = (planYearHistogram[String(y)] ?? 0) + 1;
  }
  const countryDefaultsByRule: Record<string, number> = {};
  for (const d of parsed.countryDefaults) {
    countryDefaultsByRule[d.rule] = (countryDefaultsByRule[d.rule] ?? 0) + 1;
  }
  const byStatus: Record<string, number> = {};
  const bySeries: Record<string, Record<string, number>> = {};
  for (const doc of parsed.invoices) {
    byStatus[doc.targetStatus] = (byStatus[doc.targetStatus] ?? 0) + 1;
    const s = (bySeries[doc.series] ??= {});
    s[doc.targetStatus] = (s[doc.targetStatus] ?? 0) + 1;
  }
  return {
    planYearHistogram,
    countryDefaultsByRule,
    // Every Round-3 contact email is synthesized (the sheet has none).
    synthesizedEmailCount: parsed.memberRows.length,
    invoiceSelection: { total: parsed.invoices.length, byStatus, bySeries },
    sheetWarnings: parsed.warnings,
    sheetErrors: parsed.errors,
  };
}

function renderRound3Text(r3: Round3ReportSection): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('— Round-3 additions —');
  lines.push('Member anchor plan-year histogram:');
  for (const [y, n] of Object.entries(r3.planYearHistogram).sort()) lines.push(`  ${y}: ${n}`);
  lines.push('Country defaults applied (by rule):');
  for (const [rule, n] of Object.entries(r3.countryDefaultsByRule).sort()) lines.push(`  ${rule}: ${n}`);
  lines.push(`Synthesized mockup emails: ${r3.synthesizedEmailCount}`);
  lines.push(`Invoice selection (for Part 2): ${r3.invoiceSelection.total} docs`);
  for (const [status, n] of Object.entries(r3.invoiceSelection.byStatus).sort()) {
    lines.push(`  ${status}: ${n}`);
  }
  for (const [series, statuses] of Object.entries(r3.invoiceSelection.bySeries).sort()) {
    const parts = Object.entries(statuses)
      .sort()
      .map(([st, n]) => `${st} ${n}`)
      .join(' · ');
    lines.push(`  series ${series}: ${parts}`);
  }
  if (r3.sheetErrors.length > 0) {
    lines.push('Sheet ERRORS (rowIndex · field · code):');
    for (const e of r3.sheetErrors) lines.push(`  row ${e.rowIndex} · ${e.field} · ${e.code}`);
  }
  if (r3.sheetWarnings.length > 0) {
    lines.push('Sheet warnings (rowIndex · field · code):');
    for (const w of r3.sheetWarnings) lines.push(`  row ${w.rowIndex} · ${w.field} · ${w.code}`);
  }
  return lines.join('\n');
}

type Round3ReportDocument = ReportDocument & { readonly round3: Round3ReportSection };

function writeRound3ReportFile(doc: Round3ReportDocument, dir: string): string {
  const safeTs = doc.generatedAt.replace(/[:.]/g, '-');
  const path = join(dir, `round3-member-import-report-${doc.mode}-${safeTs}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
  return path;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Lazy — reaches '@/lib/db' → src/lib/env.ts (validated AFTER the
  // .env.local fill-in above). Mirrors import-round3-invoices.ts.
  const { requireSwechamTenant, findActorUserId } = await import('./seed-demo-members').catch(
    rethrowWithServerOnlyHint,
  );
  const ctx = requireSwechamTenant();

  const parsed = readFinalizedMemberWorkbook(args.file);
  const tierResolver = await loadTierResolver(ctx, TIER_CATALOGUE_YEAR);
  const report = validateRows(parsed.memberRows, tierResolver);

  // Per-member plan year = calendar year of the member's anchor Inv Date,
  // joined via the SAME company-name normalization validateRows groups by.
  const planYearOf = (m: ValidatedMember): number => {
    const y = parsed.planYearByCompanyKey.get(normCompanyKeyForValidate(m.companyName));
    if (y === undefined) {
      // Impossible for a validated member (its registrationDate parsed, so the
      // reader recorded its year) — fail loud rather than committing a wrong FK.
      throw new Error(
        `[import-round3] no anchor plan-year for member at rows ${m.rowIndices.join(', ')}`,
      );
    }
    return y;
  };

  const totalErrors = report.stats.errorCount + parsed.errors.length;
  let committed: CommitOutcome | null = null;
  const willCommit = args.commit && totalErrors === 0;

  if (args.commit && totalErrors > 0) {
    console.error(
      `[import-round3] REFUSING --commit: ${report.stats.errorCount} validation error(s) + ` +
        `${parsed.errors.length} sheet error(s). Fix them (see report) and re-run a clean dry-run first.`,
    );
  }
  if (willCommit) {
    const actorUserId = await findActorUserId(ctx);
    const { commitMembers } = await import('./import-members').catch(
      rethrowWithServerOnlyHint,
    );
    committed = await commitMembers(ctx, actorUserId, report.members, TIER_CATALOGUE_YEAR, {
      createCycles: false, // Part 2 creates cycles anchored at invoice coverage
      planYearOf,
    });
  }

  const baseDoc = buildReportDocument({
    report,
    mode: willCommit ? 'commit' : 'dry-run',
    planYear: TIER_CATALOGUE_YEAR,
    generatedAt: new Date().toISOString(),
    committed,
  });
  const round3 = buildRound3Section(parsed);
  const doc: Round3ReportDocument = { ...baseDoc, round3 };
  const reportPath = writeRound3ReportFile(doc, args.reportDir);
  console.log(renderReportText(baseDoc));
  console.log(renderRound3Text(round3));
  console.log(`\n[import-round3] report written: ${reportPath}`);

  process.exit(totalErrors > 0 ? 1 : 0);
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('import-round3-members.ts')) {
  main().catch((e: unknown) => {
    console.error('[import-round3] crashed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
