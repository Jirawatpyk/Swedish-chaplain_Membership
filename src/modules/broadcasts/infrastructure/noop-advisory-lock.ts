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
 *   4. **Row-state guard is the load-bearing serialisation primitive**
 *      (H1+H2 closure 2026-05-21, code-reviewer-full review). The
 *      `pending → sending` transition in `batchManifests.updateStatus`
 *      uses `WHERE id = $1 AND status = $fromStatus` + `.returning()`.
 *      A concurrent dispatcher attempting the same per-batch transition
 *      after the first one wins sees `0 rows affected` → returns
 *      `invalid_state_transition` → use-case logs the loss but does
 *      NOT proceed to gateway call. This closes the race window even
 *      with `noOpAdvisoryLock`: the cron-job.org tick spacing reduces
 *      the chance of overlap, the FOR-UPDATE-SKIP-LOCKED reduces it
 *      further, the idempotency unique index catches duplicate Resend
 *      audience creates, and the row-state guard is the final
 *      backstop ensuring at-most-one gateway call per (broadcast,
 *      batch_index, attempt) tuple.
 *
 * **Why NOT wire `pgAdvisoryLockAdapter`**: the advisory lock would
 * need to be held across the gateway call (multiple seconds of
 * Resend HTTP latency). Holding a Postgres connection out of the
 * Neon pool that long under bursty cron load would risk pool
 * exhaustion + cascading "could not acquire connection" failures
 * across F1 auth + F3 members + F4 invoicing concurrent traffic.
 * The 4-layer defence (tick spacing + SKIP LOCKED + idempotency
 * unique + row-state guard) is sufficient and pool-safe. Documented
 * as accepted-residual per H1+H2 review closure.
 *
 * **All other AdvisoryLockPort callers MUST use `pgAdvisoryLockAdapter`**.
 * T047 retryFailedBatches uses the real adapter via `broadcasts.withTx`
 * (Phase 3E.1 production hardening) — that use-case's lock-hold
 * duration is ≤100ms (snapshot+increment+batch-update+audit), not
 * seconds of HTTP RTT, so pool-exhaustion risk does not apply there.
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
