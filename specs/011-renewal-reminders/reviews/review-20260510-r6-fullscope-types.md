# F8 R6 Round-2 Type-Design Review — R5 Verify + New Concerns

**Branch**: `011-renewal-reminders` HEAD `88f6b8a2`
**Reviewer**: type-design specialist
**Date**: 2026-05-10
**Scope**: Verify the four R5 type changes (T-MED1, B1, C2, S1) maintain the R5 5/4.5/5/4.5 ratings and surface any NEW type concerns that R5 introduced.

---

## Verdict: APPROVED with 3 LOW + 1 IMP (no blockers; same R5 grade band)

R5 type changes hold. One genuine type-drift between port docstring and adapter behavior in `bulkTransitionToSent`, plus three minor surface concerns (overspec'd union, unsafe `as Error` pattern, asymmetric defence-in-depth). None block the gate.

---

## 1. T-MED1 — `bulkInsertOpenIfAbsent.conflicted` shape harmonization

**Files**: `src/modules/renewals/application/ports/tier-upgrade-suggestion-repo.ts:172-188` + `…/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts:520-570`

| Axis | Score | Note |
|---|---|---|
| Encapsulation | 5/5 | `conflicted: ReadonlyArray<NewTierUpgradeSuggestionInput>` — input port type, not adapter row. No leak. |
| Invariant | 5/5 | Symmetric with sister `RenewalReminderEventRepo.bulkInsertIfAbsent.conflicted: ReadonlyArray<NewReminderEventInput>`. Pre/post-fix both preserve the conflict-vs-inserted disjointness invariant (filter by primary natural key). |
| Usefulness | 4/5 | Currently only `.length` is consumed (`evaluate-tier-upgrade.ts:450`). The richer shape is forward-looking — port docstring (lines 178–186) calls out the `tier_upgrade_skipped { reason: 'already_open' }` audit emit as the future use case. Slight YAGNI risk, but harmonization with the sister port is a stronger argument; PASS. |
| Enforcement | 5/5 | `ReadonlyArray<NewTierUpgradeSuggestionInput>` blocks accidental mutation; the input shape includes `reasonCode + evidence` so no re-fetch. TS catches any caller that still expects `string[]`. Port + adapter type symbols match exactly. |

**No callers consumed `conflicted: string[]`** — `evaluate-tier-upgrade.ts:450` uses only `.length`. No migration burden.

**LOW-1 (caller dedup invariant gap)** — `drizzle-tier-upgrade-suggestion-repo.ts:566-568` filters via `insertedMemberIds.has(i.memberId)`. If a future caller passes the same `memberId` twice, ONE inserts and BOTH are filtered out of `conflicted` (the duplicate is silently dropped — neither inserted nor conflicted). Document in the port: "Inputs MUST be deduplicated by `memberId` upstream" OR change the filter semantics. Today's only caller (`flushPage`) iterates per-member from a single page, so duplicates are unreachable — but the invariant is implicit, not enforced. Suggest a one-liner contract assertion.

---

## 2. B1 — `flushPage` removes `serverError` discriminator

**File**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:315-452, 480-494`

| Axis | Score | Note |
|---|---|---|
| Encapsulation | 5/5 | `flushPage` returns a pure counters tuple `{ suppressedSkipped, suggestionsCreated, conflictSkipped }` — error channel is the throw, no leakage. |
| Invariant | 4.5/5 | All-or-nothing per-page write+audit atomicity now expressed in the type system: there's no longer a "succeeded with serverError" arm to misinterpret. Throw-on-failure aligns with `runInTenant` rollback semantics (Constitution Principle VIII). |
| Usefulness | 5/5 | Eliminates dead-code branch on `serverError !== null` — caller code is shorter and only handles the success-counter case. |
| Enforcement | 4.5/5 | `flushPage` return type is structurally typed as `{ readonly suppressedSkipped: number; ... }`. TS enforces no extra/missing fields. Outer catch at line 489–494 converts thrown `Error` to `err({ kind: 'server_error', message })`. |

**No dead-code references to `serverError`** found via grep. Caller (line 481–488) destructures only the counters fields. Clean migration.

**LOW-2 (unsafe `as Error` cast)** — Three sites use `(e as Error)?.message ?? '<fallback>'` (lines 388, 430, 492). `(e as Error)` is an unconditional cast — TS does not narrow. If the throw value is a non-Error (e.g., a string from a third-party lib), `(e as Error).message` is `undefined` at runtime (the optional-chain `?.` saves us only because the cast is itself a lie). Safer pattern: `e instanceof Error ? e.message : String(e)`. This is project-wide style consistent with peers — not a blocker — but note the type-system-cheating cast costs one Enforcement bullet.

---

## 3. C2 — `bulkTransitionToSent` re-fetch for type safety

**File**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:397-469`

| Axis | Score | Note |
|---|---|---|
| Encapsulation | 5/5 | Raw SQL UPDATE stays internal; only `ReminderEvent` (port domain type) leaves the function via `rowToDomain`. No `as unknown as RowType` chains in the result path. |
| Invariant | 3.5/5 | **TYPE-DRIFT — IMP-1 (real)**: port docstring at `renewal-reminder-event-repo.ts:152` says **"Returns the updated rows in input order"**. The adapter's re-fetch (lines 448–456) uses `inArray(...)` with no `ORDER BY` — Postgres is free to return any order. Currently no caller binds by index (`bulkTransitionToSent` is not yet wired into the dispatch use-case), so the bug is latent. Either (a) drop "in input order" from the port docstring, or (b) add an `ORDER BY array_position(ARRAY[…ids], reminder_event_id)` clause + integration test. |
| Usefulness | 4.5/5 | Re-fetch trades a 2nd RTT for compile-time type safety on the returned rows — defensible. The row-count assertion (line 463) catches the partial-UPDATE case (concurrent admin race) explicitly, surfacing as a thrown error rather than silently dropped audit pairings. |
| Enforcement | 4.5/5 | No `as unknown as` on the result path. The select uses `txDb.select().from(renewalReminderEvents)` so `$inferSelect` flows through naturally. `inArray + eq` are typed Drizzle helpers — no escape hatches. |

**LOW-3 (defence-in-depth asymmetry)** — Compare:
- single-row `insertIfAbsent` re-SELECT at line 130–138: includes explicit `eq(renewalReminderEvents.tenantId, tenant.slug)` per the J9-M1 hardening comment.
- bulk `bulkTransitionToSent` re-SELECT at line 448–456: no explicit `tenantId` predicate.

RLS catches both, but the J9-M1 reasoning ("close the leak even if RLS is somehow bypassed") applies equally to the bulk path. Add the same predicate for symmetry — one line, zero perf cost.

---

## 4. S1 — `atRiskAuditEmitFailed(auditType, tenantId)` literal union

**File**: `src/lib/metrics.ts:1493-1518` + `src/modules/renewals/application/use-cases/compute-at-risk-score.ts:155-158`

| Axis | Score | Note |
|---|---|---|
| Encapsulation | 5/5 | Literal union is closed; cardinality bounded (3 audit types × N tenants). |
| Invariant | 4/5 | Union enumerates **3 audit types** (`at_risk_skipped_below_min_tenure`, `at_risk_score_recomputed`, `at_risk_score_threshold_crossed`) but **only ONE is actually called** today (`compute-at-risk-score.ts:156`). The other two arms are aspirational. |
| Usefulness | 3.5/5 | Two-thirds of the union is dead code paths. The two unused variants (`at_risk_score_recomputed`, `at_risk_score_threshold_crossed`) emit INSIDE the `runInTenant` tx and **rethrow on failure** (line 256: `throw e;` — rolls back). They CANNOT trigger this counter — there's no catch arm that calls `atRiskAuditEmitFailed` with those types. Either narrow the union to `'at_risk_skipped_below_min_tenure'` only, or wire the in-tx audit failures to also emit the counter (currently they fail loud, which is correct per Constitution VIII state↔audit atomicity — narrowing is the right call). |
| Enforcement | 5/5 | Literal union compiled — no string-typed loophole. TS rejects calls with arbitrary strings. `safeMetric` wrapper preserves the OTel best-effort contract. |

**IMP-2 (overspec'd union)** — Narrow to `auditType: 'at_risk_skipped_below_min_tenure'` until/unless the in-tx audit emits gain a non-blocking branch. Smaller union = stronger invariant ("this counter ONLY bumps for non-blocking skip-audit failures"). Easy fix.

---

## Cross-cutting checks (the explicit-look list)

- **`flushPage` outer catch (line 484, 489–494)** — catches all throws regardless of subtype. `(e as Error)?.message ?? 'flush_page_failed'` handles non-Error throws via the fallback. Behaves correctly; only the cast is mildly unsafe (LOW-2). **PASS**.
- **`bulkTransitionToSent` re-fetch RLS-bound** — yes. `txDb` is the runInTenant-scoped tx; `app.current_tenant` is set; RLS adds the WHERE filter. **PASS** (with LOW-3 defence-in-depth note).
- **`atRiskAuditEmitFailed` audit_type union vs F8 catalog** — all 3 literals exist in the audit catalog (verified via grep across `audit-port.ts` + `tasks.md` + i18n keys). The schema is correct; usage is incomplete (IMP-2). **PASS structurally**.
- **Discriminated-union exhaustiveness new switch sites** — `compute-at-risk-score.ts:303-339` `switch (previousBand)` for `BandTransition` covers `'healthy' | 'warning' | 'at-risk'` — `'critical'` is correctly excluded by the precondition (no UP-band exists from `critical`). Safer pattern would still add `default: const _exhaustive: never = previousBand; throw new Error(...)` — currently absent but the call-site comment at line 305 documents the BAND_ORDER guarantee. **MINOR (existing pre-R5; out of scope)**.
- **Port + adapter type drift** — `bulkTransitionToSent` input-order invariant **drifts** (IMP-1). `bulkInsertOpenIfAbsent` (tier-upgrade) port + adapter symbols match (`NewTierUpgradeSuggestionInput`). `bulkInsertIfAbsent` (reminder-event) port + adapter symbols match (`NewReminderEventInput`). One real drift, two clean.
- **Tenant-isolation guard asymmetry** — `drizzle-renewal-reminder-event-repo.ts:348-353, 408-414` enforces `input.tenantId === tenant.slug`; `drizzle-tier-upgrade-suggestion-repo.ts:530-539` does not (passes `input.tenantId` to the INSERT, RLS catches mismatch). Both safe via different mechanisms — different design choices, both defensible. **NOT a finding** but worth documenting in the port comment.

---

## Final ratings (R6 round-2)

| Type | Encapsulation | Invariant | Usefulness | Enforcement |
|---|---|---|---|---|
| `bulkInsertOpenIfAbsent` (T-MED1) | 5/5 | 5/5 | 4/5 | 5/5 |
| `flushPage` return type (B1) | 5/5 | 4.5/5 | 5/5 | 4.5/5 |
| `bulkTransitionToSent` (C2) | 5/5 | **3.5/5** | 4.5/5 | 4.5/5 |
| `atRiskAuditEmitFailed` (S1) | 5/5 | 4/5 | 3.5/5 | 5/5 |

**Aggregate**: 5/5 / 4.25/5 / 4.25/5 / 4.75/5 — slight regression from R5 (5/4.5/5/4.5) driven by C2 input-order drift + S1 union overspec. Both fixable in <30min.

## Action items (all LOW/IMP — none block ship)

1. **IMP-1**: Resolve `bulkTransitionToSent` input-order drift — either drop the docstring claim OR add `ORDER BY array_position(...)` + integration test.
2. **IMP-2**: Narrow `atRiskAuditEmitFailed.auditType` to the single literal that's actually emitted, or wire the in-tx variants to a non-blocking branch.
3. **LOW-1**: Document or assert input-`memberId` dedup in `bulkInsertOpenIfAbsent` port.
4. **LOW-2**: Replace `(e as Error)?.message` with `e instanceof Error ? e.message : String(e)` at the 3 catch arms.
5. **LOW-3**: Add `eq(renewalReminderEvents.tenantId, tenant.slug)` to the `bulkTransitionToSent` re-fetch SELECT for J9-M1 symmetry.

## Files touched / referenced

- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\evaluate-tier-upgrade.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\compute-at-risk-score.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\metrics.ts`
