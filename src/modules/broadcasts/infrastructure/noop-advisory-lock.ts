/**
 * Phase 3 Cluster 3C.1 (2026-05-19) — STUB `AdvisoryLockPort` adapter.
 * Cluster 3D.5 (2026-05-19) — accepted-tradeoff for MVP launch.
 *
 * ⚠️ NOT a production-grade SC-007 implementation. This adapter
 * always returns `{acquired: true}`. Concurrent admin retries
 * (T035 race) are NOT actually serialised by this adapter.
 *
 * **3D.5 closure decision (Phase 3D)**: After evaluating three
 * candidate hardenings, all were rejected for the MVP launch:
 *
 *   A. **Session-scope `pg_try_advisory_lock`** — Neon HTTP driver
 *      treats each query as a fresh session, so the lock releases
 *      immediately at query end. Zero protection. REJECTED.
 *
 *   B. **Self-managed mini-tx with `pg_try_advisory_xact_lock`** —
 *      lock releases at the inner tx commit, which is immediately
 *      after `acquire()` returns. Zero protection across the rest
 *      of the use-case body (multiple sequential repo calls each
 *      with their own runInTenant tx). REJECTED.
 *
 *   C. **Held-tx pattern (`db.transaction(async tx => …)` with
 *      external resolve)** — keeps the tx open via a Map<lockKey,
 *      releaseFn> closure. Real lock-hold semantics, BUT fragile:
 *      forgotten release leaks the tx + the connection until the
 *      Vercel function exits (max 300s). Also: the existing T033/
 *      T035 contract test mocks would need to thread `tx` as a
 *      first parameter, breaking 18/18 GREEN. REJECTED for MVP.
 *
 *   D. **Full `withTx<T>(fn)` refactor on `BroadcastsRetryRepo`**
 *      — proper Clean Architecture solution. T047 retry use-case
 *      opens one tx, threads it through every port method + lock
 *      acquire. Lock holds for the entire use-case body, auto-
 *      releases at outer commit. SHIPPABLE but requires test fixture
 *      updates (add `withTx` stub to T033/T035 mocks; thread `tx`
 *      as port-method first arg in 9 unit + 5 application + 12
 *      drizzle-broadcasts tests). Estimated 2-3 sessions to land
 *      cleanly + verify all related tests. DEFERRED to Phase 3E
 *      hardening cycle post-MVP-ship.
 *
 * **MVP risk mitigation (THREE-LAYER DEFENCE)**:
 *
 *   1. **UI-level guard** (T053 retry-confirmation-dialog.tsx):
 *      Submit button disabled on first click via `useTransition`
 *      pending; spinner replaces label. Admin cannot double-click
 *      the same dialog instance to trigger 2 concurrent requests.
 *
 *   2. **DB CHECK constraint** (migration 0163):
 *      `manual_retry_count BETWEEN 0 AND 3` enforced at the row
 *      level. If two concurrent admin requests somehow bypass the
 *      UI guard (e.g. two browser tabs), the DB row-lock during
 *      `incrementManualRetryCount` UPDATE serialises; on the 4th
 *      attempt the WHERE clause `manual_retry_count < 3` matches
 *      0 rows + adapter returns `check_violation` → use-case
 *      surfaces MANUAL_RETRY_BUDGET_EXHAUSTED (not the SC-007-
 *      preferred ALREADY_RETRYING_IN_PROGRESS, but the budget IS
 *      bounded — the worst case is the same budget consumed at most
 *      3 times, never more).
 *
 *   3. **Operational** (deferred to ship-day operator checklist):
 *      Cron-job.org dashboard surfaces the `broadcast_retry_initiated`
 *      audit-event rate. If two retries fire within 1 second on the
 *      same broadcastId, the on-call gets a Slack alert.
 *
 * The combined three-layer mitigation provides PRACTICAL SC-007
 * safety for the SweCham MVP's admin team (1-2 active admins; no
 * realistic double-tab concurrency in operational use). Phase 3E
 * proper-fix tracking ticket created at retro time.
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
  // Phase 3E 2026-05-19: signature updated to match the hardened
  // `AdvisoryLockPort.acquire(tx, lockKey)` shape. The stub still
  // ignores tx — kept ONLY for T045 `dispatchBroadcastBatch` wiring
  // where a withTx refactor is OUT OF SCOPE (long-running Resend
  // gateway calls cannot sit inside a held DB tx). T045's per-batch
  // race is mitigated by cron-job.org tick spacing + FOR UPDATE SKIP
  // LOCKED in T055 eligible-row scan.
  async acquire(_tx: unknown, _lockKey: string) {
    return { acquired: true };
  },
};
