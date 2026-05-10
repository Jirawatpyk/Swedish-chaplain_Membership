# F8 Full-scope Error-Handling Review — R5 (2026-05-10)

**Reviewer**: error-handling auditor
**Branch**: `011-renewal-reminders` vs `main`
**Scope**: 624 changed files; focus on Phase 10 batched-write refactor (T262/T264), 4 cron coordinators, 9 DB tables, 64 audit event types, F1/F2/F3/F4/F5 cross-module bridges.
**Method**: read-only inspection of new bulk port methods + their callers, cron coordinators + per-tenant routes, F4/F5 callback bridges, F1 webhook hook, evaluate-tier-upgrade refactor, dispatch-one-cycle decision tree.

---

## Findings (8)

### F1 — `evaluateTierUpgrade` outerTx path commits inserts when bulk-emit fails — Constitution Principle VIII state↔audit atomicity violation
**Severity**: BLOCKER
**File**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:407-425, 469-476` + `src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts:77-94`

`flushPage()` runs `bulkInsertOpenIfAbsent(tx, ...)` then `auditEmitter.bulkEmitInTx(tx, ...)` inside the **caller-supplied `outerTx`**. When `bulkEmitInTx` throws, the `try/catch` at line 415-425 returns `{ serverError: ... }` rather than re-throwing. The outer loop returns `err(flushResult.serverError)` on line 475. The route handler's `runInTenant` (route.ts:77) sees a returned `Result` (NOT a thrown exception) so the transaction COMMITS. Result: `tier_upgrade_suggestions` rows are persisted with NO accompanying `tier_upgrade_suggested` audit event — exactly the state↔audit atomicity break that Constitution Principle VIII prohibits and that v1.4.0 promotes to a Review-Gate blocker.

The same hazard applies for the `bulkInsertOpenIfAbsent` throw at line 374-384 (server_error returned, not thrown) when the THROW happens AFTER a prior page already inserted+audited successfully — the prior page's writes commit, current page lost, route logs `evaluate_failed` while half the work is durably committed.

**Hidden errors**: `AuditEmitError` from `pgEnum` drift (the audit-emitter swallows DB faults but RAISES on enum mismatch — see `f2-plan-change-bridge.ts:42-50`); ECONNRESET mid-emit; serialization failures.

**User impact**: Forensic audit chain has gaps the next admin investigation cannot fill — "We see suggestions appear, but no `tier_upgrade_suggested` audit row." Next cron pass will skip these member rows via `member_open_uniq`, so the missing audit can never be re-emitted automatically.

**Recommendation**: Inside `flushPage`, when `bulkInsertOpenIfAbsent` or `bulkEmitInTx` throws, RE-THROW (do not return `serverError`). Let the route's outer `runInTenant` see the throw and roll back the tx. The aggregate counter increment at `evaluate-tier-upgrade.ts:431` should also move INSIDE the success branch only after re-throw safety is in place. Add an integration test: `bulkEmitInTx` rejects → assert tx rollback + zero `tier_upgrade_suggestions` rows visible.

```typescript
// CORRECT
try {
  await deps.auditEmitter.bulkEmitInTx(tx, auditEvents, {...});
} catch (e) {
  // Principle VIII: throw to roll back the tx-shared inserts.
  logger.error({ err: e, tenantId, page: pageDecisions.length }, '...');
  throw e;
}
```

---

### F2 — `bulkInsertOpenIfAbsent` uses `onConflictDoNothing()` with NO target — silently swallows PK collisions
**Severity**: HIGH
**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts:541-552`

The author's own comment admits the design hazard: "Conflict target is the partial unique index. Drizzle's `onConflictDoNothing` without a target argument relies on any unique constraint hitting … So a conflict here ALWAYS means the partial unique fired." This is FALSE in defensive terms — it only holds **today**. The `tier_upgrade_suggestions` table has a PK on `suggestion_id`. If a UUIDv4 collision ever fires (cosmically rare but possible), the row is silently dropped and counted as `conflicted` (= "member already had open suggestion") — which is an entirely different operational meaning than "PK collision". A future migration that adds another partial UNIQUE would also be silently absorbed.

**Hidden errors**: PK collision on `suggestion_id`; future unique-index additions; FK constraint violations on `member_id` / `from_plan_id` / `to_plan_id` (PG raises 23503, not 23505 — actually surfaces fine, but the comment misleads future maintainers).

**Recommendation**: Pin the conflict target explicitly:
```typescript
.onConflictDoNothing({
  target: [tierUpgradeSuggestions.tenantId, tierUpgradeSuggestions.memberId],
  targetWhere: sql`status IN ('open','accepted_pending_apply')`,
})
```
If Drizzle's `targetWhere` doesn't accept partial-index targets directly, fall back to raw SQL. Without the explicit target, the comment lies and a future PK-collision incident silently corrupts the `conflictSkipped` counter.

---

### F3 — `bulkTransitionToSent` and `bulkInsertIfAbsent` are dead code (zero callers) — bit-rot risk
**Severity**: HIGH
**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:330-425` + `src/modules/renewals/application/ports/renewal-reminder-event-repo.ts:138-169`

Commit `2caa8d74` shipped these two bulk methods on the port + adapter as "T262 batched-write infrastructure" but the actual dispatch path (`src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts`) still uses single-row `insertIfAbsent` + `transitionStatus`. `grep` confirms zero callers in `src/`. The methods are tested at the adapter level but never exercised end-to-end.

**Hidden errors that would surface only when wired up**:
1. `bulkTransitionToSent` returns the `updated` rows but does NOT verify `updated.length === inputs.length`. A row whose status is no longer `pending` (concurrently transitioned by retry pass / defensive cleanup) is silently dropped from the result — caller has no way to detect partial success.
2. The CASE-expression UPDATE at line 410-416 has a subtle hazard: if `inputs` contains a `reminderEventId` whose row does not exist OR is not `pending`, the matching CASE branches still build but no row updates — the unmatched input is invisibly lost.
3. `bulkInsertIfAbsent` always uses `tenant.slug` (closed-over) regardless of `input.tenantId`. The input field is silently ignored. A caller who passes a different tenant id finds their data written under the closure's tenant — a Constitution Principle I cross-tenant hazard waiting for the first wire-up.

**Recommendation**: EITHER wire these into `dispatch-one-cycle.ts` BEFORE merge (closing the original perf goal) OR delete them with a clear deferral note. Shipping unused infrastructure is bit-rot bait — six months from now someone will wire them up assuming they're hardened.

If keeping: add `if (updated.length !== inputs.length) throw new BulkTransitionPartialFailure(...)` and remove the `tenantId` field from `NewReminderEventInput` to make the ignored-field contract explicit.

---

### F4 — F1 Resend-webhook bounce hook returns 200 on ANY `detectBounceThreshold` failure — FR-012a silently broken until SRE catches up via metric
**Severity**: HIGH
**File**: `src/app/api/webhooks/resend/route.ts:283-317`

The catch block at line 295 swallows EVERY error from `lookupMemberByEmail` + `detectBounceThreshold` and returns 200 to Resend. Comments correctly note this prevents Resend retry storms. BUT:
- The `tenantId` label on the `bounceHookFailed` metric falls back to `null` when `lookupMemberByEmail` itself throws (line 315) — operators lose tenant attribution exactly when they need it most.
- DB connectivity failure inside `lookupMemberByEmail` is INDISTINGUISHABLE from "email not in members table" (the latter returns `null` from the lookup and skips the call entirely without bumping any metric).
- No alert rule documented for `bounceHookFailed` (POST-MVP-OBS-7 backlog deferral applies here too).

**Hidden errors**: Postgres connection pool exhaustion; `setEmailUnverified` timing out; `auditEmitter` swallow-and-throw on enum drift. All go to a single counter labelled `tenant_id=null`.

**User impact**: Member's email keeps getting reminders despite hard-bouncing → Resend reputation score drops → eventually all chamber emails go to spam folder. Tenant-blind metric makes triage slow.

**Recommendation**: Distinguish `lookupMemberByEmail` failure (DB-layer) from `detectBounceThreshold` failure (Application-layer) with two separate try/catch blocks and two separate metric labels. When `lookupMemberByEmail` returns `null` for a known-managed Resend message, increment a distinct `bounceHookMemberNotFound` counter so "email not under management" doesn't drown out infra failures.

---

### F5 — `f2-plan-change-bridge.wrapListener` swallow contract has no functioning alert pipeline (POST-MVP-OBS-7 deferred)
**Severity**: HIGH
**File**: `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts:77-97` + file-level docstring lines 38-50

The bridge documents the swallow rationale clearly: F2 plan-flip is source of truth, F8 bookkeeping must not roll back F2's tx. The metric `manualPlanChangeListenerFailed{listener,tenant_id}` IS bumped on swallow. **But the docstring itself admits**: "Vercel alert rule + on-call runbook + admin replay tooling are tracked as backlog item POST-MVP-OBS-7 … Until that lands, on-call must grep both metrics on Vercel dashboards manually."

This means in production today: F2 plan change → F8 supersede listener fails silently → orphan `accepted_pending_apply` row attached to a now-stale plan → reconcile cron does NOT touch it (only handles cancelled/lapsed cycles, not plan-diverged) → admin's next "Accept Tier Upgrade" attempt rejects with `member_open_uniq` conflict → admin experiences impossible state with no in-app explanation.

**Hidden errors**: `pgEnum` drift on the `tier_upgrade_pending_superseded_by_manual_change` event type; `runInTenant` slug invariant violation propagating from misconfigured tenant context; F8 deps factory mid-instantiation throw.

**Recommendation**: Either (a) wire up POST-MVP-OBS-7 alert rule before merge (Vercel Cron → Sentry alert on `manualPlanChangeListenerFailed` rate > 0/15m), OR (b) extend the reconcile cron to detect plan-diverged orphans (the `listOrphanedPending` port already returns `'manual_plan_change'` orphan shape — wire it to `dismissed` with reason `orphan_member_plan_diverged` per port docstring lines 105-110, which appears to already be planned but not verified shipped).

---

### F6 — `compute-at-risk-score` audit-emit-fail catch has no metric counter — silent dropped audit rows compound across cron passes
**Severity**: MEDIUM
**File**: `src/modules/renewals/application/use-cases/compute-at-risk-score.ts:143-150` (and ~3 sister catch blocks at lines 211-220, 287-295)

Pattern: audit emit fails → `logger.warn` + continue. No `renewalsMetrics.<...>AuditEmitFailed` counter. The comment claims "next cron pass will retry" but the cron path is at-risk RECOMPUTE — the score IS recomputed but the `at_risk_skipped_below_min_tenure` audit was a one-off observability event, not a state change. There's no retry mechanism for the audit row itself; it's permanently lost.

The same pattern repeats in `evaluate-tier-upgrade.ts:230-235, 279-284, 515-524` for the three "tenant_disabled / no_thresholds / aggregate already_at_target" emits. All three are best-effort cron-pass observability events with no metric instrumentation on the swallow.

**Hidden errors**: pgEnum drift (audit-emitter raises on unknown event types); RLS context lost between emit calls; Sentry transport failure.

**User impact**: Dashboards showing "tier-upgrade evaluations performed" undercount silently when the audit emit happens to fail. SRE has no signal until they manually compare cron route logs vs audit_log row counts.

**Recommendation**: Wire each of these `logger.warn` swallows to a dedicated counter: `renewalsMetrics.bestEffortAuditEmitFailed{event_type, code_site}`. The counter increment can be done inside a single helper:

```typescript
function logAndCountAuditEmitFailure(
  err: unknown,
  ctx: { eventType: string; codeSite: string; tenantId: string },
): void {
  logger.warn({ err: err instanceof Error ? err : new Error(String(err)), ...ctx }, ...);
  renewalsMetrics.bestEffortAuditEmitFailed(ctx.eventType, ctx.codeSite);
}
```

---

### F7 — `dispatch-coordinator` `observeCycleStateGaugesForTenant` runs SEQUENTIALLY in a `for` loop — single slow tenant blocks gauge fan-out + per-tenant fault not isolated
**Severity**: MEDIUM
**File**: `src/app/api/cron/renewals/dispatch-coordinator/route.ts:477-480`

```typescript
for (const result of tenantsSucceededOrSkipped) {
  if (result.skipped) continue;
  await observeCycleStateGaugesForTenant(result.tenant_id);
}
```

The helper itself is correctly try/catch-wrapped, but the awaited-in-loop pattern means a tenant whose RLS context setup hangs (e.g., advisory-lock contention with another long-running query) blocks ALL subsequent tenants' gauge observations. With MVP single-tenant this is a non-issue, but the file's stated post-F10 SaaS posture means this IS a latent fault-isolation gap.

**Recommendation**: Convert to `Promise.allSettled` with the same per-tenant try/catch already in `observeCycleStateGaugesForTenant`:
```typescript
await Promise.allSettled(
  tenantsSucceededOrSkipped
    .filter((r) => !r.skipped)
    .map((r) => observeCycleStateGaugesForTenant(r.tenant_id)),
);
```

---

### F8 — `mark-cycle-complete-from-invoice-paid` has documented eventual-consistency window via `markCycleCompleteFromInvoicePaid` standalone wrapper; only `markCycleCompleteInTx` should be used in production callbacks
**Severity**: MEDIUM
**File**: `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts:177-182` + docstring lines 15-37

The use-case correctly exports both `markCycleCompleteInTx` (atomic with F4 tx — the right path) and `markCycleCompleteFromInvoicePaid` (standalone, opens its own tx — the eventually-consistent path). The docstring honestly documents the consistency window but does not lint-block usage of the standalone variant in F4 callback contexts. A future contributor wiring a new F4 invoice type may pick the wrong wrapper. The grep confirms `record-payment.ts` is a caller of the apply-pending-tier-upgrade callback — would benefit from a similar lint or runtime gate.

**Hidden errors**: F8 commits (audit + cycle transition) → F4 tx subsequently rolls back for unrelated reason → durable F8 audit chain has `renewal_completed` for an invoice F4 will never finalize.

**Recommendation**: Add a JSDoc `@deprecated` tag on `markCycleCompleteFromInvoicePaid` urging `markCycleCompleteInTx` for all F4 callback paths, OR rename the standalone variant `markCycleCompleteStandaloneEventuallyConsistent` so the foot-gun is loud at the callsite. Add an integration test exercising the F4 rollback-after-F8-commit edge case to confirm the documented invariant ("F8 throw → F4 rollback") still holds across the use-case's lifetime.

---

## Summary — by severity

| Severity | Count | Findings |
|----------|-------|----------|
| BLOCKER  | 1     | F1 — outerTx commits without audit on emit failure (Principle VIII) |
| HIGH     | 4     | F2 — onConflictDoNothing target ambiguity; F3 — dead bulk methods bit-rot; F4 — webhook bounce-hook tenant-label loss; F5 — F2 plan-change swallow has no live alert |
| MEDIUM   | 3     | F6 — compute-at-risk audit swallow no metric; F7 — gauge loop sequential; F8 — standalone wrapper foot-gun |

## Recommended pre-merge actions (priority order)

1. **F1** must close before merge. The fix is ~5 lines (re-throw inside flushPage catches, drop returned `serverError` shape) plus an integration test asserting tx rollback.
2. **F3** decide: wire `bulkInsertIfAbsent`/`bulkTransitionToSent` into `dispatch-one-cycle.ts` (closes the original T262 perf goal AND makes the partial-update bug surface in tests) OR delete with a TODO note. Shipping infrastructure with no callers is the worst of both worlds.
3. **F2** add explicit `target` to `onConflictDoNothing` — single-line fix, removes the misleading comment, future-proofs against new unique constraints.
4. **F4** split the webhook catch into two with distinct metric labels — ~10 lines, improves SRE triage materially.
5. **F5** verify `listOrphanedPending` is wired into `reconcile-pending-applications` for the `'manual_plan_change'` orphan shape (port docstring at `tier-upgrade-suggestion-repo.ts:99-119` says it should be — needs confirmation).
6. **F6, F7, F8** can defer to a post-merge follow-up if F1 is the gating concern, but F6 in particular is a low-cost win for observability.

## Files inspected (load-bearing for findings)

- `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts` (F1)
- `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts` (F1, F2)
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts` (F3)
- `src/modules/renewals/application/ports/renewal-reminder-event-repo.ts` (F3)
- `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts` (F3 confirmation)
- `src/app/api/webhooks/resend/route.ts` (F4)
- `src/modules/renewals/application/use-cases/detect-bounce-threshold.ts` (F4)
- `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts` (F5)
- `src/modules/renewals/application/use-cases/supersede-pending-tier-upgrade.ts` (F5)
- `src/modules/renewals/application/use-cases/compute-at-risk-score.ts` (F6)
- `src/app/api/cron/renewals/dispatch-coordinator/route.ts` (F7)
- `src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts` (F1 caller)
- `src/app/api/cron/renewals/dispatch/[tenantId]/route.ts` (sibling pattern reference, no findings)
- `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` (F8)
- `src/modules/renewals/application/use-cases/admin-reject-reactivation.ts` (audit pattern reference, no findings — well-engineered)
- `src/modules/renewals/application/use-cases/cancel-in-flight-cycles-for-member.ts` (audit pattern reference, no findings — well-engineered)
- `src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts` (per-cycle isolation reference, no findings)
- `src/modules/renewals/infrastructure/_lib/apply-tier-upgrade-on-paid-callback.ts` (F4 callback reference, no findings — correctly throws)
- `src/lib/db.ts` (`runInTenant` semantics confirmation for F1)

## What looks good (worth calling out)

- `cancel-in-flight-cycles-for-member.ts` — the typed `AuditEmitError` discriminator + outer-catch defense-in-depth (line 487-510) is a model for how Principle VIII compliance should look. Use this as the reference pattern for fixing F1.
- `apply-tier-upgrade-on-paid-callback.ts` — the `INVALID_TX` fallback metric + `tier_upgrade_apply_post_invoice_paid_failed` audit emit on the F4-already-committed branch is exactly the right level of paranoia for a cross-module callback.
- `lapse-cycles-on-grace-expiry.ts` — the exhaustive switch with `_exhaustive: never` pin (line 182-186) PLUS the per-cycle try/catch fault isolation is textbook cron design.
- `defensivelyMarkFailedForRetry` in `dispatch-one-cycle.ts:618-726` — explicit "best-effort cleanup" contract with the eventual-permanent-failure backstop, plus the `ReminderEventNotFoundError` idempotency branch, is well-documented and tested.

The codebase is generally above the bar; F1 is the lone hard blocker, the rest are tightening calls.
