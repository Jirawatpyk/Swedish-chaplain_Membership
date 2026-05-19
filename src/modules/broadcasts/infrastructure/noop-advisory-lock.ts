/**
 * Stub `AdvisoryLockPort` — always returns `{acquired: true}`.
 *
 * **Used ONLY by `dispatchBroadcastBatch` (T045)** where a proper
 * `withTx` refactor is out of scope: the use case orchestrates
 * long-running external Resend gateway calls (createAudience →
 * addContactsToAudience → createBroadcast → sendBroadcast) which
 * cannot sit inside a held Postgres tx — doing so would starve the
 * connection pool + risk retry-storm cascades.
 *
 * Per-batch dispatch race is mitigated by:
 *   1. cron-job.org tick spacing (5 min between dispatch-batches ticks)
 *   2. T055 eligible-row scan uses `FOR UPDATE SKIP LOCKED` (Phase 3F.4)
 *   3. Idempotency key on the unique index — duplicate-attempt INSERT
 *      rejected by the `broadcast_batch_manifests_idempotency_key_uniq`
 *      partial index
 *
 * **All other AdvisoryLockPort callers MUST use `pgAdvisoryLockAdapter`**.
 * T047 retryFailedBatches uses the real adapter via `broadcasts.withTx`
 * (Phase 3E.1 production hardening).
 *
 * Phase 3E 2026-05-19 signature aligned to `acquire(tx, lockKey)`; the
 * stub ignores tx because no tx-scoped lock is acquired.
 */
import type {
  AdvisoryLockPort,
  TxToken,
} from '../application/ports/advisory-lock-port';

export const noOpAdvisoryLock: AdvisoryLockPort = {
  // Phase 3F.11.6 — signature widened to `TxToken | null` per port
  // contract. Stub ignores both args (no tx-scoped lock acquired).
  async acquire(_tx: TxToken | null, _lockKey: string) {
    return { acquired: true };
  },
};
