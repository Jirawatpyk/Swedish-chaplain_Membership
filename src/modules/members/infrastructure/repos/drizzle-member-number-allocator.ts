/**
 * 055-member-number — Postgres member-number allocator.
 *
 * Protocol (design §5):
 *   1. pg_advisory_xact_lock(hashtextextended('members:'||$tenantId, 0))
 *        — 64-bit (F5–F9 convention). `members:` is disjoint from
 *          `invoicing:` / `payments:` / `broadcasts:` so no cross-stream
 *          contention.
 *   2. INSERT … ON CONFLICT DO NOTHING — seed the counter on first use.
 *   3. UPDATE … SET last_number = last_number + 1 … RETURNING last_number.
 *        The advisory lock already serialises every writer, so — unlike
 *        the F4 sequence allocator — there is NO `SELECT … FOR UPDATE`.
 *        DO NOT copy the F4 allocator verbatim.
 *
 * Lock-order discipline: this allocator touches ONLY
 * `tenant_member_sequences` — never `tenant_member_settings` (the prefix
 * is read at display time, not allocation time). Single-table lock graph
 * is trivially acyclic (mirrors the F4 allocator's lock-order rule).
 *
 * MUST run inside the caller's `runInTenant(tenant, tx)` scope — see the
 * port doc-comment. The dev-mode assertion below hard-fails if handed a
 * non-tenant-scoped tx.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { MemberNumberAllocatorPort } from '../../application/ports/member-number-allocator-port';
import type { TenantId } from '../../domain/member';
import {
  asMemberNumber,
  type MemberNumber,
} from '../../domain/value-objects/member-number';

export const drizzleMemberNumberAllocator: MemberNumberAllocatorPort = {
  async allocate(tx: TenantTx, tenantId: TenantId): Promise<MemberNumber> {
    // Belt-and-suspenders tenant-context assertion (mirrors
    // postgres-sequence-allocator.ts:57-68). A caller that accidentally
    // hands a bare `db` would advisory-lock fine but bypass RLS. Hard-fail
    // in dev/test; skip the round-trip in prod unless DEBUG_RLS_STATE=true.
    if (
      process.env.NODE_ENV !== 'production' ||
      process.env.DEBUG_RLS_STATE === 'true'
    ) {
      const ctxRows = (await tx.execute(
        sql`SELECT current_setting('app.current_tenant', TRUE) AS ctx`,
      )) as unknown as Array<{ ctx: string | null }>;
      const ctx = ctxRows[0]?.ctx ?? null;
      if (ctx !== tenantId) {
        throw new Error(
          `drizzleMemberNumberAllocator: tenant-context mismatch — expected=${tenantId}, got=${ctx}. ` +
            'Caller must run inside runInTenant(ctx, …).',
        );
      }
    }

    const lockKey = `members:${tenantId}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );

    await tx.execute(sql`
      INSERT INTO tenant_member_sequences (tenant_id, last_number)
      VALUES (${tenantId}, 0)
      ON CONFLICT (tenant_id) DO NOTHING
    `);

    const rows = (await tx.execute(sql`
      UPDATE tenant_member_sequences
         SET last_number = last_number + 1,
             updated_at  = now()
       WHERE tenant_id = ${tenantId}
       RETURNING last_number
    `)) as unknown as Array<{ last_number: number }>;

    const allocated = rows[0]?.last_number;
    if (allocated === undefined) {
      throw new Error(
        `drizzleMemberNumberAllocator: missing row after seed+update — members:${tenantId}`,
      );
    }
    return asMemberNumber(allocated);
  },
};
