# F8 R6 Round-2 — Error-Handling Audit (`88f6b8a2`)

**Branch**: `011-renewal-reminders` · **Scope**: verify R5 fixes (B1, C2, C3, S1, S2, S3) + scan for new silent failures introduced by R5 · **Constitution Principle VIII (Reliability)** focus

---

## Summary

| Severity | Count | Items |
| --- | --- | --- |
| BLOCKER | 0 | — |
| HIGH | 2 | H1, H2 |
| MEDIUM | 3 | M1, M2, M3 |
| LOW | 2 | L1, L2 |

**R5 fix verdicts**: B1 PASS · C2 PARTIAL (H1, H2) · C3 PASS · S1 PASS · S2 PASS · S3 PASS (docstring only).

---

## R5 Fix Verification

### B1 — `evaluate-tier-upgrade.ts` flushPage atomicity — **PASS**

`src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:374-394` (insert) and `:415-434` (audit emit) both correctly `throw new Error(..., {cause: e})`. The outer catch at `:489-494` converts back to `err({server_error})` and preserves the original cause via `(e as Error)?.message`. `runInTenant` rollback contract intact: any thrown error inside the closure aborts the BEGIN/COMMIT block. Stack chain preserved through `{cause: e}`.

The outer catch at `:489-494` is intentionally broad (it catches anything thrown inside `flushPage` OR from the synchronous `runInTenant` driver itself). That breadth is acceptable here — every error path inside `flushPage` is one we genuinely want to convert to `server_error` for the cron loop, and `runInTenant` cannot throw `flush_page_failed`-class business errors. **No regression.**

### C2 — Drizzle reminder-event repo bulk methods — **PARTIAL**

`bulkInsertIfAbsent` tenantId guard (lines 348-354): correct. Error message includes the offending value + adapter slug + Constitution principle reference — sufficient for SRE.

`bulkTransitionToSent` tenantId guard (lines 408-414): correct, symmetric.

**Row-count assertion at line 463-467 is mis-formed** — see H1 below.

### C3 — Resend webhook split catches — **PASS**

`src/app/api/webhooks/resend/route.ts:283-340` correctly splits into:
- `:293-310` lookup catch → emits `bounceHookFailed(null)` + early-returns 200 (no Resend retry storm).
- `:311-340` use-case catch → emits `bounceHookFailed(lookup.tenantId)` + falls through to the final 200.

DB lookup errors cannot accidentally enter the F8 use-case branch (early return). The final `return NextResponse.json({ ok: true }, { status: 200 })` at `:343` is reachable in all 3 paths (lookup failed, lookup empty, use-case threw OR succeeded) — Resend never sees 5xx. **No regression.**

### S1 — `compute-at-risk-score.ts` `atRiskAuditEmitFailed` counter — **PASS**

`src/modules/renewals/application/use-cases/compute-at-risk-score.ts:147-159`: `logger.warn(...)` and `renewalsMetrics.atRiskAuditEmitFailed(...)` both fire in the same catch arm. The counter is wrapped in `safeMetric()` (`src/lib/metrics.ts:1511`) so OTel SDK errors cannot themselves throw and cascade.

Counter signature `(auditType, tenantId)` matches the call site. Cardinality bounded (3 audit types × tenant slugs). **No regression.**

### S2 — Dispatch-coordinator `Promise.all` parallelization — **PASS**

`src/app/api/cron/renewals/dispatch-coordinator/route.ts:481-485` parallelizes with `Promise.all`. The helper `observeCycleStateGaugesForTenant` (`:53-102`) wraps its full body in try/catch and never re-throws. Therefore `Promise.all` cannot reject from a per-tenant failure. **No regression.**

### S3 — `mark-cycle-complete-from-invoice-paid.ts` foot-gun docstring — **PASS**

Lines 170-194: foot-gun warning is unambiguous, points to `markCycleCompleteInTx` for F4-callback contexts, and preserves the wrapper for non-F4 paths. No code change. Wrapper still safe for admin replays / tests.

---

## New / Pre-existing Findings

### H1 — `bulkTransitionToSent` row-count assertion has false-positive race window

**File/line**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:447-467`

The SELECT verification (`:448-456`) filters by `inArray(reminderEventId, ids) AND status='sent'`. It does NOT verify `dispatched_at` or `delivery_id` match the inputs. If a row was already in `status='sent'` from a prior concurrent race (e.g., admin "Send reminder now" pressed between the use-case's read and write), the UPDATE skips it (its WHERE clause requires `r.status='pending'`), but the SELECT still counts it. Result: `updatedRows.length === inputs.length` ✓ assertion passes ✗ row was NOT updated by us — a different `delivery_id` lands in the audit emit downstream.

**Hidden errors**: silent state↔audit drift exactly opposite of the C2 fix's intent. The audit row claims "we dispatched delivery_id=X" but the DB row has `delivery_id=Y` from the racing actor.

**Fix** (recommended):

```ts
const updatedRows = await txDb
  .select()
  .from(renewalReminderEvents)
  .where(
    and(
      inArray(renewalReminderEvents.reminderEventId, ids),
      eq(renewalReminderEvents.status, 'sent'),
      // Verify the UPDATE is OURS, not a racing actor's prior write.
      inArray(
        renewalReminderEvents.deliveryId,
        inputs.map((i) => i.deliveryId),
      ),
    ),
  );
```

Alternative cleaner fix: have the raw SQL UPDATE use `RETURNING *` and skip the second SELECT entirely (1 RTT instead of 2, eliminates the gap by construction).

### H2 — `bulkInsertOpenIfAbsent` missing tenantId guard (asymmetric vs C2 fix)

**File/line**: `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts:520-570`

The R5-C2 fix added tenantId guards to both `bulkInsertIfAbsent` and `bulkTransitionToSent` on the reminder-event repo. The symmetric tier-upgrade method `bulkInsertOpenIfAbsent` (line 520) uses `input.tenantId` directly in the INSERT VALUES (`:531`) with NO equivalent guard. Unlike the reminder-event method (which substitutes `tenant.slug`), this one trusts `input.tenantId` blindly. RLS provides defense-in-depth, but Constitution Principle I clause 1 mandates application-layer tenant filters too.

**Hidden errors**: a future caller passing mixed-tenant inputs would write rows with the wrong `tenant_id`, which RLS would only block if the runtime `app.current_tenant` doesn't match — and `runInTenant(deps.tenant, …)` sets that to the calling deps' tenant, so a cross-tenant write attempt would surface as a Postgres RLS error rather than a clear application-layer assertion message. SRE diagnosis is harder.

**Fix**:

```ts
// After line 528 in bulkInsertOpenIfAbsent, before building insertValues:
for (const input of inputs) {
  if (input.tenantId !== tenant.slug) {
    throw new Error(
      `bulkInsertOpenIfAbsent: input.tenantId='${input.tenantId}' ≠ adapter tenant.slug='${tenant.slug}' — cross-tenant write blocked (Constitution Principle I)`,
    );
  }
}
```

### M1 — B1 outer catch swallows `runInTenant`-driver errors as `flush_page_failed`

**File/line**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:489-494`

The catch at `:489` catches **any** throw from inside `flushPage` (correct) BUT also from `runInTenant` itself (BEGIN/COMMIT failure, lost connection, etc.). Both classes get coerced into `server_error` with whatever message the underlying error had. SRE looking at the cron's emitted partial-failure audit cannot distinguish "bulk_insert_open_failed" from "ECONNRESET on COMMIT". Both are real errors but they alert differently.

**Hidden errors**: connection-pool exhaustion vs application bug class mixed under one bucket → wrong runbook entry.

**Fix**: branch on `e.message.startsWith('bulk_insert_open_failed') || .startsWith('bulk_emit_failed')` and tag the returned `kind: 'server_error'` with a `subKind: 'flush_page_failed' | 'tx_driver_failed'`. Or wrap the `runInTenant` call separately:

```ts
let flushResult;
try {
  flushResult = outerTx
    ? await flushPage(outerTx, pageDecisions, nowIso)
    : await runInTenant(deps.tenant, (tx) => flushPage(tx, pageDecisions, nowIso));
} catch (e) {
  const message = (e as Error)?.message ?? 'flush_page_failed';
  const subKind = message.startsWith('bulk_') ? 'flush_page_failed' : 'tx_driver_failed';
  return err({ kind: 'server_error', subKind, message });
}
```

### M2 — `observeCycleStateGaugesForTenant` swallows ALL exception types

**File/line**: `src/app/api/cron/renewals/dispatch-coordinator/route.ts:89-101`

The catch at `:89` is a bare `catch (e)` that logs at WARN. This is correct for OperationalError / connection blips (best-effort gauge), BUT also silently swallows TypeErrors, programmer bugs in `asTenantContext`, sql-template misuse, etc. Logging WARN means PagerDuty / Vercel alert rules at ERROR level miss programmer bugs.

**Hidden errors**: a refactor that breaks `renewalsMetrics.observeCycleStateGauge` signature would fail every cron run with no alert escalation. The R5-S2 Promise.all wrapping makes this WORSE because all per-tenant calls fail simultaneously without breaking the coordinator.

**Fix**: distinguish operational vs programmer errors:

```ts
} catch (e) {
  const isOperational = e instanceof Error &&
    /connection|timeout|ECONNRESET|terminated/i.test(e.message);
  const sev = isOperational ? 'warn' : 'error';
  logger[sev]({ err: ..., tenantId, gaugeKind: 'renewals_cycles_state' },
    'cron.renewals.coordinator.gauge_observe_failed');
}
```

Or expose a `gauge_observe_failed_total{kind}` counter alongside the log so SRE can alert on sustained failure regardless of log severity.

### M3 — Reminder-event `bulkTransitionToSent` raw SQL UPDATE missing tenant_id filter

**File/line**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:436-446`

The raw SQL `UPDATE renewal_reminder_events r ... WHERE r.reminder_event_id = v.reminder_event_id AND r.status = 'pending'` has no explicit `r.tenant_id = ${tenant.slug}` — relies entirely on RLS. Constitution Principle I clause 1 mandates app-layer + db-layer filters. Other methods in this file do include the tenantId in WHERE for defense-in-depth (e.g. `insertIfAbsent` line 132). The R5-C2 input guard catches mis-typed inputs but not RLS misconfigurations.

**Fix**: add `AND r.tenant_id = ${tenant.slug}` to the WHERE clause and to the verification SELECT.

### L1 — `compute-at-risk-score.ts` step-3 audit catch lacks correlation context

**File/line**: `src/modules/renewals/application/use-cases/compute-at-risk-score.ts:249-257`

The catch at `:249` logs only `{ err }` and re-throws. Missing: `tenantId`, `memberId`, `correlationId`, `requestId`. The caller's tx rolls back (correct), but the logged ERROR is impossible to correlate with the cron pass that triggered it. Compare with the `S1` skip-audit catch at `:147-159` which logs `tenantId`, `alreadyAtTarget`.

**Fix**: enrich the log object: `{ err, tenantId: input.tenantId, memberId: input.memberId, correlationId: input.correlationId }`.

### L2 — `evaluate-tier-upgrade.ts` aggregate `already_at_target` audit failure logged but not countered

**File/line**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:530-539`

The catch at `:530` mirrors S1's pre-fix shape (warn + continue) but does NOT call `renewalsMetrics.atRiskAuditEmitFailed` or any equivalent counter. Same Constitution Principle VIII visibility gap that R5-S1 fixed for `compute-at-risk-score`. Drift between two parallel use-cases.

**Fix**: emit a `tierUpgradeAuditEmitFailed('already_at_target', tenantId)` counter (add to `src/lib/metrics.ts` mirroring `atRiskAuditEmitFailed` signature).

---

## Constitution Principle VIII (Reliability) Verdict

| Sub-principle | Verdict |
| --- | --- |
| State ↔ audit atomicity (B1, C2 insert) | PASS |
| State ↔ audit atomicity (C2 transition) | **FAIL — H1** |
| Per-tenant fault isolation in cron | PASS (S2) |
| READ_ONLY_MODE handling | PASS (out of scope of R5; coordinator gate intact) |
| Forensic chain visibility | PARTIAL (S1 fixed; L2 drift remains) |
| Defense-in-depth tenant filters | PARTIAL (H2 + M3) |

---

## Recommended Action

1. **Block merge until H1 + H2 fixed** — both can regress R5 wins (C2's row-count assertion is mis-formed; tier-upgrade bulk method missed the symmetric guard).
2. **Address M1, M2, M3 in this branch** — same-file diffs, low risk, large operational payoff.
3. **L1 + L2 may defer to a follow-up branch** — observability polish.

---

**Branch**: `011-renewal-reminders` HEAD `88f6b8a2`
**Reviewer**: Claude Opus 4.7 (1M context)
**Generated**: 2026-05-10
