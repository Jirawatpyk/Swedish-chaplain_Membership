---
review_type: comment-accuracy + maintainability
scope: F8 full-scope (011-renewal-reminders @ HEAD vs main, ~118 changed files)
date: 2026-05-10
reviewer: code-comment-analyzer (R5 full-scope)
focus: drift / staleness / over-comment / TODO leakage / cross-file consistency
output_budget: 1200 words
---

# F8 Comment Accuracy + Maintainability Review (R5 full-scope)

## Summary

F8 ships ~118 changed files with **heavy, high-quality comment density** — virtually every public surface carries a JSDoc header citing the originating Phase / Wave / Round / FR. Cross-file consistency for the `bulkEmitInTx` pattern, `F8_AUDIT_EVENT_TYPES` taxonomy, and tenant-isolation defence-in-depth narrative is exemplary. However, the Phase 10 verify-fix wave (T262/T264 batched-write) introduced **2 IMPORTANT comment-code drifts** — small numeric/identifier inaccuracies that future maintainers would absorb as fact. There is also a stale Phase-11 reference and one mis-counted field assertion.

Overall posture: **strong**. Findings concentrate in the very newest commits (52637d75 + 2caa8d74 + 8f265467), exactly where review pressure is naturally lowest.

## Critical Issues (drift — IMPORTANT)

### IMP-1 — `evaluate-tier-upgrade.ts` flushPage banner mis-states pre-batched RTT count
**Location**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:304-311`

Comment claims:
> "Pre-batched implementation issued **~5 RTTs per above-threshold member** on the outerTx-threaded path (suppression check + insert + audit emit) → T264 perf bench captured 98s @ 1k members."

The parenthetical enumerates only **3** operations (suppression check + insert + audit emit), which contradicts the "~5 RTTs" claim. Either the prose is wrong (3 RTTs/member, matching the listed ops) or the enumeration is incomplete (a future reader will not know what the 2 missing RTTs were). Cross-checked against retrospective § S1 line 89 which describes "~3-4 RTTs per candidate" for the cron-dispatch path — the "5" figure here is unsupported by any other artifact.

**Suggestion**: Pin the number against the actual op list. Recommended: `"~3 RTTs per above-threshold member (1 suppression check + 1 insert + 1 audit emit)"`.

### IMP-2 — `evaluate-tier-upgrade.ts` Phase-11 reference mis-cites task ID
**Location**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:310-311`

Comment says:
> "Phase 11 follow-up: extend the same batching to dispatchRenewalCycle (T262 cron path)."

Two errors:
1. Per `tasks.md:802` and retrospective § S1 line 96, the dispatch-cron-path bulk-flush is **NOT a Phase 11 deferral** — it is sequenced as an **F8-EPIC FOLLOW-UP COMMIT on this same branch** (Constitution Principle VII: "T262 SEND-path bulk-flush wiring sequenced as follow-up commit on this branch with documented continuation plan — NOT Phase 11 deferral").
2. The cron-path task ID is mis-cited: T262 is the **port + adapter infrastructure** (closed in commit `2caa8d74`); T264 is the **evaluate-tier-upgrade refactor that this very file implements**. The follow-up commit has no T-number assigned in tasks.md but is described as "Continuation plan for the SEND-path bulk-flush" in retrospective § S1.

**Suggestion**: `"Follow-up commit on this branch (NOT Phase 11): wire dispatchRenewalCycle outer loop to bulkInsertIfAbsent + bulkTransitionToSent — see specs/011-renewal-reminders/retrospective.md § S1 for the 4-phase pseudocode."`

### IMP-3 — `payment-method-enum-parity.test.ts` field-count drift in test name + comment
**Location**: `tests/integration/renewals/payment-method-enum-parity.test.ts:126-141`

Test title says `'F4InvoicePaidEvent shape pins all 8 required fields'` and the JSDoc above the literal mentions documenting the canonical shape, but the assertion is `expect(Object.keys(sample)).toHaveLength(9)` and the literal lists 9 keys (`tenantId, invoiceId, memberId, paidAt, amountSatang, vatSatang, currency, paymentMethod, triggeredBy`).

A reader reading just the test name + JSDoc would believe the F4 contract has 8 fields when it actually has 9. If a future field is added (e.g. F4 frozen-currency expansion), the off-by-one in narrative obscures whether the test was already failing pre-change.

**Suggestion**: Rename test to `'F4InvoicePaidEvent shape pins all 9 required fields'` and update the comment.

## Improvement Opportunities (MEDIUM)

### MED-1 — `drizzle-tier-upgrade-suggestion-repo.ts:540-552` ON CONFLICT comment is speculative
**Location**: `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts:541-552`

The comment inside `onConflictDoNothing({})` reasons that "a conflict here ALWAYS means the partial unique fired" because `(tenant_id, member_id)` has no other unique constraint and `suggestion_id` is freshly generated. This argument is correct **today**, but Drizzle's `onConflictDoNothing` without a `target` argument silently swallows conflicts on ANY unique constraint — if a future migration adds, say, a `(tenant_id, member_id, to_plan_id)` UNIQUE for orphan dedup, the same bulk-insert would silently swallow those collisions and `conflicted` would mis-attribute them to the partial unique.

**Suggestion**: Either pass an explicit `target: ...` (defence-in-depth, mirrors `drizzle-renewal-reminder-event-repo.ts:104-111`) or add a `_AssertSingleUnique` invariant test in the same file's neighbouring test that fails when a 3rd unique constraint is added. Comment should warn explicitly: `"If a future unique constraint is added, switch to explicit target: clause."`

### MED-2 — `dispatch-one-cycle.ts:1-33` header narrative claims "13 gates" but Gate 4.5 makes it 14
**Location**: `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts:9` + `:75-100` + `:379-391`

The header says "Decision tree: 13 gates (first match wins)". The `SKIP_REASONS` tuple has 13 entries and `_AssertSkipReasonCount` pins the 13. However, `dispatchOneCycleInner` numbers gates 1-12 plus an explicit `Gate 4.5` (member-no-joined-at) at line 379-391 that emits the dedicated `no_joined_at` skip. So there are actually **13 numbered gates, but one is fractional**, which is structurally fine but the comment "13 gates" reads as if the count and the SKIP_REASONS length are coupled (they happen to coincide). A reader adding a new gate will not realise that adding a numbered gate without adding a SKIP_REASON breaks the assertion.

**Suggestion**: Replace "13 gates" with "13 skip reasons across 13 numbered gates (one fractional: Gate 4.5)" OR renumber Gate 4.5 to Gate 5 and shift downstream. The current state confuses the relation between gate-numbering and SKIP_REASONS arity.

### MED-3 — `renewal-audit-emitter.ts:78-90` retains a "RESERVED but currently NOT EMITTED" event with stale OOS reference
**Location**: `src/modules/renewals/application/ports/renewal-audit-emitter.ts:79-90`

The 11-line comment defending the retention of `renewal_payment_failed` references "**OOS-18** in `specs/011-renewal-reminders/spec.md`" as the tracking item for the F5→F8 bridge. The retrospective (§ "Out-of-scope deferrals") in this branch enumerates ~12 deferred items but I cannot find an OOS-18 cross-reference in the spec; this risks comment rot once the spec OOS list is renumbered. Also the comment dates from "Round 4 verify-fix (D1) / Round 5 staff-review (R004)" — pinning to 2 review IDs that are no longer the latest (now R10 / Phase 10 R4) makes the rationale feel stale.

**Suggestion**: Either (a) verify OOS-18 still exists by exact ID in spec.md and pin the line number; OR (b) rephrase to "tracked as a post-MVP backlog item; F5→F8 payment_failed listener bridge — see retrospective § S1 backlog."

## Recommended Removals (LOW)

### LOW-1 — `dispatch-one-cycle.ts:927-929` over-explains an obvious channel field
**Location**: `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts:927-929`

> "Transition reminder_event to `sent` (task-channel "sent" = "task created" — there's no separate `task_created` reminder status; the channel field disambiguates)."

This is restating the schema contract that's already documented in the schema file itself. A future reader hits this comment after already reading `dispatchTaskStep` — the channel-disambiguation belongs in the schema doc, not at the call site.

**Rationale**: removable; if kept, move to schema-renewal-reminder-events.ts.

### LOW-2 — `drizzle-tier-upgrade-suggestion-repo.ts:489-494` "Phase 7 polish" comment refers to deferred work
**Location**: `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts:490-494`

> "cursor pagination is a Phase 7 polish item; for MVP queue size <50 the first-page response is sufficient."

Phase 7 has shipped. The "polish item" is now indefinite-future. A `void args; void isNull;` next to a "we deferred this" comment is a low-grade smell.

**Rationale**: either implement OR convert to a TODO with explicit owner / backlog-item link OR delete the dead `void` calls and the comment together.

### LOW-3 — `recompute-at-risk-scores-batch.ts:130-136` unowned TODO
**Location**: `src/modules/renewals/application/use-cases/recompute-at-risk-scores-batch.ts:130`

`TODO(F6 ship): ...` is the only TODO in the F8 module surface. F6 (Events) is post-MVP per phases-plan.md. The TODO is well-explained but unowned — F8 ships dark and F6 has no committed timeline.

**Rationale**: track as a backlog item in `specs/011-renewal-reminders/retrospective.md § Out-of-scope` rather than as an inline TODO that may rot for many months.

## Positive Findings

- **`renewal-audit-emitter.ts:188-193`**: `_AssertF8AuditEventCount` compile-time pin paired with the inline `// Bump the literal when intentionally adding/removing` guidance is the gold standard — comment + code + assertion together prevent silent drift.
- **`renewal-audit-emitter.ts:961-988`**: the **Round-5 review-finding M3** narrative explaining the `tasks_created` slot re-purposing across 4 cron coordinators is exceptional — captures the SRE-dashboard impact, the backward-compat requirement, AND the migration path (`kind_specific` discriminator) in a single block.
- **`dispatch-one-cycle.ts:120-148`**: `DispatchFailureKind` JSDoc explaining the type-link to `SendRenewalEmailError['kind']` and warning future maintainers about the `void _exhaustive: never` pattern at L285-294.
- **`drizzle-renewal-reminder-event-repo.ts:117-126`**: J9-M1 defence-in-depth comment for the cross-tenant-collision SELECT is precisely the "why not what" pattern.
- **`evaluate-tier-upgrade.ts:171-202`**: `outerTx` parameter rationale explicitly enumerates the **scope limit** ("only the suggestion-insert + audit-emit WRITE paths participate in `outerTx`") and the residual TOCTOU window, so a future reader cannot mistake the partial-isolation guarantee for a full-isolation one.

## Cross-file consistency: bulkEmitInTx pattern

Verified across 3 use-sites: `recompute-at-risk-scores-batch.ts`, `evaluate-tier-upgrade.ts:407-414`, and the port docstring at `renewal-audit-emitter.ts:1070-1086`. **Consistent**: all 3 sites cite "T159b precedent" + the Constitution Principle VIII atomicity requirement + empty-events no-op contract. No drift.

## Summary table

| Finding | Severity | File | Line |
|---|---|---|---|
| IMP-1 | IMPORTANT | evaluate-tier-upgrade.ts | 304-311 |
| IMP-2 | IMPORTANT | evaluate-tier-upgrade.ts | 310-311 |
| IMP-3 | IMPORTANT | payment-method-enum-parity.test.ts | 126, 141 |
| MED-1 | MEDIUM | drizzle-tier-upgrade-suggestion-repo.ts | 540-552 |
| MED-2 | MEDIUM | dispatch-one-cycle.ts | 9, 75-100, 379-391 |
| MED-3 | MEDIUM | renewal-audit-emitter.ts | 79-90 |
| LOW-1 | LOW | dispatch-one-cycle.ts | 927-929 |
| LOW-2 | LOW | drizzle-tier-upgrade-suggestion-repo.ts | 489-494 |
| LOW-3 | LOW | recompute-at-risk-scores-batch.ts | 130-136 |

Total: **3 IMPORTANT + 3 MEDIUM + 3 LOW = 9 findings** across the 118-file F8 changeset. Cross-file consistency is solid; the 3 IMPORTANT items concentrate in the most-recent verify-fix wave and represent ~12% of the 25 new comment blocks introduced in commits `52637d75` + `2caa8d74` + `8f265467`.
