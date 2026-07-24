/**
 * Backfill renewal-cycle anchors from TSCC's historical payment dates
 * (renewal-rolling-anchor R4 — plan Task 12; spec 2026-07-08 rev 3).
 *
 * ## Why this exists
 *
 * Members onboarded BEFORE the rolling-anchor feature shipped have renewal
 * cycles provisionally anchored at `members.registration_date` (the F8
 * onboarding default) — a PLACEHOLDER, not their real enrolment date. Under
 * the FIXED-ANCHOR model (2026-07-22) a cycle's 12-month period is fixed at
 * the member's enrolment anchor and payment only ACTIVATES it; the live
 * payment hook no longer moves the period to the payment month (the reverted
 * #173 payment-anchor bug). For the pre-system cohort TSCC never recorded a
 * real enrolment date — the only historical signal is their recorded PAYMENT
 * date, so this ONE-OFF import uses that as the best proxy for their true
 * anchor, re-anchoring each open cycle from an operator-supplied CSV of
 * TSCC's recorded payment dates. This is a DATA-IMPORT correction of
 * placeholder anchors, NOT the live payment-time re-anchor — do not conflate
 * the two (the derived period below intentionally keys on the CSV payment
 * date because that IS the proxy anchor for these historical members).
 *
 * ## Input CSV (operator-authored — treat as PII, keep OUT of the repo)
 *
 *   company_name,payment_date[,period_from,period_to]
 *
 *   - `company_name`  — matched against `members.company_name` after
 *     normalisation (lowercase, strip punctuation, collapse whitespace).
 *     TSCC's records key on company NAME, not member number.
 *   - `payment_date`  — YYYY-MM-DD. Derived period = FIRST DAY of the
 *     payment month → +12 months (TSCC's 19 recorded period pairs all run
 *     1st-of-month → end-of-month).
 *   - `period_from` / `period_to` — OPTIONAL pair; when BOTH present they
 *     WIN over the derived period (the ~6 legacy "full year" members keep
 *     their fixed calendar-year window, e.g. 2026-01-01 → 2026-12-31).
 *
 * ## Skip rules (all reported, never silent)
 *
 *   - future-dated `payment_date` (> today) — the workbook contains ≥1;
 *     dropped BEFORE de-duplication so a bogus future duplicate can never
 *     eclipse the member's legitimate earlier payment.
 *   - duplicate company rows — keep MAX(payment_date), skip the rest.
 *   - unmatched / ambiguous company names.
 *   - members with no open cycle (upcoming|reminded|awaiting_payment).
 *   - already-anchored cycles (`anchored_at IS NOT NULL` — the same guard
 *     `reanchorPeriodInTx` enforces; re-running the script is idempotent).
 *
 * The ~7 paid-but-undated early-2025 members are NOT in scope here — staff
 * decide per case (TSCC follow-up or INV-date fallback) and add them to the
 * CSV when resolved. NO automatic fallback.
 *
 * ## Frozen plan fields are NOT re-frozen
 *
 * `reanchorPeriodInTx` requires the frozen price/term; we pass the cycle's
 * CURRENT values (sanctioned by the port docstring: "pass current values
 * otherwise"). Backfilled members were already invoiced and paid at their
 * original catalogue price — re-resolving against the new period's fiscal
 * year would rewrite history they actually paid. The audit row records
 * `refroze_plan_fields: false` accordingly.
 *
 * ## Safety model
 *
 *   - DRY-RUN BY DEFAULT: prints the full plan (reanchors + every skip with
 *     its reason) and writes NOTHING.
 *   - Writing requires the explicit `--confirm-prod` flag — regardless of
 *     which env-file the operator loaded. There is no "apply against dev
 *     without the flag" mode; the flag is the single write switch.
 *   - Each re-anchor runs in its OWN `runInTenant` transaction (RLS on),
 *     re-reads the open cycle under the tx, and emits the
 *     `renewal_cycle_reanchored` audit event ATOMICALLY with the UPDATE
 *     (Constitution Principle VIII). A failure on one member never rolls
 *     back the others; the summary reports per-member outcomes.
 *   - Report lines print member ids + CSV line numbers + periods — NOT
 *     company names (console transcripts get pasted into tickets; ids are
 *     pseudonymous, names are PII). The operator cross-references via the
 *     CSV line number.
 *
 * ## Usage
 *
 *   # dry-run against the dev branch (default .env.local)
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/backfill-cycle-anchors.ts \
 *     path/to/tscc-payment-dates.csv
 *
 *   # WRITE against production (after the dry-run output is reviewed)
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.production --import tsx scripts/backfill-cycle-anchors.ts \
 *     path/to/tscc-payment-dates.csv --confirm-prod
 *
 * Exit codes: 0 = plan executed / dry-run printed; 1 = validation or
 * infrastructure error; 2 = one or more writes failed (partial apply —
 * re-run is safe, already-anchored cycles skip).
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isNull } from 'drizzle-orm';

// F8 (final-review, 2026-07-09) — guard against a missing `.env.local`
// (e.g. a fresh git worktree that never copied one — it's gitignored —
// or a CI/prod runner where it simply doesn't exist) so this convenience
// fallback doesn't crash the script with an ENOENT before argv even
// parses. Layered UNDER the operator's explicit `--env-file=...` CLI flag
// (see ## Usage above): Node's `--env-file` populates `process.env`
// BEFORE this module starts running, and `process.loadEnvFile` (like
// dotenv) never overwrites an already-set var — so calling it here can
// only FILL IN vars the CLI flag didn't already supply, never override
// them. Safe to skip entirely when the file is absent.
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

import { runInTenant } from '@/lib/db';
import { asTenantContext, TENANT_SLUG_PATTERN, type TenantContext } from '@/modules/tenants';
// Deep import (not the `@/modules/members` barrel): the barrel transitively
// pulls the renewals→invoicing→payments chain, whose infrastructure imports
// `server-only` and refuses to load outside Next.js. Scripts follow the
// established deep-import convention (see seed-demo-members.ts).
import { asMemberId } from '@/modules/members/domain/member';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
import { makeDrizzleRenewalAuditEmitter } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter';
import { normaliseCompanyName as normaliseCompanyNameF6 } from '@/modules/events';
import {
  buildBackfillPlan,
  normalizeCompanyName,
  parseBackfillCsv,
  type BackfillPlan,
  type MemberLookupEntry,
  type OpenCycleInfo,
  type ReanchorAction,
} from './lib/backfill-cycle-anchors-core';

// ---------------------------------------------------------------------------
// CLI argument handling
// ---------------------------------------------------------------------------

function requireTenant(): TenantContext {
  const slug = process.env.TENANT_SLUG ?? '';
  if (slug.length === 0) {
    throw new Error(
      'backfill-cycle-anchors: TENANT_SLUG env is required (e.g. TENANT_SLUG=swecham).',
    );
  }
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `backfill-cycle-anchors: refusing malformed TENANT_SLUG="${slug}" ` +
        `(must match [a-z0-9-]{1,63}).`,
    );
  }
  return asTenantContext(slug);
}

interface CliArgs {
  readonly csvPath: string;
  readonly confirmProd: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));

  const unknown = flags.filter((f) => f !== '--confirm-prod' && f !== '--dry-run');
  if (unknown.length > 0) {
    throw new Error(`backfill-cycle-anchors: unknown flag(s): ${unknown.join(', ')}`);
  }
  const csvPath = positional[0];
  if (!csvPath) {
    throw new Error(
      'backfill-cycle-anchors: usage:\n\n' +
        '  TENANT_SLUG=swecham node --env-file=.env.local --import tsx ' +
        'scripts/backfill-cycle-anchors.ts <csv-path> [--confirm-prod]\n\n' +
        '  Default is DRY-RUN (prints the plan, writes nothing).\n' +
        '  --confirm-prod is the ONLY write switch.',
    );
  }
  const confirmProd = flags.includes('--confirm-prod');
  if (confirmProd && flags.includes('--dry-run')) {
    throw new Error(
      'backfill-cycle-anchors: --confirm-prod and --dry-run are mutually exclusive.',
    );
  }
  return { csvPath, confirmProd };
}

// ---------------------------------------------------------------------------
// DB reads (plan inputs)
// ---------------------------------------------------------------------------

/**
 * One `runInTenant` read pass building all plan indexes:
 *   - normalised company name → member (or 'ambiguous' on a collision),
 *     excluding erased members (their names are scrubbed sentinels anyway;
 *     COMP-1 read-exclusion convention).
 *   - FIX-5 (PR #173 review, 2026-07-09) — SECOND index keyed by F6's
 *     `normaliseCompanyName` (corporate-suffix stripping), consulted by
 *     `buildBackfillPlan` ONLY as a fallback when the primary index misses
 *     — closes the "suffixed CSV name vs bare stored company_name" gap.
 *     Same independent collision-detection contract as the primary index.
 *   - memberId → open cycle info (via `findOpenCycleForMemberInTx`, but only
 *     for members the CSV actually references — no full-table cycle scan).
 *     A member matched ONLY via the alternate index is looked up too (the
 *     referenced-names set is the CSV's PRIMARY-key normalisation, so we
 *     additionally probe the alternate index for each referenced name).
 *
 * Exported for the live-Neon integration test
 * (`tests/integration/renewals/backfill-cycle-anchors.test.ts`).
 */
export async function loadPlanInputs(
  ctx: TenantContext,
  referencedNames: ReadonlySet<string>,
): Promise<{
  memberIndex: Map<string, MemberLookupEntry | 'ambiguous'>;
  alternateMemberIndex: Map<string, MemberLookupEntry | 'ambiguous'>;
  openCycleIndex: Map<string, OpenCycleInfo>;
}> {
  const cyclesRepo = makeDrizzleRenewalCycleRepo(ctx);

  return runInTenant(ctx, async (tx) => {
    const memberRows = await tx
      .select({
        memberId: members.memberId,
        companyName: members.companyName,
      })
      .from(members)
      .where(isNull(members.erasedAt));

    const memberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>();
    const alternateMemberIndex = new Map<string, MemberLookupEntry | 'ambiguous'>();
    for (const row of memberRows) {
      const key = normalizeCompanyName(row.companyName);
      if (key !== '') {
        const existing = memberIndex.get(key);
        if (existing === undefined) {
          memberIndex.set(key, { memberId: row.memberId, companyName: row.companyName });
        } else if (existing === 'ambiguous' || existing.memberId !== row.memberId) {
          memberIndex.set(key, 'ambiguous');
        }
      }

      const altKey = normaliseCompanyNameF6(row.companyName);
      if (altKey !== '') {
        const existingAlt = alternateMemberIndex.get(altKey);
        if (existingAlt === undefined) {
          alternateMemberIndex.set(altKey, { memberId: row.memberId, companyName: row.companyName });
        } else if (existingAlt === 'ambiguous' || existingAlt.memberId !== row.memberId) {
          alternateMemberIndex.set(altKey, 'ambiguous');
        }
      }
    }

    const openCycleIndex = new Map<string, OpenCycleInfo>();
    const resolvedMemberIds = new Set<string>();
    for (const name of referencedNames) {
      const primary = memberIndex.get(name);
      const alternate = alternateMemberIndex.get(name);
      for (const match of [primary, alternate]) {
        if (match === undefined || match === 'ambiguous') continue;
        if (resolvedMemberIds.has(match.memberId)) continue;
        resolvedMemberIds.add(match.memberId);
        const cycle = await cyclesRepo.findOpenCycleForMemberInTx(tx, ctx.slug, match.memberId);
        if (cycle) {
          openCycleIndex.set(match.memberId, {
            cycleId: cycle.cycleId,
            status: cycle.status as OpenCycleInfo['status'],
            anchoredAt: cycle.anchoredAt,
          });
        }
      }
    }

    return { memberIndex, alternateMemberIndex, openCycleIndex };
  });
}

// ---------------------------------------------------------------------------
// Write pass
// ---------------------------------------------------------------------------

interface ApplyOutcome {
  readonly reanchored: number;
  readonly raceLost: number;
  readonly failed: number;
}

/**
 * Execute every planned re-anchor: one `runInTenant` tx per member, cycle
 * re-read under the tx (staleness guard), `reanchorPeriodInTx` (its own
 * WHERE re-verifies status + `anchored_at IS NULL`), and the
 * `renewal_cycle_reanchored` audit row in the SAME tx. Per-member fault
 * isolation: a throw is caught, logged, counted — the loop continues.
 *
 * Exported for the live-Neon integration test.
 */
export async function applyPlan(
  ctx: TenantContext,
  actions: readonly ReanchorAction[],
  runId: string,
  nowIso: string,
): Promise<ApplyOutcome> {
  const cyclesRepo = makeDrizzleRenewalCycleRepo(ctx);
  const auditEmitter = makeDrizzleRenewalAuditEmitter(ctx);

  let reanchored = 0;
  let raceLost = 0;
  let failed = 0;

  for (const action of actions) {
    try {
      const outcome = await runInTenant(ctx, async (tx) => {
        // Re-read under THIS tx — the plan was built in an earlier tx and a
        // concurrent payment hook may have anchored the cycle since.
        const cycle = await cyclesRepo.findOpenCycleForMemberInTx(
          tx,
          ctx.slug,
          action.memberId,
        );
        if (!cycle || cycle.cycleId !== action.cycleId || cycle.anchoredAt !== null) {
          return 'race_lost' as const;
        }

        const result = await cyclesRepo.reanchorPeriodInTx(tx, ctx.slug, cycle.cycleId, {
          periodFrom: action.newPeriodFrom,
          periodTo: action.newPeriodTo,
          anchoredAt: nowIso,
          anchorInvoiceId: null, // pre-system payment — no invoice exists
          // Deliberately the CURRENT frozen fields — see module docstring.
          frozenPlanPriceThb: cycle.frozenPlanPriceThb,
          frozenPlanTermMonths: cycle.frozenPlanTermMonths,
        });
        if (!result) return 'race_lost' as const;

        await auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_cycle_reanchored',
            payload: {
              cycle_id: cycle.cycleId,
              member_id: asMemberId(action.memberId),
              invoice_id: null,
              old_period_from: cycle.periodFrom,
              old_period_to: cycle.periodTo,
              new_period_from: result.cycle.periodFrom,
              new_period_to: result.cycle.periodTo,
              old_status: cycle.status,
              refroze_plan_fields: false,
              reminder_events_reset: result.reminderEventsReset,
            },
          },
          {
            tenantId: ctx.slug,
            actorUserId: null,
            actorRole: 'system',
            correlationId: `backfill-anchors:${runId}`,
            summary: `R4 backfill re-anchor from TSCC payment records (CSV line ${action.row.lineNumber})`,
          },
        );

        return { reminderEventsReset: result.reminderEventsReset } as const;
      });

      if (outcome === 'race_lost') {
        raceLost++;
        console.log(
          `  ~ line ${action.row.lineNumber} member=${action.memberId} — ` +
            `race lost (cycle changed since the plan was built); skipped safely`,
        );
      } else {
        reanchored++;
        console.log(
          `  ✓ line ${action.row.lineNumber} member=${action.memberId} ` +
            `cycle=${action.cycleId} → ${action.newPeriodFrom.slice(0, 10)} .. ` +
            `${action.newPeriodTo.slice(0, 10)} (${action.periodSource}, ` +
            `reminder events reset: ${outcome.reminderEventsReset})`,
        );
      }
    } catch (e) {
      failed++;
      console.error(
        `  ✗ line ${action.row.lineNumber} member=${action.memberId} FAILED: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { reanchored, raceLost, failed };
}

// ---------------------------------------------------------------------------
// Report rendering (no company names — see safety model in the header)
// ---------------------------------------------------------------------------

function printPlan(plan: BackfillPlan): void {
  const reanchors = plan.actions.filter((a) => a.kind === 'reanchor');
  const skips = plan.actions.filter((a) => a.kind === 'skip');

  console.log(`Plan: ${reanchors.length} re-anchor(s), ${skips.length} skip(s)`);
  console.log('');

  if (reanchors.length > 0) {
    console.log('Would re-anchor:');
    for (const a of reanchors) {
      console.log(
        `  line ${a.row.lineNumber} member=${a.memberId} cycle=${a.cycleId} ` +
          `payment=${a.row.paymentDate} → period ${a.newPeriodFrom.slice(0, 10)} .. ` +
          `${a.newPeriodTo.slice(0, 10)} (${a.periodSource})`,
      );
    }
    console.log('');
  }

  if (skips.length > 0) {
    console.log('Skipped (with reasons):');
    for (const a of skips) {
      const memberSuffix = a.memberId ? ` member=${a.memberId}` : '';
      console.log(`  line ${a.row.lineNumber}${memberSuffix} — ${a.reason}`);
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = requireTenant();
  const runId = randomUUID();
  const now = new Date();

  console.log('');
  console.log('=== backfill-cycle-anchors ===');
  console.log(`Tenant:  ${ctx.slug}`);
  console.log(`CSV:     ${args.csvPath}`);
  console.log(`Mode:    ${args.confirmProd ? 'WRITE (--confirm-prod)' : 'DRY-RUN (default)'}`);
  console.log(`Run id:  ${runId}`);
  console.log('');

  const csvText = readFileSync(args.csvPath, 'utf8');
  const parsed = parseBackfillCsv(csvText);

  if (parsed.issues.length > 0) {
    console.log(`CSV row issues (${parsed.issues.length}) — these rows are EXCLUDED:`);
    for (const issue of parsed.issues) {
      console.log(`  line ${issue.lineNumber} — ${issue.reason}`);
    }
    console.log('');
  }
  console.log(`Valid CSV rows: ${parsed.rows.length}`);
  console.log('');

  if (parsed.rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // FIX-5 (PR #173 review, 2026-07-09) — include BOTH the primary and the
  // F6 alternate normalisation of every row's company name, so
  // `loadPlanInputs`'s open-cycle pre-population resolves a member reachable
  // ONLY via the alternate (suffix-stripped) key too.
  const referencedNames = new Set(
    parsed.rows.flatMap((r) => [r.normalizedName, r.alternateNormalizedName]),
  );
  const { memberIndex, alternateMemberIndex, openCycleIndex } = await loadPlanInputs(
    ctx,
    referencedNames,
  );

  const plan = buildBackfillPlan({
    rows: parsed.rows,
    memberIndex,
    alternateMemberIndex,
    openCycleIndex,
    now,
  });

  printPlan(plan);

  const reanchors = plan.actions.filter((a): a is ReanchorAction => a.kind === 'reanchor');

  if (!args.confirmProd) {
    console.log(
      `DRY-RUN — no writes performed. Re-run with --confirm-prod to apply ` +
        `${reanchors.length} re-anchor(s).`,
    );
    console.log('');
    return;
  }

  if (reanchors.length === 0) {
    console.log('Nothing to apply (no matched, un-anchored open cycles).');
    return;
  }

  console.log(`Applying ${reanchors.length} re-anchor(s)…`);
  const outcome = await applyPlan(ctx, reanchors, runId, now.toISOString());
  console.log('');
  console.log(
    `Done: ${outcome.reanchored} re-anchored, ${outcome.raceLost} race-lost (safe skip), ` +
      `${outcome.failed} failed.`,
  );
  console.log('');

  if (outcome.failed > 0) {
    console.error(
      'One or more re-anchors FAILED — inspect the errors above. Re-running is ' +
        'safe: already-anchored cycles are skipped by the guard.',
    );
    process.exitCode = 2;
  }
}

const invokedDirectly =
  (process.argv[1] !== undefined &&
    process.argv[1] === fileURLToPath(import.meta.url)) ||
  process.argv[1]?.endsWith('backfill-cycle-anchors.ts') === true ||
  process.argv[1]?.endsWith('backfill-cycle-anchors.js') === true;

if (invokedDirectly) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      console.error(
        'backfill-cycle-anchors FAILED:',
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    });
}
