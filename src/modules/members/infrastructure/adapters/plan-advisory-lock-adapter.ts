/**
 * W0-02 — Drizzle adapter for `PlanAdvisoryLockPort` (members Infrastructure).
 *
 * Implements the port via `pg_advisory_xact_lock(hashtextextended(key, 0))`
 * on the tx-bound executor. The lock auto-releases at COMMIT or ROLLBACK
 * (Postgres `pg_advisory_xact_lock` semantics — no explicit release needed).
 *
 * Mirrors the F6 pattern at
 * `src/modules/events/infrastructure/drizzle-advisory-lock-acquirer.ts`
 * and the F4/F5/F7/F8 inline `tx.execute(sql\`...\`)` precedents.
 *
 * The `tx` parameter is typed `unknown` in the Application port (to keep
 * the port free of Drizzle imports) and cast here via `unbrandTx` which
 * performs an `as unknown as TenantTx` double-cast — the identical escape
 * hatch documented in `src/lib/db.ts:113-130`.
 */
import { sql } from 'drizzle-orm';
import { unbrandTx } from '@/lib/db';
import type { PlanAdvisoryLockPort } from '../../application/ports/plan-advisory-lock-port';

export const drizzlePlanAdvisoryLockAdapter: PlanAdvisoryLockPort = {
  async acquire(tx: unknown, lockKey: string): Promise<void> {
    const typedTx = unbrandTx(tx);
    await typedTx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
  },
};
