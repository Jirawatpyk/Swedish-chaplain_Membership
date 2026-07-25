/**
 * membership-coverage-exclude-guard (mig 0281) — assisted backfill of
 * `invoices.coverage_from/to` for membership §86/4 documents ISSUED BEFORE the
 * migration. Those rows carry NULL coverage, so they do not yet participate in
 * the duplicate-coverage EXCLUDE constraint / pre-flight guard.
 *
 * ── WHY THIS IS OPERATOR-CURATED, NOT AUTO-DERIVED ─────────────────────────
 *   A membership bill's TRUE charged window is NOT reliably recoverable from
 *   its linked renewal cycle alone. `confirm-renewal.ts` (see its lines around
 *   the `coverageWindow` block) links the issued bill to the COMPLETING cycle
 *   `C` via `linked_invoice_id`, yet the bill covers the NEXT term
 *   `[C.periodTo, C.periodTo + term)` — NOT `C`'s own `[periodFrom, periodTo)`.
 *   A comeback (`admin-renew-lapsed-member`) or an initial bill instead covers
 *   its linked cycle's OWN `[periodFrom, periodTo)`. The discriminator is the
 *   MINT PATH, which was never stored — which is exactly why the fix persists
 *   coverage as columns instead of deriving it. Auto-guessing the window on a
 *   PAID tax document is unsafe: a wrong stamp could make the EXCLUDE
 *   false-block the member's real next renewal. So this script only INVENTORIES
 *   the gap and prints both candidate windows; a human reviews and authors a
 *   CSV, and `--apply` stamps exactly what the CSV says. Same safety model as
 *   `backfill-cycle-anchors.ts`.
 *
 *   The go-forward fix already protects every NEW bill; this backfill is
 *   defence-in-depth for the historical cohort, to be run deliberately.
 *
 * ── MODES ──────────────────────────────────────────────────────────────────
 *   (default) INVENTORY — read-only. Lists every committed
 *     (issued/paid/partially_credited) membership bill with NULL coverage, its
 *     linked cycle facts, and BOTH candidate windows; emits a CSV template
 *     (renewal candidate pre-filled) to stdout for the operator to review.
 *     Orphans (no linked cycle → window unrecoverable) are reported, never
 *     stamped.
 *
 *   --apply=<csv> --confirm  READ the operator-reviewed CSV
 *     (`invoice_id,coverage_from,coverage_to`, ISO-8601 UTC, `#`/blank lines
 *     skipped) and stamp each row in its OWN `runInTenant` tx (RLS on). The
 *     UPDATE is guarded `coverage_from IS NULL` so re-runs are idempotent. A
 *     23P01 (a PRE-EXISTING overlapping pair — a double-bill from the no-guard
 *     era) is caught, reported for HUMAN resolution, and skipped. Add
 *     `--confirm-prod` when the target is production (`.env.production`).
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   # 1. Inventory the gap on the dev branch, capture the CSV template:
 *   TENANT_SLUG=swecham node --env-file=.env.local --import tsx \
 *     scripts/backfill-membership-coverage.ts > coverage-review.csv
 *
 *   # 2. Review + correct coverage-review.csv by hand (comeback/initial rows
 *   #    → their own [periodFrom, periodTo); delete rows you cannot verify).
 *
 *   # 3. Apply against production after review:
 *   TENANT_SLUG=swecham node --env-file=.env.production --import tsx \
 *     scripts/backfill-membership-coverage.ts \
 *     --apply=coverage-review.csv --confirm --confirm-prod
 *
 * Exit codes: 0 = inventory printed / apply executed; 1 = validation error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, isNull } from 'drizzle-orm';

// Load `.env.local` BEFORE importing `@/lib/db` so the db singleton binds to
// the intended branch. `--env-file` on the node CLI covers the explicit runs
// above; this fallback keeps an env-less invocation from silently hitting the
// wrong DB. (Same guard shape as backfill-cycle-anchors.ts.)
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

import { runInTenant } from '@/lib/db';
import { asTenantContext, TENANT_SLUG_PATTERN } from '@/modules/tenants';
import { addMonthsUtc } from '@/lib/dates';
// Deep imports (not module barrels): the invoicing barrel transitively pulls
// `server-only` (payments) which breaks tsx scripts — see
// reference_066_barrel_cycle_breaks_tsx_scripts.
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';

/** Committed statuses that `blocks_coverage` (mig 0281) acts on. */
const BLOCKING_STATUSES = ['issued', 'paid', 'partially_credited'] as const;

type Flags = {
  readonly applyCsv: string | null;
  readonly confirm: boolean;
  readonly confirmProd: boolean;
};

function parseArgs(argv: readonly string[]): Flags {
  let applyCsv: string | null = null;
  let confirm = false;
  let confirmProd = false;
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--apply=')) applyCsv = arg.slice('--apply='.length);
    else if (arg === '--confirm') confirm = true;
    else if (arg === '--confirm-prod') confirmProd = true;
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    console.error(`backfill-membership-coverage: unknown args: ${unknown.join(', ')}`);
    process.exit(1);
  }
  return { applyCsv, confirm, confirmProd };
}

function resolveTenantSlug(): string {
  const slug = process.env.TENANT_SLUG ?? '';
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    console.error(
      'backfill-membership-coverage: TENANT_SLUG is required and must match ' +
        `${TENANT_SLUG_PATTERN} (single-tenant deployment scope). Example:\n` +
        '  TENANT_SLUG=swecham node --env-file=.env.local --import tsx ' +
        'scripts/backfill-membership-coverage.ts',
    );
    process.exit(1);
  }
  return slug;
}

type BillRow = {
  readonly invoiceId: string;
  readonly status: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly termMonths: number | null;
  readonly anchoredAt: string | null;
};

/** One RLS-scoped read pass: committed membership bills lacking coverage.
 *  Raw drizzle timestamptz columns come back as `Date`; we normalise to ISO
 *  at this single boundary so the rest of the script works in ISO strings. */
async function loadGap(slug: string): Promise<readonly BillRow[]> {
  const ctx = asTenantContext(slug);
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        invoiceId: invoices.invoiceId,
        status: invoices.status,
        periodFrom: renewalCycles.periodFrom,
        periodTo: renewalCycles.periodTo,
        termMonths: renewalCycles.frozenPlanTermMonths,
        anchoredAt: renewalCycles.anchoredAt,
      })
      .from(invoices)
      .leftJoin(
        renewalCycles,
        and(
          eq(renewalCycles.tenantId, invoices.tenantId),
          eq(renewalCycles.linkedInvoiceId, invoices.invoiceId),
        ),
      )
      .where(
        and(
          eq(invoices.tenantId, slug),
          eq(invoices.invoiceSubject, 'membership'),
          isNull(invoices.coverageFrom),
          inArray(invoices.status, [...BLOCKING_STATUSES]),
        ),
      )
      .orderBy(invoices.createdAt);
    return rows.map((r) => ({
      invoiceId: r.invoiceId,
      status: r.status,
      periodFrom: r.periodFrom?.toISOString() ?? null,
      periodTo: r.periodTo?.toISOString() ?? null,
      termMonths: r.termMonths,
      anchoredAt: r.anchoredAt?.toISOString() ?? null,
    }));
  });
}

function inventory(rows: readonly BillRow[]): void {
  const linked = rows.filter((r) => r.periodFrom !== null && r.periodTo !== null && r.termMonths !== null);
  const orphans = rows.filter((r) => !linked.includes(r));

  console.error(`# membership-coverage inventory: ${rows.length} committed bills with NULL coverage`);
  console.error(`#   ${linked.length} linked to a renewal cycle · ${orphans.length} orphan (window unrecoverable)`);
  console.error('#');
  console.error('# Per bill — verify which candidate the mint used, then keep ONE window below:');
  for (const r of linked) {
    const from = r.periodFrom as string;
    const to = r.periodTo as string;
    const renewalTo = addMonthsUtc(to, r.termMonths as number);
    console.error(
      `#   ${r.invoiceId}  ${r.status.padEnd(18)} ${r.anchoredAt ? 'anchored' : 'plain   '}\n` +
        `#       renewal (confirm/auto-draft) → [${to} .. ${renewalTo})\n` +
        `#       own-term (comeback/initial)  → [${from} .. ${to})`,
    );
  }
  for (const r of orphans) {
    console.error(`#   ORPHAN ${r.invoiceId}  ${r.status} — no linked cycle; stamp manually or leave NULL`);
  }
  console.error('#');
  console.error('# CSV template below (renewal candidate pre-filled — CORRECT comeback/initial rows by hand):');
  console.error('invoice_id,coverage_from,coverage_to');
  for (const r of linked) {
    const to = r.periodTo as string;
    const renewalTo = addMonthsUtc(to, r.termMonths as number);
    console.log(`${r.invoiceId},${to},${renewalTo}`);
  }
}

type CsvRow = { readonly invoiceId: string; readonly from: string; readonly to: string };

function parseCsv(path: string): readonly CsvRow[] {
  if (!existsSync(path)) {
    console.error(`backfill-membership-coverage: CSV not found: ${path}`);
    process.exit(1);
  }
  const out: CsvRow[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('invoice_id,')) continue; // header
    const [invoiceId, from, to] = line.split(',').map((c) => c.trim());
    if (!invoiceId || !from || !to) {
      console.error(`backfill-membership-coverage: malformed CSV line ${i + 1}: "${raw}"`);
      process.exit(1);
    }
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
      console.error(`backfill-membership-coverage: CSV line ${i + 1} needs from < to (ISO-8601): "${raw}"`);
      process.exit(1);
    }
    out.push({ invoiceId, from, to });
  }
  return out;
}

async function apply(slug: string, rows: readonly CsvRow[]): Promise<void> {
  const ctx = asTenantContext(slug);
  let stamped = 0;
  let already = 0;
  const overlaps: string[] = [];
  console.error(`backfill-membership-coverage: applying ${rows.length} rows (idempotent; coverage_from IS NULL guard)…`);
  for (const r of rows) {
    try {
      const updated = await runInTenant(ctx, async (tx) =>
        tx
          .update(invoices)
          .set({ coverageFrom: new Date(r.from), coverageTo: new Date(r.to) })
          .where(
            and(
              eq(invoices.tenantId, slug),
              eq(invoices.invoiceId, r.invoiceId),
              isNull(invoices.coverageFrom),
            ),
          )
          .returning({ id: invoices.invoiceId }),
      );
      if (updated.length > 0) {
        stamped += 1;
        console.error(`  ✓ ${r.invoiceId}  [${r.from} .. ${r.to})`);
      } else {
        already += 1;
        console.error(`  · ${r.invoiceId}  already stamped or not found — skipped`);
      }
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === '23P01') {
        overlaps.push(r.invoiceId);
        console.error(`  ⚠ OVERLAP (23P01) ${r.invoiceId} — pre-existing double-bill; needs human resolution`);
      } else {
        throw e;
      }
    }
  }
  console.error(`\nbackfill summary: stamped ${stamped}, skipped ${already}, overlap ${overlaps.length}`);
  if (overlaps.length > 0) console.error(`  OVERLAPS NEEDING RESOLUTION: ${overlaps.join(', ')}`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const slug = resolveTenantSlug();

  if (flags.applyCsv === null) {
    inventory(await loadGap(slug));
    return;
  }

  // Write path — require explicit confirmation.
  if (!flags.confirm) {
    console.error('backfill-membership-coverage: --apply requires --confirm (writes to invoices). Aborting.');
    process.exit(1);
  }
  const usingProdEnv = (process.env.DATABASE_URL ?? '').length > 0 && !existsSync('.env.local');
  if (usingProdEnv && !flags.confirmProd) {
    console.error('backfill-membership-coverage: production target detected — add --confirm-prod to proceed.');
    process.exit(1);
  }
  await apply(slug, parseCsv(flags.applyCsv));
}

const runAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('backfill-membership-coverage.ts') ||
    process.argv[1].endsWith('backfill-membership-coverage.js'));

if (runAsScript) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('backfill-membership-coverage: crashed:', e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exit(1);
    });
}
