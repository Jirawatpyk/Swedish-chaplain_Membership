/**
 * Resetting the e2e pay-sheet fixture SC-2026-900003 after a run paid it.
 *
 * The fixture is an 088 bill. Paying it mints an RC §86/4 receipt number, and
 * migration 0235 freezes `receipt_document_number_raw` once set, so the old
 * in-place `UPDATE … SET status='issued'` can no longer un-pay it (and must
 * not try to dodge the freeze). The reset re-creates the row instead: the
 * builder here turns the paid row into a fresh issued copy — same id, bill
 * number, bill PDF and snapshots; every payment / receipt / credit / void
 * field cleared; generated columns left out of the INSERT.
 */
import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  buildIssuedFixtureResetRow,
  planCycleRelink,
  resetE2eIssuedFixture,
} from '../../../scripts/lib/e2e-issued-fixture-reset';

const NOW = new Date('2026-09-28T12:00:00Z');

/** A paid 088 bill as `SELECT *` returns it (snake_case), after an e2e pay + credit. */
function paidRow(): Record<string, unknown> {
  return {
    tenant_id: 'swecham',
    invoice_id: '00000000-e2e0-4fff-9ffe-000000900003',
    member_id: 'm1',
    status: 'partially_credited',
    fiscal_year: 2026,
    sequence_number: null,
    document_number: null,
    bill_document_number_raw: 'SC-2026-900003',
    receipt_document_number_raw: 'RC-2026-000123',
    issue_date: '2026-04-15',
    total_satang: '535000',
    credited_total_satang: '100000',
    paid_at: new Date('2026-09-27T10:00:00Z'),
    payment_method: 'card',
    payment_reference: 'pi_123',
    payment_notes: 'n',
    payment_recorded_by_user_id: 'u1',
    payment_date: '2026-09-27',
    receipt_pdf_blob_key: 'invoicing/swecham/2026/x_receipt_v12.pdf',
    receipt_pdf_sha256: 'b'.repeat(64),
    receipt_pdf_template_version: 12,
    receipt_pdf_status: 'rendered',
    receipt_pdf_render_attempts: 1,
    receipt_pdf_last_error: 'boom',
    voided_at: null,
    void_reason: null,
    voided_by_user_id: null,
    void_pdf_reconcile_pending_at: null,
    void_pdf_reconcile_attempts: 2,
    void_pdf_reconcile_parked_at: null,
    pdf_blob_key: 'invoicing/swecham/2026/x_v12.pdf',
    pdf_sha256: 'a'.repeat(64),
    pdf_template_version: 12,
    pdf_doc_kind: 'invoice',
    blocks_coverage: true,
    created_at: new Date('2026-04-15T00:00:00Z'),
    updated_at: new Date('2026-09-27T10:00:00Z'),
  };
}

const INSERTABLE = Object.keys(paidRow()).filter((c) => c !== 'blocks_coverage');

describe('buildIssuedFixtureResetRow', () => {
  it('keeps the identity, bill number, bill PDF and snapshots', () => {
    const row = buildIssuedFixtureResetRow(paidRow(), INSERTABLE, NOW);
    expect(row.invoice_id).toBe('00000000-e2e0-4fff-9ffe-000000900003');
    expect(row.bill_document_number_raw).toBe('SC-2026-900003');
    expect(row.pdf_blob_key).toBe('invoicing/swecham/2026/x_v12.pdf');
    expect(row.pdf_sha256).toBe('a'.repeat(64));
    expect(row.pdf_doc_kind).toBe('invoice');
    expect(row.total_satang).toBe('535000');
    expect(row.created_at).toEqual(new Date('2026-04-15T00:00:00Z'));
  });

  it('returns it to an unpaid issued bill: RC, receipt, payment and credit fields cleared', () => {
    const row = buildIssuedFixtureResetRow(paidRow(), INSERTABLE, NOW);
    expect(row.status).toBe('issued');
    expect(row.receipt_document_number_raw).toBeNull();
    expect(row.receipt_pdf_status).toBeNull();
    expect(row.receipt_pdf_blob_key).toBeNull();
    expect(row.receipt_pdf_sha256).toBeNull();
    expect(row.receipt_pdf_template_version).toBeNull();
    expect(row.receipt_pdf_render_attempts).toBe(0);
    expect(row.receipt_pdf_last_error).toBeNull();
    expect(row.paid_at).toBeNull();
    expect(row.payment_method).toBeNull();
    expect(row.payment_reference).toBeNull();
    expect(row.payment_notes).toBeNull();
    expect(row.payment_recorded_by_user_id).toBeNull();
    expect(row.payment_date).toBeNull();
    // `invoices_credited_status_matches`: 'issued' requires credited_total = 0.
    expect(row.credited_total_satang).toBe(0);
    expect(row.void_pdf_reconcile_attempts).toBe(0);
    expect(row.updated_at).toBe(NOW);
  });

  it('leaves generated columns (blocks_coverage) out of the INSERT', () => {
    const row = buildIssuedFixtureResetRow(paidRow(), INSERTABLE, NOW);
    expect(row).not.toHaveProperty('blocks_coverage');
  });

  it('clears a void too', () => {
    const row = buildIssuedFixtureResetRow(
      {
        ...paidRow(),
        status: 'void',
        voided_at: new Date(),
        void_reason: 'x',
        voided_by_user_id: 'u1',
        void_pdf_reconcile_pending_at: new Date(),
      },
      INSERTABLE,
      NOW,
    );
    expect(row.status).toBe('issued');
    expect(row.voided_at).toBeNull();
    expect(row.void_reason).toBeNull();
    expect(row.voided_by_user_id).toBeNull();
    expect(row.void_pdf_reconcile_pending_at).toBeNull();
  });

  it('refuses a row that is not an 088 bill (no bill number)', () => {
    expect(() =>
      buildIssuedFixtureResetRow(
        { ...paidRow(), bill_document_number_raw: null, document_number: 'SC-2026-900003' },
        INSERTABLE,
        NOW,
      ),
    ).toThrow(/088 bill/);
  });
});

/*
 * A renewal cycle can point at the fixture: `renewal-success-state.ts` links
 * completed cycles to it, and `renewal_cycles_linked_invoice_fk` is NO ACTION,
 * so deleting the invoice under it failed the whole reset. The reset detaches
 * those cycles first and puts them back after the re-insert (same invoice id).
 * A completed cycle cannot simply lose its link — CHECK
 * `renewal_cycles_completed_requires_invoice_check` — so it is parked as
 * cancelled (it already has closed_at) for the length of the transaction.
 */
const FIXTURE_ID = '00000000-e2e0-4fff-9ffe-000000900003';

describe('planCycleRelink', () => {
  it('parks a completed cycle as cancelled with no link, then restores it completed and linked', () => {
    const plan = planCycleRelink(
      [{ cycle_id: 'c1', status: 'completed', linked_invoice_id: FIXTURE_ID, anchor_invoice_id: null }],
      FIXTURE_ID,
    );
    expect(plan.detach).toEqual([
      { cycle_id: 'c1', status: 'cancelled', linked_invoice_id: null, anchor_invoice_id: null },
    ]);
    expect(plan.restore).toEqual([
      { cycle_id: 'c1', status: 'completed', linked_invoice_id: FIXTURE_ID, anchor_invoice_id: null },
    ]);
  });

  it('only unlinks a cycle that is not completed, and restores the link', () => {
    const plan = planCycleRelink(
      [{ cycle_id: 'c2', status: 'awaiting_payment', linked_invoice_id: FIXTURE_ID, anchor_invoice_id: null }],
      FIXTURE_ID,
    );
    expect(plan.detach).toEqual([
      { cycle_id: 'c2', status: 'awaiting_payment', linked_invoice_id: null, anchor_invoice_id: null },
    ]);
    expect(plan.restore[0]).toMatchObject({ status: 'awaiting_payment', linked_invoice_id: FIXTURE_ID });
  });

  it('restores an anchor pointing at the fixture, and leaves links to other invoices alone', () => {
    const plan = planCycleRelink(
      [{ cycle_id: 'c3', status: 'upcoming', linked_invoice_id: 'other', anchor_invoice_id: FIXTURE_ID }],
      FIXTURE_ID,
    );
    expect(plan.detach[0]).toMatchObject({ linked_invoice_id: 'other', anchor_invoice_id: null });
    expect(plan.restore[0]).toMatchObject({ linked_invoice_id: 'other', anchor_invoice_id: FIXTURE_ID });
  });
});

describe('resetE2eIssuedFixture — renewal cycles linked to the fixture', () => {
  /** A fake postgres-js `sql` that records each query's text in order. */
  function fakeSql(cycles: Record<string, unknown>[]) {
    const queries: string[] = [];
    const tx = ((first: unknown, ...rest: unknown[]) => {
      if (!Array.isArray(first) || !('raw' in first)) return { helper: first, rest };
      const text = (first as readonly string[]).join('?').replace(/\s+/g, ' ').trim();
      queries.push(text);
      if (text.startsWith('SELECT * FROM invoices')) return Promise.resolve([paidRow()]);
      if (text.startsWith('SELECT column_name')) {
        return Promise.resolve(INSERTABLE.map((column_name) => ({ column_name })));
      }
      if (text.includes('FROM renewal_cycles')) return Promise.resolve(cycles);
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    const sql = { begin: (fn: (t: postgres.TransactionSql) => unknown) => fn(tx) } as unknown as postgres.Sql;
    return { sql, queries };
  }

  it('detaches the cycle before deleting the invoice and re-links it after the re-insert', async () => {
    const { sql, queries } = fakeSql([
      { cycle_id: 'c1', status: 'completed', linked_invoice_id: FIXTURE_ID, anchor_invoice_id: null },
    ]);
    await expect(resetE2eIssuedFixture(sql, FIXTURE_ID)).resolves.toBe(true);
    const cycleUpdates = queries.flatMap((q, i) => (q.startsWith('UPDATE renewal_cycles') ? [i] : []));
    const deleteInvoice = queries.findIndex((q) => q.startsWith('DELETE FROM invoices'));
    const insertInvoice = queries.findIndex((q) => q.startsWith('INSERT INTO invoices'));
    expect(cycleUpdates).toHaveLength(2);
    expect(cycleUpdates[0]).toBeLessThan(deleteInvoice);
    expect(cycleUpdates[1]).toBeGreaterThan(insertInvoice);
  });

  it('touches no cycle when none points at the fixture', async () => {
    const { sql, queries } = fakeSql([]);
    await resetE2eIssuedFixture(sql, FIXTURE_ID);
    expect(queries.some((q) => q.startsWith('UPDATE renewal_cycles'))).toBe(false);
  });
});
