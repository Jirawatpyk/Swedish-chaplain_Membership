/**
 * 106-void-on-reissue · Task 6 — ship-gate 1 pre-check.
 *
 * READ-ONLY. Finds legacy issued §86/4 MEMBERSHIP invoices that predate
 * the 088-invoice-tax-flow-redesign bill/tax-invoice split.
 *
 * Why this matters: `listSupersedableMembershipBills` (the §4.2 auto-void
 * matcher wired into `issueMembershipBill` — see
 * `specs/106-void-on-reissue/`) only matches the NEW-flow bill shape:
 *
 *   bill_document_number_raw IS NOT NULL AND document_number IS NULL
 *
 * A legacy row was issued as a full §86/4 tax invoice under the pre-088
 * flow, so it has the OLD shape instead:
 *
 *   document_number IS NOT NULL
 *
 * The two shapes are asymmetric by design (088's numbering-stream split)
 * — auto-void's matcher will NEVER select a legacy row. If a member with
 * an old `issued`, unpaid §86/4 invoice reactivates after
 * `FEATURE_VOID_ON_REISSUE=true` ships, the new bill issues normally but
 * the legacy invoice is silently left dangling forever (not superseded,
 * not voided, not paid).
 *
 * This script is ship-gate 1 (see docs/runbooks/void-on-reissue.md): an
 * operator MUST run it against prod and get a clean (zero-row) result —
 * or hand any listed rows to the treasurer for manual §86/10 / ป.86/2542
 * cancellation — BEFORE setting `FEATURE_VOID_ON_REISSUE=true`.
 *
 * Deliberately barrel-free: importing `@/modules/invoicing` under
 * standalone `tsx` pulls in `server-only` transitively and throws (see
 * the 066 barrel-cycle gotcha in CLAUDE.md). This script uses the shared
 * `@/lib/db` singleton + a raw SQL query instead, matching the idiom
 * already used by `scripts/check-multi-tenant-ready.ts` and
 * `scripts/check-admin-row.ts`.
 *
 * No tenant loop is needed: `@/lib/db`'s pooled connection uses the Neon
 * default role (`neondb_owner`, `rolbypassrls = TRUE`), so a direct query
 * through the global `db` singleton (i.e. NOT wrapped in `runInTenant`,
 * which would `SET LOCAL ROLE chamber_app` and scope to one tenant) sees
 * every tenant's rows in one pass — the same cross-tenant-by-design
 * pattern `check-multi-tenant-ready.ts` relies on for its NULL-tenant_id
 * sentinel scan. Single-tenant deployment today (SweCham only), but this
 * naturally scans every tenant if/when a second one onboards.
 *
 * Usage (read-only, no writes):
 *   node --env-file=.env.local --import tsx scripts/check-legacy-membership-86-4.ts
 *     (dev smoke-test / local sanity check)
 *   node --env-file=.env.local.bak.prod --import tsx scripts/check-legacy-membership-86-4.ts
 *     (operator ship-gate run — prod, read-only)
 *
 * Exit code: 0 = clean (no legacy rows, gate PASSES). 1 = legacy rows
 * found (gate FAILS — do not enable the flag) OR a fatal query error.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

interface LegacyRow {
  readonly tenant_id: string;
  readonly invoice_id: string;
  readonly document_number: string;
  readonly member_id: string | null;
  readonly issue_date: string | null;
}

async function main(): Promise<void> {
  const rows: LegacyRow[] = (await db.execute(sql`
    SELECT tenant_id, invoice_id, document_number, member_id, issue_date
    FROM invoices
    WHERE invoice_subject = 'membership'
      AND status = 'issued'
      AND document_number IS NOT NULL
    ORDER BY tenant_id, issue_date
  `)) as never;

  if (rows.length === 0) {
    console.log(
      '[check:legacy-membership-86-4] 0 legacy issued §86/4 membership rows — ship-gate 1 CLEAN.',
    );
    process.exit(0);
  }

  const byTenant = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    const list = byTenant.get(row.tenant_id) ?? [];
    list.push(row);
    byTenant.set(row.tenant_id, list);
  }

  console.error(
    `[check:legacy-membership-86-4] FOUND ${rows.length} legacy issued §86/4 membership ` +
      `row(s) across ${byTenant.size} tenant(s) — void-on-reissue will NOT touch these ` +
      '(shape mismatch: document_number IS NOT NULL is the pre-088 legacy shape; the §4.2 ' +
      'matcher only selects bill_document_number_raw rows). Hand these to the treasurer for ' +
      'manual §86/10 / ป.86/2542 cancellation before enabling FEATURE_VOID_ON_REISSUE. ' +
      'See docs/runbooks/void-on-reissue.md.',
  );
  for (const [tenantId, tenantRows] of byTenant) {
    console.error(`  tenant "${tenantId}": ${tenantRows.length} row(s)`);
    for (const row of tenantRows) {
      console.error(
        `    invoice_id=${row.invoice_id} document_number=${row.document_number} ` +
          `member_id=${row.member_id ?? 'NULL'} issue_date=${row.issue_date ?? 'NULL'}`,
      );
    }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('[check:legacy-membership-86-4] fatal:', e);
  process.exit(1);
});
