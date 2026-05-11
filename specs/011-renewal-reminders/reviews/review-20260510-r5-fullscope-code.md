# F8 Renewal Reminders — Phase 10 Verify-Fix Wave Code Review

**Reviewer**: Claude Opus 4.7 (1M context) — automated `/review` invocation
**Date**: 2026-05-10
**Scope**: F8 branch `011-renewal-reminders` vs `main` — focused on Phase 10 verify-fix wave (commits `52637d75`, `2caa8d74`, `278e8b22`)
**Files inspected directly**:
- `src/modules/renewals/application/ports/tier-upgrade-suggestion-repo.ts`
- `src/modules/renewals/application/ports/renewal-reminder-event-repo.ts`
- `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts`
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts`
- `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts`
- `src/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle.ts`
- `tests/integration/renewals/f5-refund-bridge.test.ts`
- `tests/integration/renewals/payment-method-enum-parity.test.ts`
- `tests/integration/renewals/tier-upgrade-evaluate-perf.test.ts`
- `tests/integration/renewals/pipeline-perf.test.ts`
- `tests/integration/renewals/cron-dispatch-perf.test.ts`
- `tests/e2e/renewal-{a11y,i18n}.spec.ts`
- `src/lib/db.ts` (`runInTenant` semantics)
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts:453-477` (`bulkEmitInTx`)
- `drizzle/migrations/0091_f8_create_tier_upgrade_suggestions_table.sql:104-106` (partial unique index)

---

## Summary

The Phase 10 verify-fix wave is a clean, well-scoped delivery. The T264 batched-write refactor of `evaluateTierUpgrade` is correct in approach, preserves Constitution Principle VIII atomicity, and matches the T159b precedent on `RenewalAuditEmitter.bulkEmitInTx`. The two new contract tests (`f5-refund-bridge.test.ts`, `payment-method-enum-parity.test.ts`) are tight, exhaustive, and use the discriminated-union `never` exhaustiveness pattern correctly.

**No BLOCKER findings.** Three IMPORTANT (≥80) findings tied to the new bulk infrastructure, plus several SUG/LOW (which are reported here for completeness but with confidence ≥80 only when listed). The fundamental architecture, tenant-isolation guarantees, and Constitution invariants are intact.

---

## Findings

### IMPORTANT (80–89)

#### IMP-1 — `bulkInsertOpenIfAbsent` ON CONFLICT target is implicit; partial-index assumption is fragile

**Severity**: IMPORTANT (confidence 85)
**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts:541-553`

```ts
const insertedRows = await txDb
  .insert(tierUpgradeSuggestions)
  .values(insertValues)
  .onConflictDoNothing({
    // Conflict target is the partial unique index. Drizzle's
    // onConflictDoNothing without a target argument relies on any
    // unique constraint hitting — the only such constraint on
    // tier_upgrade_suggestions for `(tenant_id, member_id)` is
    // tier_upgrade_suggestions_member_open_uniq + the PK on
    // suggestion_id (which we always generate fresh). So a
    // conflict here ALWAYS means the partial unique fired.
  })
  .returning();
```

**Problem**: `onConflictDoNothing()` is invoked with an empty options object → no `target` → Postgres `ON CONFLICT DO NOTHING` without a conflict target. The single-row `insertOpen` (line 207-243) takes the opposite, more defensive route — let the insert raise + catch the constraint name. The bulk path silently swallows ALL unique-violation conflicts, including the PK on `(tenant_id, suggestion_id)` if `deps.suggestionIdGenerator()` ever produced a duplicate UUID (not impossible during seeded perf tests or future ID-generator regressions).

**Concrete risk**: a future seed/generator regression that produces colliding `suggestion_id` values would silently report `inserted` rows with reduced count + member_ids in `conflicted` — masking what is actually a developer-error PK collision as a benign "already had open suggestion" replay.

**Fix**: pass an explicit target matching the partial unique index, AND a `targetWhere` for the partial predicate:

```ts
.onConflictDoNothing({
  target: [tierUpgradeSuggestions.tenantId, tierUpgradeSuggestions.memberId],
  targetWhere: sql`status IN ('open','accepted_pending_apply')`,
})
```

This makes the intent explicit + Postgres only suppresses violations of THIS specific index, surfacing accidental PK collisions as loud errors instead of silent skips. Drizzle supports `targetWhere` per <https://orm.drizzle.team/docs/insert#on-conflict-do-nothing>.

---

#### IMP-2 — `bulkTransitionToSent` docstring vs implementation drift; missing `ELSE` arm in CASE

**Severity**: IMPORTANT (confidence 82)
**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:383-425`

Two sub-issues in the same method:

**(a) Documentation drift**: comment at line 384-385 says "single multi-row UPDATE via `UPDATE … FROM (VALUES …)`" but the implementation uses `UPDATE ... SET col = CASE WHEN id = ... THEN ... END WHERE id IN (...)`. Future readers (or a code-search for `UPDATE … FROM (VALUES …)`) will be misled. Either update the comment to match (`single multi-row UPDATE via CASE WHEN expression`) or refactor to actually use the `FROM (VALUES …)` join — the latter scales better past ~500 rows because the query plan can hash-join instead of evaluating O(N) CASE branches per row.

**(b) Missing `ELSE` in CASE**: lines 414-415 build `CASE WHEN ... END` with no `ELSE` clause. If the WHERE filter (`id IN (ids) AND status='pending'`) returns a row whose `reminderEventId` somehow doesn't appear in the WHEN list (e.g. someone slips a stray id into the IN-list at a future call site), `dispatchedAt` and `deliveryId` would be set to `NULL`. Today the WHERE-list and CASE-list are built from the same `inputs` array so this can't happen, but it's defence-in-depth: add an explicit `ELSE` that throws (e.g. `ELSE NULL` is OK only if you also assert post-update; a safer pattern is a sentinel like `ELSE NULL` plus a `RETURNING` row count check `=== ids.length`).

**Fix**: pick one — either rewrite as `UPDATE ... SET dispatched_at = src.d, delivery_id = src.did FROM (VALUES (...)) AS src(id, d, did) WHERE renewal_reminder_events.reminder_event_id = src.id AND status='pending'` (cleaner + faster); OR keep CASE but add `expect(updated.length).toBe(inputs.length)` assertion in the caller and an `ELSE NULL` arm with a doc comment.

---

#### IMP-3 — `bulkInsertIfAbsent` adapter ignores `input.tenantId` from the port, hard-codes `tenant.slug`

**Severity**: IMPORTANT (confidence 80)
**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:330-381` (vs port interface at `src/modules/renewals/application/ports/renewal-reminder-event-repo.ts:47-56`)

The `NewReminderEventInput` port type requires `tenantId: string` (line 49 of port), but the bulk adapter discards it on line 343 and substitutes `tenant.slug` from the per-tenant factory closure:

```ts
const insertValues = inputs.map((input) => ({
  tenantId: tenant.slug,  // ← input.tenantId silently ignored
  ...
}));
```

Compare with `bulkInsertOpenIfAbsent` in the sister adapter (`drizzle-tier-upgrade-suggestion-repo.ts:531`) which DOES use `input.tenantId`. This inconsistency:
1. Hides a potential bug where caller passes `input.tenantId !== tenant.slug` (cross-tenant leak intent) and adapter silently overrides — gives a false sense of safety.
2. Makes the port type lie: the field is documented as required, but ignored by this implementation.

**Fix**: either drop `tenantId` from `NewReminderEventInput` (since the per-tenant factory already binds it), OR add an assertion in the bulk method:
```ts
for (const i of inputs) {
  if (i.tenantId !== tenant.slug) {
    throw new Error(`bulkInsertIfAbsent: input.tenantId mismatch with factory tenant — possible cross-tenant write attempt`);
  }
}
```
Same pattern should be applied to the single-row `insertIfAbsent` at line 84-145 which also ignores `input.tenantId`. (Pre-existing — not a Phase 10 regression but noted for consistency.)

---

### MEDIUM/SUG (75–79) — included for completeness only

These are below the ≥80 reporting threshold but worth mentioning briefly since the user requested a thorough sweep.

- **SUG-1** (conf 75): `bulkTransitionToSent` lacks explicit `tenantId` filter on the `WHERE` clause — relies entirely on RLS `SET LOCAL app.current_tenant`. The single-row `insertIfAbsent` at line 119-138 was specifically hardened (J9-M1 comment) with an explicit `tenant_id` filter for "Constitution Principle I clause 1 application-layer + database-layer tenant filter" defence-in-depth. The new bulk method should follow the same J9-M1 precedent. Same applies to `bulkGetSuppressedMembers` at `drizzle-tier-upgrade-suggestion-repo.ts:499-518`.
- **SUG-2** (conf 78): `bulkTransitionToSent` returns `updated.map(rowToDomain)` without verifying `updated.length === inputs.length`. If concurrent retry-pass already flipped some rows from `pending` → some-other-state (e.g. `failed`), the WHERE `status='pending'` filter silently excludes them. Caller (production dispatchOneCycle) likely needs to know about partial application to emit correct audits. Add `expect(updated.length).toBe(inputs.length)` invariant or return both `updated` + `skipped` arrays.
- **SUG-3** (conf 76): `tier-upgrade-evaluate-perf.test.ts` constants `REGULAR_FEE_MINOR = 5_000_000` and `PREMIUM_THRESHOLD_MINOR = 100_000_000` are documented as "same scale" but the comment on line 53-58 calls out the historical confusion. Consider extracting `seedTestPlanCatalogue(tenant, {regularFeeMinor, premiumThresholdMinor})` to a shared helper so future tests don't re-invent the scale convention.
- **SUG-4** (conf 76): `f5-refund-bridge.test.ts:139-146` "singleton" test — `expect(f5RefundBridge).toBe(f5RefundBridge)` is a tautology (always passes). To actually test singleton-ness, import the symbol twice via different specifier paths or via dynamic import + compare references.

---

## Positive observations (high-signal callouts)

1. **T264 evaluate-tier-upgrade refactor is exemplary**. The 3-RTT-per-page pattern (suppress check → bulk insert → bulk audit emit) is exactly the right shape, the `flushPage` closure encapsulates the page-local mutation cleanly, the `outerTx` threading documentation (lines 171-202) explains the trade-off honestly including the residual TOCTOU window for `auto_upgrade_enabled` flips. Comment quality > 90% of the codebase.
2. **CHK040 enum-parity test** (`payment-method-enum-parity.test.ts`) is the textbook way to pin a cross-module discriminated union — `as const satisfies ReadonlyArray<F4InvoicePaidPaymentMethod>` + exhaustive switch with `never` branch catches drift at BOTH compile-time AND runtime. Should be cited as a reference pattern in `docs/code-review-standards.md` if such a doc exists.
3. **Test infrastructure parity with production**: `tier-upgrade-evaluate-perf.test.ts` mirrors the production cron route's `runInTenant` + `pg_advisory_xact_lock` + `outerTx` threading exactly. The bench-vs-prod-divergence trap that bit T262 perf was diagnosed correctly and the post-fix assertion `expect(suggestionsCreated).toBeGreaterThan(0)` prevents regression.
4. **Constitution Principle VIII (Reliability) is honoured**: the `bulkEmitInTx` audit emit happens on the same `tx` as the suggestion-insert, so atomicity holds — a failed audit emit aborts the entire page's writes.
5. **No tenant-isolation violations in the use-case layer**. `evaluateTierUpgrade` correctly uses `runInTenant(deps.tenant, ...)` when no `outerTx` is supplied, and only threads `outerTx` from the cron route which has already established the tenant context.

---

## Out-of-scope or pre-existing items (NOT counted as findings)

- The single-row `transitionStatus` at `drizzle-tier-upgrade-suggestion-repo.ts:374` already lacks an explicit `tenantId` filter — pre-existing, reviewed before, not a Phase 10 regression.
- `tests/e2e/renewal-manager-readonly.spec.ts` mentioned in the review prompt does not exist on disk — likely a typo for `renewal-pipeline-dashboard.spec.ts` (which is present + reviewed positively).
- T262 dispatcher outer-loop wiring is documented as deliberately split to a follow-up commit on this branch — not a Phase 11 deferral. Acceptable per the commit message rationale.

---

## Recommendation

**APPROVE with IMP-1 + IMP-2 + IMP-3 to be addressed before ship.**

All three findings are localised to ≤30 lines each, do not alter the architecture, and have concrete fixes spelled out above. None are tenant-isolation BLOCKERS. The Phase 10 verify-fix wave delivers what it claims (44× speedup, contract-pinning tests, perf benches with positive-path assertions) and clears the path to F8 ship-readiness once the three bulk-method polish items land.

**Next step**: address IMP-1 + IMP-2 + IMP-3 in a single follow-up commit on the same branch, then proceed to `/speckit.ship` gate.

— end of report —
