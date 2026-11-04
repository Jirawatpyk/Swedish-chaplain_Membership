/**
 * #729 — Drizzle impl of {@link OrphanPdfReferenceRepo}. Built per tenant on
 * the `tx` from `runInTenant`, so RLS scopes the read; every statement also
 * carries the explicit `tenant_id` predicate (D-029). Read-only.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { OrphanPdfReferenceRepo } from '../../application/ports/orphan-pdf-reference-repo';

/** A uuid[] parameter: the ids come from a strict key parse, never from a user. */
const uuidArray = (ids: readonly string[]) => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

export function makeDrizzleOrphanPdfReferenceRepo(tx: TenantTx): OrphanPdfReferenceRepo {
  return {
    async referencedKeys(tenantId, ids) {
      const keys = new Set<string>();
      if (ids.invoiceIds.length > 0) {
        const rows = (await tx.execute(sql`
          SELECT pdf_blob_key, receipt_pdf_blob_key
          FROM invoices
          WHERE tenant_id = ${tenantId}
            AND invoice_id = ANY(${uuidArray(ids.invoiceIds)})
        `)) as unknown as ReadonlyArray<{ pdf_blob_key: string | null; receipt_pdf_blob_key: string | null }>;
        for (const r of rows) {
          if (r.pdf_blob_key) keys.add(r.pdf_blob_key);
          if (r.receipt_pdf_blob_key) keys.add(r.receipt_pdf_blob_key);
        }
      }
      if (ids.creditNoteIds.length > 0) {
        const rows = (await tx.execute(sql`
          SELECT pdf_blob_key
          FROM credit_notes
          WHERE tenant_id = ${tenantId}
            AND credit_note_id = ANY(${uuidArray(ids.creditNoteIds)})
        `)) as unknown as ReadonlyArray<{ pdf_blob_key: string | null }>;
        for (const r of rows) if (r.pdf_blob_key) keys.add(r.pdf_blob_key);
      }
      return keys;
    },
  };
}
