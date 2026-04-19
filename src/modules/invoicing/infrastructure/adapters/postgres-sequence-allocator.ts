/**
 * T041 — Postgres sequential-number allocator (F4).
 *
 * Protocol (data-model.md § 2.5):
 *   1. pg_advisory_xact_lock(hashtext('invoicing:{tenant}:{type}:{fy}'))
 *   2. INSERT ... ON CONFLICT DO NOTHING (bootstrap first use)
 *   3. SELECT ... FOR UPDATE
 *   4. UPDATE next_sequence_number += 1
 *   5. Return the pre-increment value (what we just "took")
 *
 * Retry: on `deadlock_detected` or serialization failure, retry up to
 * 3× with exponential back-off.
 */
import { sql } from 'drizzle-orm';
import type {
  SequenceAllocatorPort,
  DocumentTypeCode,
} from '../../application/ports/sequence-allocator-port';
import type { FiscalYear } from '../../domain/value-objects/fiscal-year';
import type { TenantTx } from '@/lib/db';

const MAX_RETRIES = 3;

export const postgresSequenceAllocator: SequenceAllocatorPort = {
  async allocateNext(
    txUnknown: unknown,
    input: {
      readonly tenantId: string;
      readonly documentType: DocumentTypeCode;
      readonly fiscalYear: FiscalYear;
    },
  ): Promise<number> {
    const tx = txUnknown as TenantTx;

    // Belt-and-suspenders tenant-context assertion. A caller that
    // accidentally hands us a bare `db` (non-tenant connection) would
    // advisory-lock fine but bypass RLS. In dev / test we hard-fail
    // when `app.current_tenant` is not set for this tenant; in prod we
    // skip the round-trip (RLS still enforces tenant scoping and this
    // check would add ~1ms per issuance).
    if (process.env.NODE_ENV !== 'production' || process.env.DEBUG_RLS_STATE === 'true') {
      const ctxRows = (await tx.execute(
        sql`SELECT current_setting('app.current_tenant', TRUE) AS ctx`,
      )) as unknown as Array<{ ctx: string | null }>;
      const ctx = ctxRows[0]?.ctx ?? null;
      if (ctx !== input.tenantId) {
        throw new Error(
          `postgresSequenceAllocator: tenant-context mismatch — expected=${input.tenantId}, got=${ctx}. ` +
            'Caller must run inside runInTenant(ctx, …).',
        );
      }
    }

    const lockKey = `invoicing:${input.tenantId}:${input.documentType}:${input.fiscalYear}`;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 1. Advisory lock — fingerprint the stream name to a bigint.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

        // 2. Bootstrap row if absent.
        await tx.execute(sql`
          INSERT INTO tenant_document_sequences
            (tenant_id, document_type, fiscal_year, next_sequence_number)
          VALUES
            (${input.tenantId}, ${input.documentType}::document_type, ${input.fiscalYear}, 1)
          ON CONFLICT (tenant_id, document_type, fiscal_year) DO NOTHING
        `);

        // 3. Read + lock current value.
        const rows = (await tx.execute(sql`
          SELECT next_sequence_number
            FROM tenant_document_sequences
           WHERE tenant_id = ${input.tenantId}
             AND document_type = ${input.documentType}::document_type
             AND fiscal_year = ${input.fiscalYear}
             FOR UPDATE
        `)) as unknown as Array<{ next_sequence_number: number }>;
        if (!rows[0]) {
          throw new Error(
            `postgresSequenceAllocator: missing row after ON CONFLICT — ${lockKey}`,
          );
        }
        const assigned = rows[0].next_sequence_number;

        // 4. Increment — caller will COMMIT with the allocation.
        await tx.execute(sql`
          UPDATE tenant_document_sequences
             SET next_sequence_number = next_sequence_number + 1,
                 updated_at = now()
           WHERE tenant_id = ${input.tenantId}
             AND document_type = ${input.documentType}::document_type
             AND fiscal_year = ${input.fiscalYear}
        `);

        return assigned;
      } catch (e) {
        lastError = e;
        // Retry on deadlock / serialization failure only.
        const code = (e as { code?: string })?.code;
        if (code !== '40P01' && code !== '40001') throw e;
        const backoffMs = 25 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw new Error(
      `postgresSequenceAllocator: exceeded ${MAX_RETRIES} retries: ${String(lastError)}`,
    );
  },
};
