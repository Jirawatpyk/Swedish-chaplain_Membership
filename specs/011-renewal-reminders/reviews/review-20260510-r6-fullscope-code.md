# F8 R6 Full-Scope Code Review — `88f6b8a2`

**Baseline**: `278e8b22` (R5 verify-fix) → `88f6b8a2` (current HEAD on `011-renewal-reminders`).
**Scope**: 21 files / +1713 / -141. Focus: regression risk on the 3 BLOCKER + 7 HIGH + 6 LOW R5 closures, NEW issues introduced by those fixes, plus `manual_plan_change_listener_failed_total` and `bounce_hook_failed_total` counter wiring + observability docs.
**Reviewer**: solo-maintainer single-pass per Constitution v1.4.0 § Governance solo-maintainer substitute.

---

## Findings summary

| Severity | Count |
|----------|-------|
| BLOCKER  | 1 |
| HIGH     | 1 |
| MEDIUM   | 2 |
| LOW      | 1 |
| SUG      | 2 |

---

## BLOCKER

### B1 — `evaluateTierUpgrade` flushPage catch defeats the R5-B1 fix when `outerTx` is provided

**File**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:480-494`
**Why this matters**: R5-B1's stated intent is "bulk-insert + bulk-emit failures THROW (not return Result.err) so `runInTenant` rolls back atomically per Constitution Principle VIII state↔audit atomicity" (lines 319-323). The implementation does throw inside `flushPage` (lines 388, 430). But the use-case wraps the call in `try { … } catch { return err({server_error}) }`. When `outerTx` is provided (the cron route at `tier-upgrade-evaluate/[tenantId]/route.ts:85` always provides it), the throw is intercepted **inside** the lock-holding `runInTenant`, converted to a `Result.err`, and returned to the route. The route closure then returns normally → **the outer `runInTenant` COMMITS** the prior page's writes (including any partial audit drift from the failing page that ran first) instead of rolling back. The route handler at lines 96-114 then renders a 500, but the data has already been committed.

This re-opens exactly the state↔audit drift the R5-B1 docstring claims to close. The non-`outerTx` path (per-page `runInTenant`) is fine because each page is its own tx, but the cron production path is the `outerTx` path.

**Fix**: when `outerTx` is provided, propagate the throw rather than catching it. Two options:

```ts
} catch (e) {
  if (outerTx) throw e;          // let the lock-holding runInTenant roll back
  return err({
    kind: 'server_error',
    message: (e as Error)?.message ?? 'flush_page_failed',
  });
}
```

…or, cleaner: drop the catch entirely and let the route handler convert thrown errors to `err`/500 (the route's own try/catch at line 76 already handles non-Result throws).

**Tests missing**: there is no integration test that drives `evaluateTierUpgrade` via the cron route's `outerTx` path with a failing audit emitter. Add one to `bulk-port-methods.test.ts` (or a new `evaluate-tier-upgrade-outer-tx.test.ts`) asserting that a `bulkEmitInTx` rejection rolls back the suggestion-insert (post-fix: `tier_upgrade_suggestions` row count for the tenant unchanged after the failed run).

---

## HIGH

### H1 — `bulkInsertIfAbsent.conflicted` filter classifies same-input duplicates as conflicted, distorting caller branch math

**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:380-393` (and the symmetric `bulkInsertOpenIfAbsent` at `drizzle-tier-upgrade-suggestion-repo.ts:561-568`).

If `inputs` contains two entries with the same natural key (e.g. two pages of the cron loop merge or a caller passes `[A, A]`), Postgres `ON CONFLICT DO NOTHING` returns one row in `insertedRows`. The filter at line 388 then matches both inputs against the single inserted key and counts ONE input as inserted + ONE as conflicted. Caller (e.g. the planned outer-loop bulk-flush in retrospective.md lines 113-117) will emit `renewal_reminder_skipped { reason: 'already_sent' }` for an event that the SAME caller actually meant to send — false negative on a duplicate input rather than fail-loud.

The risk is currently low because today's adapter callers are the bulk-port test (deduped) and `evaluateTierUpgrade` (memberId is unique per page via the source query). But `bulkInsertIfAbsent` ships as a public port method and is documented as ready for outer-loop wiring (perf-benchmarks.md § "T262 batched infrastructure — ready but unused"). If a future caller dedupes wrong, the bug only surfaces as a missing email.

**Fix**: dedupe inputs by natural key BEFORE the insert, throwing on duplicate (fail-loud) — symmetric with the `bulkTransitionToSent` row-count assertion contract (line 463). Or document in the port JSDoc that callers MUST pre-dedupe (and add a unit test pinning that contract).

---

## MEDIUM

### M1 — `bulkTransitionToSent` re-fetch loses input ordering — port JSDoc lies

**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:447-468` vs port JSDoc `application/ports/renewal-reminder-event-repo.ts:152` ("Returns the updated rows in **input order**").

The implementation does `SELECT … WHERE reminderEventId IN (…) AND status='sent'` then `.map(rowToDomain)`. Postgres makes no ordering guarantees on `IN` lookups. Callers relying on the documented "input order" contract (e.g. the planned outer-loop bulk-flush lines 121-126 which zips `successes[idx]` against `result[idx]`) will silently misattribute `dispatchedAt` and `deliveryId` to wrong cycles → wrong audit `cycle_id` payloads → state↔audit drift.

The bench test at `bulk-port-methods.test.ts:447-452` only checks `r.deliveryId).toMatch(/^delivery-\d$/)` which is true for any permutation; it does NOT pin index→cycle correspondence.

**Fix**: either (a) re-order the result set by the input order in JS (`new Map(updatedRows.map(r => [r.reminderEventId, r])); return inputs.map(i => map.get(i.reminderEventId)!)`), or (b) fix the JSDoc to say "order is unspecified — caller must look up by `reminderEventId`". Option (a) keeps the contract honest; option (b) at least removes the foot-gun for the future outer-loop wiring author.

### M2 — T262 production-SLO re-analysis double-counts amortization

**File**: `specs/011-renewal-reminders/perf-benchmarks.md:138-140`, `retrospective.md:90-95`.

The math for "production SLO is met today" reads:

> Gateway-bound: 5000 cycles × ~100ms p50 / DISPATCH_CONCURRENCY=10 = ~50s
> DB-bound: 5000 cycles × ~17ms / 10 = ~8.5s
> Total: ~50-60s

The DB-bound calc is correct (each chunk runs DB writes serially within the chunk). But the gateway-bound calc assumes Resend's API can sustain the in-process concurrent issuance from a single Vercel function — which is true in steady state, but the cited p99 of "150-300ms" (retrospective.md line 95) at 5k cycles / 10 concurrency = 500 chunks × 300ms p99 ≈ 150s, NOT 50s. The p50 is the wrong percentile to plug into a worst-case SLO check.

If we use Resend's published p99 = ~300ms: 5000 × 0.3s / 10 = 150s — well over the 60s budget. The "production SLO met" conclusion is therefore not safely defensible without measured production RUM data. The text already concedes this for SC-005 ("Re-evaluation cadence: +7d post-prod-deploy"), but the immediate "Status: PASS" framing in retrospective.md (S1 severity revised to MEDIUM with "production SLO is met today") overclaims.

**Fix**: re-state the math using p99 not p50, mark T262 as "PROVISIONAL — production RUM required", and downgrade the "INTENTIONALLY-NOT-WIRED" decision to "DEFERRED PENDING T215-equivalent prod RUM". The bulk infrastructure stays shipped + tested either way.

---

## LOW

### L1 — Promise.all parallelization in dispatch-coordinator can mask single-tenant gauge failures

**File**: `src/app/api/cron/renewals/dispatch-coordinator/route.ts:481-485`.

`observeCycleStateGaugesForTenant` already swallows its own errors (line 89-101 try/catch + WARN log), so the helper is correctly self-contained. **However**, R5-S2's stated rationale ("a slow Neon connection for one tenant doesn't block the others") is moot today: MVP single-tenant means `tenantsSucceededOrSkipped` has length 1 (line 293: `activeTenants = [env.tenant.slug]`). The Promise.all is a no-op vs the prior serial `for-of` loop until F10 multi-tenant lands.

Not a regression — just dead weight that signals more about a hypothetical future than the current code path. Comment correctly notes "bounded by the number of tenants in this cron pass" but doesn't say "= 1 today."

**Fix (optional)**: add a one-line comment at line 481: `// MVP single-tenant: this Promise.all is a degenerate no-op until F10 multi-tenant fans out >1 tenant.`

---

## SUG

### S1 — `bulkInsertIfAbsent` lacks tenantId guard parity with `bulkInsertOpenIfAbsent`

`drizzle-renewal-reminder-event-repo.ts:348-354` correctly guards `input.tenantId !== tenant.slug`. Its sibling `drizzle-tier-upgrade-suggestion-repo.ts:520` does NOT (instead it passes `input.tenantId` straight into `insertValues`). RLS will reject a cross-tenant write at the DB layer (Constitution Principle I clause 2), but the symmetric application-layer guard (clause 1) is the better fail-fast path — surfacing the bug at the call site rather than via a Postgres error message.

**Fix**: copy the `for (const input of inputs) { if (input.tenantId !== tenant.slug) throw … }` block from line 348-354 into `bulkInsertOpenIfAbsent` at the top of line 526.

### S2 — `evaluateTierUpgrade` pageDecisions never resets between page iterations — stale data risk if loop refactored

`evaluate-tier-upgrade.ts:459` declares `const pageDecisions: PageDecision[] = []` INSIDE the `do { … } while` loop, which is correct (fresh per page). But at line 472 the code references it as if it were the only flush trigger. A future maintainer adding an `outerLoopAccumulator` is at risk of merging across pages. This is correct today; flagging as a future-maintenance hazard worth a one-line comment.

**Fix (optional)**: rename `pageDecisions` → `currentPageDecisions` to make the per-iteration scope self-documenting.

---

## Validation of R5 fixes (regression-check pass)

| R5 ID | Status | Notes |
|-------|--------|-------|
| R5-B1 (catch→throw) | **REGRESSED via B1 above** | Throw is correct in `flushPage`, but use-case-level catch defeats it on the production `outerTx` path. |
| R5-C1 (explicit conflict target) | OK | `bulkInsertOpenIfAbsent` names target correctly + integration-test pinned at `bulk-port-methods.test.ts:242-293`. |
| R5-C2 (UPDATE FROM VALUES + tenantId guard + row-count assert) | OK | SQL is parameterized via Drizzle's `sql` template tag — no injection risk on the `${i.reminderEventId}::uuid` cast (postgres-js parameterizes). Row-count assertion is correctly inside the same tx so throw rolls back the partial UPDATE. |
| R5-C3 (split webhook catch) | OK | Lookup-failed vs hook-failed metrics separated; early-return preserves 200-ok contract to Resend. |
| R5-S1 (atRiskAuditEmitFailed counter) | OK | Counter wired at compute-at-risk-score.ts:155-158; `lib/metrics.ts:1504-1517` declares the counter with bounded labels. |
| R5-S2 (Promise.all in coordinator) | OK with L1 caveat | Safe but currently degenerate. |
| R5-S3 (foot-gun JSDoc on `markCycleCompleteFromInvoicePaid`) | OK | Wording at lines 177-188 clearly redirects F4-callback callers to `markCycleCompleteInTx`. |
| R5-MED1 (conflicted shape harmonized) | OK | Port + adapter + integration-test all aligned to `NewTierUpgradeSuggestionInput[]`. |
| R5-Q1 (emailsSent>0 assertion) | OK | Adds positive-path pin so all-skipped runs no longer green. |
| F8-A9/F8-A10 alert docs | OK | Both metrics exist (`metrics.ts:1366` + `1441`) and the alert thresholds + runbook pointers match. |
| Vitest F8 coverage thresholds | OK | 9 use-cases + lapsed-portal-scope + Domain glob added; comment correctly explains why `enforce-tenant-context-on-renewal.ts` + `enforce-rbac-on-f8-mutation.ts` are NOT in the threshold map (inline patterns, covered via integration). |

---

## File paths referenced

- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\evaluate-tier-upgrade.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\cron\renewals\dispatch-coordinator\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\cron\renewals\tier-upgrade-evaluate\[tenantId]\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\specs\011-renewal-reminders\perf-benchmarks.md`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\specs\011-renewal-reminders\retrospective.md`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\integration\renewals\bulk-port-methods.test.ts`

## Recommended ordering for R6 close

1. **B1 first** — single-line condition fix in `evaluate-tier-upgrade.ts` + add a regression integration test against the `outerTx` path. Without this, the R5-B1 BLOCKER close is materially incomplete on the production code path.
2. H1 — dedupe-or-document in both bulk-insert adapters; add a 1-test pin.
3. M1 — fix order or amend JSDoc; pick one. JSDoc lying is the bigger risk.
4. M2 — restate T262 math at p99 and re-mark as PROVISIONAL.
5. L1 + S1 + S2 — opportunistic polish; can roll into the next commit on this branch.

End word count ≈ 1290.
