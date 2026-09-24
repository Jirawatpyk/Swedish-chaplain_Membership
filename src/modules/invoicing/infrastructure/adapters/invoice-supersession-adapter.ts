/**
 * 121-void-supersede-links — Drizzle adapter for `InvoiceSupersessionReadPort`.
 *
 * Reads the void-on-reissue link straight from `audit_log` (the source of
 * truth; there is no column on `invoices`) and joins the invoice at the other
 * end on the `invoices_pkey (tenant_id, invoice_id)`. Both directions are served
 * by partial expression indexes from migration 0305, which hold ONLY
 * supersede-void rows:
 *
 *   forward  audit_log_invoice_superseded_fwd_idx (tenant_id, payload->>'invoice_id')
 *   reverse  audit_log_invoice_superseded_rev_idx (tenant_id, payload->>'superseded_by_invoice_id')
 *
 * The WHERE clauses below repeat the index predicate verbatim
 * (`event_type = 'invoice_voided' AND payload->>'superseded_by_invoice_id' IS
 * NOT NULL`) so the planner can match them.
 *
 * Tenant isolation is two-layer (Constitution I): `runInTenant` (FORCE RLS on
 * both tables) AND an explicit `tenant_id` predicate on both sides of the join.
 * The explicit one is load-bearing on `audit_log`, whose policy also admits
 * `tenant_id IS NULL` rows.
 */
import { sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import type {
  InvoiceSupersessionReadPort,
  SupersessionLinkRow,
} from '../../application/ports/invoice-supersession-port';
import type { InvoiceStatus } from '../../domain/invoice';

interface LinkSqlRow {
  readonly invoice_id: string;
  readonly display_number: string | null;
  readonly issue_date: string | null;
  readonly member_id: string | null;
  readonly status: InvoiceStatus;
}

function toRow(r: LinkSqlRow): SupersessionLinkRow {
  return {
    invoiceId: r.invoice_id,
    displayNumber: r.display_number,
    issueDate: r.issue_date,
    memberId: r.member_id,
    status: r.status,
  };
}

async function readReplacement(
  tx: TenantTx,
  tenantId: string,
  voidedInvoiceId: string,
): Promise<SupersessionLinkRow | null> {
  // Latest supersede row for this invoice first, THEN the join — a link whose
  // target is not visible in this tenant resolves to nothing rather than
  // falling back to an older row.
  const rows = (await tx.execute(sql`
    SELECT i.invoice_id::text                                   AS invoice_id,
           COALESCE(i.bill_document_number_raw, i.document_number,
                    i.receipt_document_number_raw)              AS display_number,
           i.issue_date::text                                   AS issue_date,
           i.member_id::text                                    AS member_id,
           i.status::text                                       AS status
      FROM (
             SELECT a.payload->>'superseded_by_invoice_id' AS replacement_id
               FROM audit_log a
              WHERE a.tenant_id = ${tenantId}
                AND a.event_type = 'invoice_voided'
                AND (a.payload->>'superseded_by_invoice_id') IS NOT NULL
                AND (a.payload->>'invoice_id') = ${voidedInvoiceId}
              ORDER BY a.timestamp DESC, a.id DESC
              LIMIT 1
           ) link
      JOIN invoices i
        ON i.tenant_id = ${tenantId}
       AND i.invoice_id = link.replacement_id::uuid
  `)) as unknown as LinkSqlRow[];
  const first = rows[0];
  return first === undefined ? null : toRow(first);
}

async function readReplaced(
  tx: TenantTx,
  tenantId: string,
  replacementInvoiceId: string,
): Promise<readonly SupersessionLinkRow[]> {
  const rows = (await tx.execute(sql`
    SELECT i.invoice_id::text                                   AS invoice_id,
           COALESCE(i.bill_document_number_raw, i.document_number,
                    i.receipt_document_number_raw)              AS display_number,
           i.issue_date::text                                   AS issue_date,
           i.member_id::text                                    AS member_id,
           i.status::text                                       AS status
      FROM audit_log a
      JOIN invoices i
        ON i.tenant_id = ${tenantId}
       AND i.invoice_id = (a.payload->>'invoice_id')::uuid
     WHERE a.tenant_id = ${tenantId}
       AND a.event_type = 'invoice_voided'
       AND (a.payload->>'superseded_by_invoice_id') IS NOT NULL
       AND (a.payload->>'superseded_by_invoice_id') = ${replacementInvoiceId}
     ORDER BY a.timestamp ASC, a.id ASC
  `)) as unknown as LinkSqlRow[];
  return rows.map(toRow);
}

export const invoiceSupersessionAdapter: InvoiceSupersessionReadPort = {
  findReplacement(tenantId, voidedInvoiceId) {
    return runInTenant(asTenantContext(tenantId), (tx) =>
      readReplacement(tx, tenantId, voidedInvoiceId),
    );
  },
  findReplaced(tenantId, replacementInvoiceId) {
    return runInTenant(asTenantContext(tenantId), (tx) =>
      readReplaced(tx, tenantId, replacementInvoiceId),
    );
  },
};
