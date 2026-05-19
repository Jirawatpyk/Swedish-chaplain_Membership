/**
 * Phase 3 Cluster 3C.1 (2026-05-19) — STUB `AdvisoryLockPort` adapter.
 *
 * ⚠️ NOT a production-grade SC-007 implementation. This adapter
 * always returns `{acquired: true}`. Concurrent admin retries
 * (T035 race) are NOT actually serialised by this adapter.
 *
 * Rationale:
 *   - Neon HTTP driver (production stack) cannot hold a session-scope
 *     advisory lock across multiple queries — each HTTP query is a
 *     fresh session, so `pg_try_advisory_lock` releases immediately.
 *   - `pg_try_advisory_xact_lock` works inside a single tx, but T047
 *     `retryFailedBatches` orchestrates multiple sequential repo
 *     calls each with their OWN `runInTenant` tx → the lock would
 *     release at the first inner tx commit (immediately after
 *     acquire), giving zero protection across the rest of the use
 *     case body.
 *
 * Phase 3 Cluster 3D hardening plan:
 *   - Refactor `BroadcastsRetryRepo` to expose `withTx<T>(fn)` so
 *     T047 wraps its entire body in one transaction.
 *   - Update `AdvisoryLockPort.acquire(tx, lockKey)` signature.
 *   - Drizzle impl: `pg_try_advisory_xact_lock` inside the shared tx
 *     → lock holds for the whole use case → releases at outer commit.
 *
 * Interim SC-007 mitigation:
 *   - UI-level: disable the "Retry failed batches" button immediately
 *     on click + show "Retrying…" with a spinner; admin cannot
 *     double-click in practice (T053 admin-retry-confirmation modal
 *     with `onSubmit` guard, Phase 3 Cluster 3D).
 *   - DB-level: `WHERE manual_retry_count < 3` clause in the
 *     `incrementManualRetryCount` UPDATE catches the budget exhaustion
 *     case — the 4th attempt fails with `check_violation` →
 *     MANUAL_RETRY_BUDGET_EXHAUSTED.
 *
 * Contract-test guarantee:
 *   - T033 + T034 + T035 contract tests use their OWN in-memory
 *     advisory-lock simulator (not this adapter). The tests verify
 *     T047's lock-key namespace + behavior under contention; the
 *     production stub here just satisfies the dependency injection
 *     contract.
 */
import type { AdvisoryLockPort } from '../application/ports/advisory-lock-port';

export const noOpAdvisoryLock: AdvisoryLockPort = {
  async acquire(_lockKey: string) {
    return { acquired: true };
  },
};
