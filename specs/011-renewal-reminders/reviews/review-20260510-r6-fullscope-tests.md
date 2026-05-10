# F8 R6 Round-2 Test-Coverage Review

**Date**: 2026-05-10
**Branch**: `011-renewal-reminders` HEAD `88f6b8a2`
**Scope**: Verify R5 test additions (bulk-port-methods.test.ts 12-case + Q1 + payment-method-enum-parity name fix + tier-upgrade-evaluate idempotency rewrite); identify NEW gaps from the 4 new Phase 10 perf benches and the F8 100%-branch threshold list in `vitest.config.ts`.

---

## Summary

R5 test work is **substantively correct** for the 12 bulk-port cases that were authored, the Q1 cron-dispatch positive-path assertion, the payment-method-enum-parity describe-block rename, and the tier-upgrade-evaluate idempotency rewrite. Seeds are realistic, FK-friendly, and the cross-tenant probe shape (`'WRONG-TENANT'` literal) is consistent with prior F3/F4 patterns.

**However, the B2 work (`vitest.config.ts` coverage thresholds for F8) introduces a CRIT failure**: two of the eight files listed at 100% branch coverage have ZERO unit tests (`evaluate-tier-upgrade.ts`, `accept-tier-upgrade.ts`), and a third (`confirm-renewal.ts`) has 17 unit tests against a 39-branch source — `pnpm test:coverage` will NOT pass against the listed thresholds today. Multiple gaps in R5 hand-off remain (concurrent-update race, B1 outer-catch path, T265 weak assertion).

---

## Critical Gaps (8–10)

### CRIT-1 — `vitest.config.ts:254-258` & `259-263` lists 100%-branch thresholds for files with NO unit tests (rating 10/10)

`vitest.config.ts:254-258` declares `evaluate-tier-upgrade.ts` at `branches: 100`. `vitest.config.ts:259-263` declares `accept-tier-upgrade.ts` at `branches: 100`. Confirmed via `Glob tests/unit/renewals/**/{evaluate,accept}-tier-upgrade*` — **no files exist**. Only integration coverage at `tests/integration/renewals/{tier-upgrade-evaluate,tier-upgrade-pending,cross-tenant-isolation}.test.ts`. `vitest.integration.config.ts:22-38` configures NO coverage provider — integration tests do not contribute to `pnpm test:coverage`. **Result**: `pnpm test:coverage` will FAIL hard with `Coverage threshold for branches not met` against these two files.

**Failure prevented**: ship-day CI failure on the threshold gate. Both files are 551 + 674 LOC and are F8-canonical mutating cron / RBAC entrypoints (Constitution Principle II security-critical).

**Recommended fix** (pick one):
- (A) Author unit-test pairs (`tests/unit/renewals/application/use-cases/evaluate-tier-upgrade.test.ts` + `accept-tier-upgrade.test.ts`) covering the branches the integration tests exercise. Mirror the `confirm-renewal.test.ts` mock pattern.
- (B) If B2 intent was integration-only coverage, add explicit per-file overrides to `coverage.exclude` and document the integration-coverage substitution in a `vitest.config.ts` block-comment + plan.md Complexity Tracking entry.

### CRIT-2 — `confirm-renewal.ts` 100% branch is unrealistic with 17 unit tests against 39 branches (rating 8/10)

`vitest.config.ts:269-273` declares `confirm-renewal.ts` at `branches: 100`. Source has 39 branch-creating constructs (counted via grep `^\s*if|else|case|catch|throw|?`). The unit test has 17 `it()` blocks. Cross-checking the integration suite at `tests/integration/renewals/self-service-renewal-tx.test.ts` covers part of the database-level behaviour, but does NOT contribute to coverage. Specific likely-missing branches:
- F4 bridge `status='no_charge'` path (line ~ where `invoiceResult.status !== 'issued'` discriminator narrows)
- `CycleNotFoundError` outer rethrow vs `InvoiceLinkConflictError` outer rethrow (file `confirm-renewal.ts:~395`)
- The plan-change branch's `planResult.status === 'plan_inactive'` fork

**Recommended fix**: Either run `pnpm test:coverage --reporter=text src/modules/renewals/application/use-cases/confirm-renewal.ts` and fill the gaps, OR demote to `branches: 90` with a TODO comment naming the missing paths.

### CRIT-3 — `dispatch-renewal-cycle.ts` 100% branch threshold has no covering unit test for `outerTx`-bypass and `dispatcher_crash` audit-emit-failure paths (rating 8/10)

`vitest.config.ts:244-248` declares `dispatch-renewal-cycle.ts` at `branches: 100`. The K1-C8 audit-emit-failure inner catch (`dispatch-renewal-cycle.ts:308-324`) and the outer `pages > 1000` safety bound (`:373-379`) are defensive paths almost certainly NOT exercised by `tests/unit/renewals/application/use-cases/dispatch-renewal-cycle.test.ts`. Integration-side coverage exists implicitly via the perf bench but again does not feed `pnpm test:coverage`.

**Recommended fix**: Add 2 unit tests — (a) inject an `auditEmitter.emit` that throws to confirm the per-cycle catch swallows + logs (b) inject a `dispatchCandidateRepo.list` returning ever-cursored pages to trigger the safety bound.

---

## Important Improvements (5–7)

### IMP-1 — `bulk-port-methods.test.ts` lacks positive-path catalogue-driven coverage for `bulkInsertOpenIfAbsent` (rating 7/10)

Lines 207-294 cover empty + happy + R5-C1 conflict-target. **MISSING**: the use-case-driven path through `evaluate-tier-upgrade.ts:flushPage` where `decideUpgrade` returns a non-null decision and the catalogue lookup feeds `pd.decision.toPlan.planId` into the inserted row. T264 perf bench exercises this transitively but with `RUN_PERF=1` gating — without `RUN_PERF`, no test in the suite covers the production wiring.

**Failure prevented**: a regression where `decideUpgrade` returns the wrong plan reference (e.g., from an out-of-tenant catalogue) lands silently because the bulk insert does the right shape per the unit-of-test, but the upstream wiring is broken.

**Recommended fix**: add a 13th case calling `evaluateTierUpgrade(deps, ...)` (already imported in `tier-upgrade-evaluate.test.ts`) and assert the inserted suggestion's `toPlanId` matches the catalogue's `premium` planId. Half-day of work; reuses existing `seedPlan` helper.

### IMP-2 — `bulkTransitionToSent` lacks concurrent-update race coverage (rating 6/10)

The R5-C2 row-count assertion test (lines 385-401) covers the stale ID case. **MISSING**: the realistic concurrent path — admin "Send reminder now" flips `pending → sent` while a bulk-flush is in progress. The `expected 1 rows updated, got 0` throw is correct under both stale-ID AND concurrent-update; without a concurrent test, we don't know if the surrounding cron-loop catches and tallies as failedTransient OR aborts the page.

**Recommended fix**: integration test that opens two `runInTenant` blocks against the same `reminderEventId`: tx-A flips to `sent` first, tx-B's `bulkTransitionToSent` should throw, and the cron-loop's outer behaviour (re-throw vs catch+tally) should be asserted explicitly.

### IMP-3 — `flushPage` re-throw → outer-catch → `err({server_error})` path (R5-B1) is UNTESTED (rating 7/10)

`evaluate-tier-upgrade.ts:319-323` documents the contract: bulk-insert/bulk-emit failures THROW so `runInTenant` rolls back, then the outer-loop catch at `:489-494` converts to `err({kind:'server_error'})`. `Grep "flushPage|bulk_insert_open_failed|bulk_emit_failed"` returns zero hits in `tests/`. The `server_error` discriminator is part of the public Result-type contract (`evaluate-tier-upgrade.ts:77`); a regression that drops the catch + throw to `Result.err` directly inside `flushPage` would silently break atomicity AND let CI pass.

**Recommended fix**: unit test injecting a `tierUpgradeRepo.bulkInsertOpenIfAbsent` mock that throws → assert outer returns `err({kind:'server_error', message: matches /bulk_insert_open_failed/})`. Mirrors the existing F4 PDF-render-failure unit test pattern.

### IMP-4 — T265 (`renewal-confirm-perf.test.ts:229,246`) `expect(r.ok).toBe(true)` assertion is weak (rating 6/10)

Unlike T262 which now pins `emailsSent>0` (Q1) and T264 which pins `suggestionsCreated>0`, T265 only asserts `r.ok === true`. A regression where `confirmRenewal` returns ok with `transitioned=false` (state-machine guard fired but use-case didn't classify as error) would still pass. The bench seed deliberately sets `status: 'awaiting_payment'` so a successful confirm MUST flip the state.

**Recommended fix**: after each sample, add `expect(r.value.cycleStatus).toBe('awaiting_payment_invoice')` (or whatever the next-state literal is per `confirmRenewal` output type). Single-line change.

### IMP-5 — T261 (`pipeline-perf.test.ts:205`) `expect(r.value.rows.length).toBeGreaterThanOrEqual(0)` is a tautology (rating 5/10)

`length >= 0` is true for every array. The bench seeds 1,000 cycles with 60% in the 90-day window; a regression where `loadPipeline` returns zero rows for the `'t-90'` urgency tab (e.g., off-by-one filter, broken urgency derivation) silently passes. Mirrors the same class of bug Q1 caught in T262.

**Recommended fix**: assert `expect(r.value.rows.length).toBeGreaterThan(0)` for at least the warmup `'t-90'` call (the seed guarantees ≥1 row in that bucket). Tautology → real signal in 1 character.

---

## Test Quality Issues

### TQ-1 — `bulk-port-methods.test.ts:455-463` cleanup-inside-test couples cases (rating 4/10)

The "happy path" test (lines 403-464) deletes its own reminder rows in-test to avoid colliding with sibling `it()` blocks on the `(cycle, step, year)` unique index. This works but couples test ORDER + introduces silent flake risk if a future `it()` re-uses the same `cycleId`. Prefer per-test seeded cycles (the `seedMember` helper already returns a fresh cycle per call — the happy-path test could call `seedMember()` to mint a NEW cycle just for the transition test).

**Recommended fix**: remove the in-test cleanup (lines 455-463) and call `seedMember()` once more for transition seeding.

### TQ-2 — `tier-upgrade-evaluate.test.ts:292-315` idempotency rewrite is correct but the assertion comment is over-long for the test surface (rating 3/10)

The 24-line block-comment (`Phase 10 T262 batched-write fix … binding idempotency invariant`) is accurate (verified against the source: `evaluate-tier-upgrade.ts:454-498` does NOT filter members with active suggestions; eval candidate query is unfiltered) and explains the production contract. Comment-code parity holds. No change required, but consider extracting the rationale to a JSDoc on `evaluateTierUpgrade` itself so it lives next to the contract, not buried in a test.

---

## Q1/R5/B-fix Verification

- **Q1 (`cron-dispatch-perf.test.ts:203`)**: `expect(result.value.summary.emailsSent).toBeGreaterThan(0)` — VERIFIED. Seed sets `expiresAt = NOW_ISO + 30 days`, T-30 step exists in `seedRenewalPolicies` for `regular` tier (line 57), `members.email_unverified` defaults to false, `registration_date` defaults via `defaultNow()`, primary contacts seeded. All 13 dispatch gates pass → emails dispatched → `emailsSent>0` is sound.
- **R5 idempotency (`tier-upgrade-evaluate.test.ts:283-315`)**: VERIFIED. Source `evaluate-tier-upgrade.ts:454-498` does scan + insert-attempt + `member_open_uniq` rejection; second-pass `conflictSkipped===1`, `membersScanned===1`, `rows===1` is correct.
- **R5-MED1 (`bulk-port-methods.test.ts:284-292`)**: VERIFIED. `result.conflicted[0].reasonCode === 'declared_turnover_above_threshold'` confirms the symmetric `NewTierUpgradeSuggestionInput[]` shape (not just `memberId` strings).
- **R5-C2 tenantId guard (`bulk-port-methods.test.ts:305-320, 370-383`)**: VERIFIED. `'WRONG-TENANT'` literal + `rejects.toThrow(/cross-tenant write blocked/)` matches the standard F3/F4 cross-tenant probe shape.
- **payment-method-enum-parity rename**: VERIFIED. Describe block at `payment-method-enum-parity.test.ts:73` reads `'F8 cross-module enum parity — Phase 10 / CHK040 close'`.

---

## Positive Observations

1. `bulk-port-methods.test.ts` `afterAll` (lines 87-117) deletes in correct FK-friendly order: `renewal_reminder_events → tier_upgrade_suggestions → renewal_cycles → contacts → members → membership_plans → audit_log → tenant.cleanup()`. Each wrapped in `.catch(()=>{})` for partial-failure resilience.
2. `seedMember` helper (lines 119-159) uses `randomUUID()` per cycle — no cross-test ID collision risk.
3. The `(tx as unknown as typeof db)` cast at line 175 + 326 is the standard Drizzle-with-runInTenant escape hatch consistent with prior F3 tests.
4. T264 (`tier-upgrade-evaluate-perf.test.ts:260-273`) production-parity wrapping (advisory lock + outerTx threading) accurately mirrors `src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts`. Bench measures the right thing.
5. T265 invoice-queue mock (`renewal-confirm-perf.test.ts:199-214`) elegantly avoids FK violations by pre-seeding draft invoices and dequeueing per call. Cleaner than mocking-then-faking-FKs.

---

## Recommended R7 Round-3 Actions (Prioritised)

1. **CRIT-1**: choose (A) author unit tests for `evaluate-tier-upgrade` + `accept-tier-upgrade` OR (B) document integration-coverage substitution. Either way, MUST run `pnpm test:coverage` before R7 close.
2. **CRIT-2**: run `pnpm test:coverage` on `confirm-renewal.ts`; either close gaps or demote threshold.
3. **CRIT-3 + IMP-3**: add 3 unit tests covering audit-emit-failure (dispatch-renewal-cycle), safety-bound (dispatch-renewal-cycle), and `flushPage` re-throw (evaluate-tier-upgrade).
4. **IMP-4 + IMP-5**: tighten T265 + T261 weak positive-path assertions (~2 line changes).
5. **IMP-1, IMP-2, TQ-1, TQ-2**: backlog for Phase 11 polish; not ship-blocking.

