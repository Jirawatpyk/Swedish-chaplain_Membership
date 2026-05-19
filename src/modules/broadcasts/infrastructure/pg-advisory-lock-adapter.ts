/**
 * Phase 3E (2026-05-19) — production `AdvisoryLockPort` Drizzle adapter.
 *
 * Replaces the Phase 3C.1 `noOpAdvisoryLock` stub. Uses
 * `pg_try_advisory_xact_lock(hashtextextended($1, 0))` inside the
 * caller's transaction so the lock auto-releases at commit/rollback.
 * For correct SC-007 semantics, the CALLER must hold its tx open
 * across every mutation that depends on the lock — T047
 * `retryFailedBatches` wraps its entire body in
 * `deps.broadcasts.withTx(async tx => …)` and threads the tx
 * through both `advisoryLock.acquire(tx, lockKey)` AND every other
 * port call (`findById`, `incrementManualRetryCount`,
 * `batchManifests.findByBroadcast`, `batchManifests.updateStatus`,
 * `audit.emit(tx, …)`). Postgres-js TCP pool keeps the single tx
 * on one connection for the entire scope — the advisory lock thus
 * holds across all the port calls inside the withTx.
 *
 * Why tx-scope over session-scope:
 *   - Tx-scope releases on commit OR rollback — no leak on uncaught
 *     exception
 *   - Session-scope (pg_try_advisory_lock without _xact) would need
 *     explicit pg_advisory_unlock + reservation of the connection
 *     across queries — too fragile under postgres-js pool model
 *
 * Pure interface impl — no module-level state. Safe to import as a
 * singleton (the impl reads tx from the caller, not from a ref).
 */
import { sql } from 'drizzle-orm';
import type {
  AcquireResult,
  AdvisoryLockPort,
} from '../application/ports/advisory-lock-port';
import type { TenantTx } from '@/lib/db';

export const pgAdvisoryLockAdapter: AdvisoryLockPort = {
  async acquire(txUnknown: unknown, lockKey: string): Promise<AcquireResult> {
    if (txUnknown === undefined || txUnknown === null) {
      throw new Error(
        'pgAdvisoryLockAdapter.acquire requires a tx argument — caller MUST wrap in withTx scope so the lock is held across the dependent mutations',
      );
    }
    const tx = txUnknown as TenantTx;
    const result = (await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
    )) as unknown as Array<{ acquired: boolean }>;
    return { acquired: result[0]?.acquired === true };
  },
};
