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
 * Retry (amended 2026-04-19): deadlock retry belongs at the caller's
 * `withTx` scope, not inside this function. See the inline comment
 * below for the rationale.
 */
import { sql } from 'drizzle-orm';
import type {
  SequenceAllocatorPort,
  DocumentTypeCode,
} from '../../application/ports/sequence-allocator-port';
import type { FiscalYear } from '../../domain/value-objects/fiscal-year';
import type { TenantTx } from '@/lib/db';

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
    // when `app.current_tenant` is not set for this tenant; in prod
    // we skip the round-trip (RLS still enforces tenant scoping and
    // this check would add ~1ms per issuance). Operators can opt in
    // for production by setting `DEBUG_RLS_STATE=true` in Vercel env —
    // useful when investigating a suspected RLS bypass without a
    // code deploy.
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

    // Post-review 2026-04-19 agent finding — the previous retry loop
    // sat INSIDE the caller-supplied transaction. On 40P01 (deadlock),
    // Postgres auto-aborts the whole transaction; every subsequent
    // statement from this loop would then return `25P02 current
    // transaction is aborted, commands ignored until end of transaction
    // block` and the loop eventually threw a misleading "exceeded
    // MAX_RETRIES" error, masking the real deadlock.
    //
    // The correct retry scope for deadlocks is the caller's `withTx`
    // wrapper, which can start a fresh transaction. Keeping a
    // "retry" in this in-tx code path was fake safety.
    //
    // With the advisory-lock scope being `(tenant, document_type,
    // fiscal_year)` + `pg_advisory_xact_lock` (exclusive, auto-released
    // on commit/rollback), real contention between two concurrent
    // issue-invoice calls is already serialised by the advisory lock —
    // the allocator itself cannot deadlock against another allocator
    // on the same tuple. A cross-resource deadlock (e.g. with
    // `members_fkey` during `apply-member-registration-fee-paid`) is
    // the only remaining path; if it ever fires, the caller's
    // `withTx` must be the retry owner.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    await tx.execute(sql`
      INSERT INTO tenant_document_sequences
        (tenant_id, document_type, fiscal_year, next_sequence_number)
      VALUES
        (${input.tenantId}, ${input.documentType}::document_type, ${input.fiscalYear}, 1)
      ON CONFLICT (tenant_id, document_type, fiscal_year) DO NOTHING
    `);

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

    await tx.execute(sql`
      UPDATE tenant_document_sequences
         SET next_sequence_number = next_sequence_number + 1,
             updated_at = now()
       WHERE tenant_id = ${input.tenantId}
         AND document_type = ${input.documentType}::document_type
         AND fiscal_year = ${input.fiscalYear}
    `);

    return assigned;
  },
};
