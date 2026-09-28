/**
 * Reset the e2e pay-sheet fixture SC-2026-900003 to a fresh, unpaid 088 bill
 * after a run paid it (and maybe credited, refunded or voided it). Shared by
 * `tests/e2e/global-setup.ts` and `scripts/reset-e2e-issued-invoice.ts`.
 *
 * The fixture is an 088 bill: paying it mints an RC §86/4 receipt number, and
 * migration 0235 freezes `receipt_document_number_raw` once set. An in-place
 * `UPDATE … SET status='issued'` therefore cannot un-pay it — and must not
 * route around the freeze (e.g. by bouncing the row through 'draft'), which is
 * a §87 safeguard. Instead the row is re-created in one transaction: the
 * children are unwound in FK order, the invoice is deleted, and a fresh issued
 * copy is inserted with the same id, bill number, bill PDF and snapshots. The
 * RC minted by the test run is simply gone (dev fixture only).
 *
 * A renewal cycle may point at the fixture (`renewal-success-state.ts` links
 * completed cycles to it) and `renewal_cycles_linked_invoice_fk` is NO ACTION,
 * so those cycles are detached before the DELETE and re-linked after the
 * INSERT (`planCycleRelink`).
 *
 * No `@/` imports: Playwright's global setup loads this file directly.
 */
import type postgres from 'postgres';

/** A row as postgres-js takes it for `INSERT … ${sql(row, columns)}`. */
type DbRow = Record<string, postgres.ParameterOrJSON<never>>;

/** Every payment / receipt / credit / void field, back to its unpaid value. */
const ISSUED_RESET: Readonly<Record<string, unknown>> = {
  status: 'issued',
  paid_at: null,
  payment_method: null,
  payment_reference: null,
  payment_notes: null,
  payment_recorded_by_user_id: null,
  payment_date: null,
  credited_total_satang: 0,
  receipt_document_number_raw: null,
  receipt_pdf_blob_key: null,
  receipt_pdf_sha256: null,
  receipt_pdf_template_version: null,
  receipt_pdf_status: null,
  receipt_pdf_render_attempts: 0,
  receipt_pdf_last_error: null,
  voided_at: null,
  void_reason: null,
  voided_by_user_id: null,
  void_pdf_reconcile_pending_at: null,
  void_pdf_reconcile_attempts: 0,
  void_pdf_reconcile_parked_at: null,
};

/**
 * The fresh issued copy of a fixture row (`SELECT *`, snake_case), limited to
 * the insertable columns — generated ones such as `blocks_coverage` cannot be
 * written. Pure, so it is unit-tested.
 */
export function buildIssuedFixtureResetRow(
  row: Readonly<Record<string, unknown>>,
  insertableColumns: readonly string[],
  now: Date,
): Record<string, unknown> {
  if (row.bill_document_number_raw == null) {
    throw new Error(
      `e2e fixture ${String(row.invoice_id)} is not an 088 bill (no bill number) — re-run scripts/seed-e2e-portal-invoices.ts`,
    );
  }
  const fresh: Record<string, unknown> = {};
  for (const column of insertableColumns) {
    if (column in row) fresh[column] = row[column];
  }
  return { ...fresh, ...ISSUED_RESET, updated_at: now };
}

/** A renewal cycle's link columns, as the reset reads and writes them. */
export interface CycleLink {
  readonly cycle_id: string;
  readonly status: string;
  readonly linked_invoice_id: string | null;
  readonly anchor_invoice_id: string | null;
}

/**
 * How to take cycles off the fixture for the DELETE and put them back after
 * the INSERT (the invoice id is pinned, so the restore links the same row).
 * A completed cycle cannot lose its link (CHECK
 * `renewal_cycles_completed_requires_invoice_check`), so it is parked as
 * `cancelled` — it already has `closed_at`, which both terminal states need.
 * Pure, so it is unit-tested.
 */
export function planCycleRelink(
  cycles: readonly CycleLink[],
  invoiceId: string,
): { detach: CycleLink[]; restore: CycleLink[] } {
  const detach = cycles.map((c) => ({
    cycle_id: c.cycle_id,
    status: c.status === 'completed' ? 'cancelled' : c.status,
    linked_invoice_id: c.linked_invoice_id === invoiceId ? null : c.linked_invoice_id,
    anchor_invoice_id: c.anchor_invoice_id === invoiceId ? null : c.anchor_invoice_id,
  }));
  const restore = cycles.map((c) => ({
    cycle_id: c.cycle_id,
    status: c.status,
    linked_invoice_id: c.linked_invoice_id,
    anchor_invoice_id: c.anchor_invoice_id,
  }));
  return { detach, restore };
}

/**
 * Re-create the fixture as an unpaid issued bill. Returns false when the row
 * does not exist (a re-seed or cleanup removed it) so the caller can say so.
 */
export async function resetE2eIssuedFixture(
  sql: postgres.Sql,
  invoiceId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx`SELECT * FROM invoices WHERE invoice_id = ${invoiceId} FOR UPDATE`;
    if (!row) return false;
    const lines = await tx`SELECT * FROM invoice_lines WHERE invoice_id = ${invoiceId}`;
    const columns = async (table: string) =>
      (
        await tx<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'NEVER'`
      ).map((c) => c.column_name);
    const invoiceColumns = await columns('invoices');
    const lineColumns = await columns('invoice_lines');
    const cycles = await tx<CycleLink[]>`
      SELECT cycle_id, status, linked_invoice_id, anchor_invoice_id FROM renewal_cycles
       WHERE tenant_id = ${row.tenant_id}
         AND (linked_invoice_id = ${invoiceId} OR anchor_invoice_id = ${invoiceId})
         FOR UPDATE`;
    const relink = planCycleRelink(cycles, invoiceId);
    const writeCycle = (c: CycleLink) => tx`
      UPDATE renewal_cycles
         SET status = ${c.status}, linked_invoice_id = ${c.linked_invoice_id},
             anchor_invoice_id = ${c.anchor_invoice_id}
       WHERE tenant_id = ${row.tenant_id} AND cycle_id = ${c.cycle_id}`;
    for (const c of relink.detach) await writeCycle(c);

    // Unwind the children in FK order (refunds ↔ credit_notes are circular:
    // break it on the credit_notes side first), then drop the invoice — its
    // lines cascade and are re-inserted below.
    await tx`UPDATE credit_notes SET source_refund_id = NULL WHERE source_refund_id IN (SELECT id FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = ${invoiceId}))`;
    await tx`DELETE FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = ${invoiceId})`;
    await tx`DELETE FROM credit_notes WHERE original_invoice_id = ${invoiceId}`;
    await tx`DELETE FROM payments WHERE invoice_id = ${invoiceId}`;
    await tx`DELETE FROM invoices WHERE invoice_id = ${invoiceId}`;

    const fresh = buildIssuedFixtureResetRow(row, invoiceColumns, new Date()) as DbRow;
    await tx`INSERT INTO invoices ${tx(fresh, Object.keys(fresh))}`;
    for (const line of lines) {
      const copy: DbRow = {};
      for (const column of lineColumns) if (column in line) copy[column] = line[column];
      await tx`INSERT INTO invoice_lines ${tx(copy, Object.keys(copy))}`;
    }
    for (const c of relink.restore) await writeCycle(c);
    return true;
  });
}
