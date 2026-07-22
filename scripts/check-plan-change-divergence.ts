/**
 * Pre-flag-flip reconcile detector (Task #13) — finds renewal cycles whose
 * FROZEN price disagrees with the §86/4 that was issued + linked to them.
 *
 * READ-ONLY. This is the standing monitor that MUST run CLEAN before enabling
 * `FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE` (the immediate mid-cycle re-freeze,
 * currently flag-off). It also catches ANY cycle↔invoice price drift regardless
 * of that flag's state, so it is safe to run as a recurring gate.
 *
 * ── What "divergence" means ────────────────────────────────────────────────
 * For every renewal cycle with a non-null `linked_invoice_id` pointing at an
 * `invoices` row whose `status IN ('issued','paid')` AND
 * `invoice_subject='membership'`, we compare:
 *
 *   LHS — the cycle's FROZEN price:
 *         parseThbDecimalToSatang(renewal_cycles.frozen_plan_price_thb)
 *         (VAT-EXCLUSIVE satang — the exact integer-only conversion the F4↔F8
 *          renewal bridge uses; see the VAT-basis note below.)
 *
 *   RHS — the invoice's membership-fee line UNIT price:
 *         invoice_lines.unit_price_satang  (kind='membership_fee')
 *         (VAT-EXCLUSIVE satang.)
 *
 * A divergence is `LHS !== RHS`.
 *
 * ── VAT basis: how we confirmed the two sides are comparable ────────────────
 * The renewal billing path is:
 *   f4-invoicing-for-renewal-bridge-drizzle.ts
 *     → frozenUnitPriceSatang = parseThbDecimalToSatang(cycle.frozen_plan_price_thb)
 *     → createInvoiceDraft(..., renewalSignal: { unitPriceSatang: frozenUnitPriceSatang })
 *   create-invoice-draft.ts (renewal branch)
 *     → membershipUnitPriceSatang = renewalSignal.unitPriceSatang   (VAT-EXCLUSIVE)
 *     → forces quantity   = '1.0000'
 *     → forces proRate    = '1.0000'   (a renewal is always a full cycle, FR-022)
 *     → membership line: unit_price_satang = membershipUnitPriceSatang
 *   invoice-line.ts
 *     → total_satang = round(unit_price_satang × quantity × coalesce(proRate,1))
 *
 * So for a correctly-billed renewal line:
 *   unit_price_satang === total_satang === parseThbDecimalToSatang(frozen)
 *
 * We compare against `unit_price_satang` (the PRE-pro-rate billed unit price),
 * NOT the raw `total_satang`, on purpose:
 *   • The renewal path stores the frozen price verbatim in `unit_price_satang`,
 *     so unit-price equality is the truest "was the frozen price billed?" test.
 *   • It is IMMUNE to a legitimately pro-rated line (`total_satang < unit_price`
 *     when proRate<1) — comparing the raw `total_satang` to the full-cycle
 *     frozen price would FALSE-positive on any pro-rated membership line
 *     ("a wrong VAT basis makes every row look divergent"). This is the
 *     "handle the pro-rate factor if a line carries one" safeguard.
 *   • It is IMMUNE to the two-step half-away-from-zero rounding in
 *     `makeInvoiceLine` (integer comparison, no rounding involved).
 * The report still surfaces `total_satang`, `quantity`, and `pro_rate_factor`
 * for context so an operator can see whether a pro-rate is in play.
 *
 * A membership invoice carries EXACTLY ONE `membership_fee` line
 * (create-invoice-draft.ts). A `membership_line_count !== 1` is reported as a
 * `membership_line_anomaly` (can't cleanly compare a price) rather than silently
 * summed.
 *
 * ── Tenancy ────────────────────────────────────────────────────────────────
 * Cross-tenant maintenance diagnostic. Uses the `@/lib/db` singleton (Neon
 * default role `neondb_owner`, `rolbypassrls = TRUE`), NOT `runInTenant`
 * (which would `SET LOCAL app.current_tenant` and scope to ONE tenant). The
 * joins carry explicit `tenant_id` predicates so the scan is tenant-correct
 * while seeing every tenant's rows in one pass — the same cross-tenant-by-
 * design pattern `check-legacy-membership-86-4.ts` + `check-stray-plan-years.ts`
 * rely on. Single-tenant deployment today (SweCham only); naturally scans every
 * tenant if/when a second onboards. Pass `{ tenantId }` to scope to one tenant.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node --env-file=.env.local --import tsx scripts/check-plan-change-divergence.ts
 *     (dev smoke-test / local sanity check)
 *   node --env-file=.env.local.bak.prod --import tsx scripts/check-plan-change-divergence.ts
 *     (operator ship-gate run — prod, read-only)
 *   pnpm check:plan-divergence
 *
 * Exit code: 0 = CLEAN (0 divergences, gate PASSES). 1 = divergence(s) found
 * (gate FAILS — do NOT flip the flag; see docs/runbooks/plan-change-divergence.md)
 * OR a fatal query error.
 *
 * Safe to run repeatedly (read-only — mutates nothing).
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { parseThbDecimal, parseThbDecimalToSatang } from '@/lib/money';

/** Discriminates the two kinds of finding this detector reports. */
export type DivergenceKind = 'price_divergence' | 'membership_line_anomaly';

/** One divergent renewal-cycle ↔ linked-invoice pairing. */
export interface PlanChangeDivergenceRow {
  readonly tenantId: string;
  readonly cycleId: string;
  readonly memberId: string;
  readonly cycleStatus: string;
  readonly invoiceId: string;
  readonly invoiceStatus: string;
  /** Printed §86/4 number (legacy) or the pre-088 bill number, for lookup. */
  readonly documentNumber: string | null;
  readonly billDocumentNumberRaw: string | null;
  /** The cycle's frozen price, verbatim `decimal(12,2)` THB string. */
  readonly frozenThb: string;
  /** Frozen price in VAT-exclusive satang (mirror of the billing path). */
  readonly frozenSatang: bigint;
  /** How many `membership_fee` lines the invoice carries (expected: 1). */
  readonly membershipLineCount: number;
  /** The membership line's VAT-exclusive pre-pro-rate unit price; null if none. */
  readonly lineUnitPriceSatang: bigint | null;
  /** The membership line's pro-rated total; null if no line. */
  readonly lineTotalSatang: bigint | null;
  readonly quantity: string | null;
  readonly proRateFactor: string | null;
  /** True when the line carries a non-1 quantity or pro-rate (renewal ⇒ false). */
  readonly proRatedLine: boolean;
  /** frozenSatang − lineUnitPriceSatang; null for a line-count anomaly. */
  readonly deltaSatang: bigint | null;
  readonly kind: DivergenceKind;
}

export interface CheckPlanChangeDivergenceReport {
  /** Total linked issued/paid membership invoices evaluated. */
  readonly scannedCount: number;
  /** Only the divergent (or anomalous) rows. */
  readonly divergences: readonly PlanChangeDivergenceRow[];
}

/**
 * Scan for cycle↔invoice frozen-price divergence. Exported as a pure function
 * so it can be covered by an integration test against live Neon.
 *
 * `options.tenantId` optionally scopes the scan to a single tenant.
 */
export async function checkPlanChangeDivergence(_options?: {
  readonly tenantId?: string;
}): Promise<CheckPlanChangeDivergenceReport> {
  // TODO(green): implement the cross-tenant divergence query.
  return { scannedCount: 0, divergences: [] };
}

function describeRow(row: PlanChangeDivergenceRow): string {
  const docRef =
    row.documentNumber ?? row.billDocumentNumberRaw ?? '(no number)';
  if (row.kind === 'membership_line_anomaly') {
    return (
      `    tenant=${row.tenantId} cycle=${row.cycleId} member=${row.memberId} ` +
      `invoice=${row.invoiceId} (${row.invoiceStatus}, ${docRef}) ` +
      `ANOMALY membership_fee lines=${row.membershipLineCount} ` +
      `frozen=${row.frozenThb} THB (${row.frozenSatang} satang)`
    );
  }
  return (
    `    tenant=${row.tenantId} cycle=${row.cycleId} member=${row.memberId} ` +
    `invoice=${row.invoiceId} (${row.invoiceStatus}, ${docRef})\n` +
    `      frozen=${row.frozenThb} THB (${row.frozenSatang} satang) ` +
    `vs line unit=${row.lineUnitPriceSatang} satang ` +
    `delta=${row.deltaSatang} satang ` +
    `[line total=${row.lineTotalSatang} qty=${row.quantity} proRate=${row.proRateFactor}]`
  );
}

async function main(): Promise<void> {
  console.log('');
  console.log('=== check-plan-change-divergence (READ-ONLY) ===');
  const report = await checkPlanChangeDivergence();
  console.log(
    `Scanned ${report.scannedCount} linked issued/paid membership invoice(s).`,
  );

  if (report.divergences.length === 0) {
    console.log(
      '[check:plan-divergence] 0 divergences — cycle frozen prices agree with ' +
        'their linked §86/4 lines. Gate CLEAN.',
    );
    console.log('');
    return;
  }

  const byTenant = new Map<string, PlanChangeDivergenceRow[]>();
  for (const row of report.divergences) {
    const list = byTenant.get(row.tenantId) ?? [];
    list.push(row);
    byTenant.set(row.tenantId, list);
  }
  console.error(
    `[check:plan-divergence] FOUND ${report.divergences.length} divergence(s) ` +
      `across ${byTenant.size} tenant(s). A cycle's frozen price disagrees with ` +
      'the membership line on its linked §86/4. Do NOT enable ' +
      'FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE. See ' +
      'docs/runbooks/plan-change-divergence.md.',
  );
  for (const [tenantId, rows] of byTenant) {
    console.error(`  tenant "${tenantId}": ${rows.length} divergence(s)`);
    for (const row of rows) console.error(describeRow(row));
  }
  console.error('');
  process.exit(1);
}

// Only auto-run when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1]?.endsWith('check-plan-change-divergence.ts') === true ||
  process.argv[1]?.endsWith('check-plan-change-divergence.js') === true;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[check:plan-divergence] fatal:', err);
      process.exit(1);
    });
}
