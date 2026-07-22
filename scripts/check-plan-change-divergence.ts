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

// Normalise db.execute result across postgres-js drivers that may return
// either an array directly or `{ rows: [...] }` (mirrors check-stray-plan-years).
function unwrap<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

interface RawDivergenceRow {
  readonly tenant_id: string;
  readonly cycle_id: string;
  readonly member_id: string;
  readonly cycle_status: string;
  readonly frozen_plan_price_thb: string;
  readonly invoice_id: string;
  readonly invoice_status: string;
  readonly document_number: string | null;
  readonly bill_document_number_raw: string | null;
  readonly membership_line_count: number | string;
  readonly unit_price_satang: string | number | bigint | null;
  readonly total_satang: string | number | bigint | null;
  readonly quantity: string | null;
  readonly pro_rate_factor: string | null;
}

/** null-safe bigint coercion for a satang column read back via raw SQL. */
function toSatangOrNull(v: string | number | bigint | null): bigint | null {
  return v === null ? null : BigInt(String(v));
}

/** True when the line carries a non-1 quantity OR pro-rate factor. */
function isProRatedLine(
  quantity: string | null,
  proRateFactor: string | null,
): boolean {
  return (
    (quantity !== null && Number(quantity) !== 1) ||
    (proRateFactor !== null && Number(proRateFactor) !== 1)
  );
}

/**
 * Scan for cycle↔invoice frozen-price divergence. Exported as a pure function
 * so it can be covered by an integration test against live Neon.
 *
 * `options.tenantId` optionally scopes the scan to a single tenant.
 */
export async function checkPlanChangeDivergence(options?: {
  readonly tenantId?: string;
}): Promise<CheckPlanChangeDivergenceReport> {
  const tenantFilter = options?.tenantId
    ? sql` AND c.tenant_id = ${options.tenantId}`
    : sql``;

  // For every renewal cycle linked to an issued/paid MEMBERSHIP invoice, pull
  // the invoice's single membership_fee line (LATERAL aggregate → exactly one
  // output row per pairing, even when the invoice has zero membership lines).
  // The joins carry explicit tenant_id predicates so the cross-tenant scan
  // (db singleton, RLS-bypass owner role) stays tenant-correct.
  const rows = unwrap<RawDivergenceRow>(
    await db.execute(sql`
      SELECT
        c.tenant_id              AS tenant_id,
        c.cycle_id               AS cycle_id,
        c.member_id              AS member_id,
        c.status                 AS cycle_status,
        c.frozen_plan_price_thb  AS frozen_plan_price_thb,
        i.invoice_id             AS invoice_id,
        i.status                 AS invoice_status,
        i.document_number        AS document_number,
        i.bill_document_number_raw AS bill_document_number_raw,
        ml.line_count            AS membership_line_count,
        ml.unit_price_satang     AS unit_price_satang,
        ml.total_satang          AS total_satang,
        ml.quantity              AS quantity,
        ml.pro_rate_factor       AS pro_rate_factor
      FROM renewal_cycles c
      JOIN invoices i
        ON i.tenant_id = c.tenant_id
       AND i.invoice_id = c.linked_invoice_id
      CROSS JOIN LATERAL (
        SELECT
          count(*)::int          AS line_count,
          min(l.unit_price_satang) AS unit_price_satang,
          min(l.total_satang)      AS total_satang,
          min(l.quantity)          AS quantity,
          min(l.pro_rate_factor)   AS pro_rate_factor
        FROM invoice_lines l
        WHERE l.tenant_id = i.tenant_id
          AND l.invoice_id = i.invoice_id
          AND l.kind = 'membership_fee'
      ) ml
      WHERE c.linked_invoice_id IS NOT NULL
        AND i.status IN ('issued', 'paid')
        AND i.invoice_subject = 'membership'${tenantFilter}
      ORDER BY c.tenant_id ASC, c.cycle_id ASC
    `),
  );

  const divergences: PlanChangeDivergenceRow[] = [];
  for (const r of rows) {
    // Mirror the billing path EXACTLY: the F4↔F8 bridge converts the cycle's
    // frozen decimal(12,2) THB to VAT-exclusive satang via this same
    // integer-only parser (NO parseFloat). See the header VAT-basis note.
    const frozenSatang = parseThbDecimalToSatang(
      parseThbDecimal(String(r.frozen_plan_price_thb)),
    );
    const membershipLineCount = Number(r.membership_line_count);
    const lineUnitPriceSatang = toSatangOrNull(r.unit_price_satang);
    const lineTotalSatang = toSatangOrNull(r.total_satang);
    const quantity = r.quantity === null ? null : String(r.quantity);
    const proRateFactor =
      r.pro_rate_factor === null ? null : String(r.pro_rate_factor);

    let kind: DivergenceKind | null = null;
    let deltaSatang: bigint | null = null;
    if (membershipLineCount !== 1 || lineUnitPriceSatang === null) {
      // 0 or >1 membership_fee lines — a membership §86/4 must carry exactly
      // one (create-invoice-draft.ts). Can't cleanly compare a price; flag it.
      kind = 'membership_line_anomaly';
    } else {
      // Compare on the PRE-pro-rate unit price (rounding- + pro-rate-immune).
      deltaSatang = frozenSatang - lineUnitPriceSatang;
      if (deltaSatang !== 0n) kind = 'price_divergence';
    }

    if (kind === null) continue; // frozen price agrees — not a divergence.

    divergences.push({
      tenantId: r.tenant_id,
      cycleId: r.cycle_id,
      memberId: r.member_id,
      cycleStatus: r.cycle_status,
      invoiceId: r.invoice_id,
      invoiceStatus: r.invoice_status,
      documentNumber: r.document_number,
      billDocumentNumberRaw: r.bill_document_number_raw,
      frozenThb: String(r.frozen_plan_price_thb),
      frozenSatang,
      membershipLineCount,
      lineUnitPriceSatang,
      lineTotalSatang,
      quantity,
      proRateFactor,
      proRatedLine: isProRatedLine(quantity, proRateFactor),
      deltaSatang,
      kind,
    });
  }

  return { scannedCount: rows.length, divergences };
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
