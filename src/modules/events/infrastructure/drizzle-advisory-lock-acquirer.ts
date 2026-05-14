/**
 * T085 — Drizzle adapter for `AdvisoryLockAcquirer` (F6 Infrastructure).
 *
 * Implements the port via `pg_advisory_xact_lock(hashtextextended(_, 0))`
 * on the tx-bound executor. Lock auto-releases at COMMIT or ROLLBACK
 * (per Postgres advisory-lock semantics — no explicit release needed).
 *
 * Mirrors the F8 precedent at
 * `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo.ts:628`
 * and the F6 secret-rotate precedent at
 * `drizzle-tenant-webhook-config-repository.ts:151`.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { AdvisoryLockAcquirer } from '../application/ports/advisory-lock-acquirer';

export function makeDrizzleAdvisoryLockAcquirer(
  executor: TenantTx,
): AdvisoryLockAcquirer {
  return {
    async acquire(lockKey: string): Promise<void> {
      await executor.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
    },
  };
}
