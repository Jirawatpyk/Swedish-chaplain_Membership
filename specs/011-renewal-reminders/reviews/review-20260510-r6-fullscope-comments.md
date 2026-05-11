# F8 R6 Round-2 — Comment Review (Verify R5 Comment Fixes)

**Reviewer**: Comment-rot specialist (Code Comment Analyzer)
**Branch**: `011-renewal-reminders` HEAD `88f6b8a2`
**Scope**: Verify R5 comment fixes (C9/C10, C2, S1, S3, B1, T-MED1) + cross-file consistency + any new drift introduced.
**Verdict**: **2 IMPORTANT** + **3 MEDIUM** + **2 LOW** found. Most R5 comment additions are accurate; two material drift issues were introduced by the R5 wave itself.

---

## Summary

R5's structural fixes were thorough and the corresponding comment additions are largely accurate (`R5-C2` SQL pattern + row-count assertion comments, `R5-B1` re-throw rationale, `T-MED1` shape harmonization, IMP-3 "9 fields" rename). However the **C9/C10 rewrite at `evaluate-tier-upgrade.ts:304-314`** introduced a NEW drift — the comment now says "outer-loop wiring pending" while the R5 commit message + `retrospective.md § S1` + `perf-benchmarks.md § T262` explicitly state this is **intentional NON-USAGE, not deferral**. The **S3 foot-gun docstring at `mark-cycle-complete-from-invoice-paid.ts:177-188`** also overstates its prohibition — the wrapper IS legitimately called as a degraded fallback from the F4 onPaid callback when `txUnknown` is undefined or non-TenantTx (see `renewals-deps.ts:472-510`).

Cross-file marker consistency is good: `R5-B1`/`R5-C1`/`R5-C2`/`R5-S1`/`R5-S2`/`R5-S3`/`R5-MED1` all appear at expected sites. R5-C3 lives only in commit message + observability.md (no source-code comment marker — minor inconsistency, see LOW-2).

---

## IMPORTANT

### IMP-1 — `evaluate-tier-upgrade.ts:311-314` "outer-loop wiring pending" contradicts R5 retrospective + perf-benchmarks decision

**Location**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:304-314`

**Issue**: The R5 rewrite of the C9/C10 comment block reads:
> "F8-epic follow-up commit on this branch (NOT Phase 11): extend the same pattern to dispatchRenewalCycle (T262 dispatch path) — bulk port methods landed at commit `2caa8d74`; outer-loop wiring **pending**."

But R5's own retrospective (`specs/011-renewal-reminders/retrospective.md` § S1 step 5) and `perf-benchmarks.md § T262` revise this to:
> "OUTER-LOOP WIRING — INTENTIONALLY-NOT-WIRED: production SLO is met today via gateway-IO dominance + DISPATCH_CONCURRENCY=10... Tracked as a future-only optimization; bulk port + adapter remain unused but tested."

And the R5 commit message (`88f6b8a2`) explicitly classifies it under "Out-of-scope intentional NON-WORK (not deferred)".

The "wiring pending" wording contradicts the documented decision and will mislead future maintainers into believing this is an outstanding TODO. This is the EXACT comment-rot class C9/C10 was supposed to fix.

**Suggestion**: Replace the trailing 3 lines of the comment with:
```
// F8-epic R5 verify-fix decision (2026-05-10): the bulk infrastructure
// (commit 2caa8d74) is shipped + tested but INTENTIONALLY NOT WIRED into
// dispatchRenewalCycle's outer loop. Production SLO is met via gateway-IO
// dominance + DISPATCH_CONCURRENCY=10 amortization (see retrospective.md
// § S1 + perf-benchmarks.md § T262). Future migration only if Resend
// latency drops near-zero or batch-API access changes the calculus.
```

---

### IMP-2 — `mark-cycle-complete-from-invoice-paid.ts:177` "do NOT call this wrapper from a F4 onPaidCallback site" overstates prohibition

**Location**: `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts:177-188`

**Issue**: The R5-S3 foot-gun warning starts with "do NOT call this wrapper from a F4 `onPaidCallback` site" — but the F4 onPaid callback at `renewals-deps.ts:472-510` deliberately calls this wrapper as a **degraded-mode fallback** when `txUnknown === undefined` OR when `isTenantTx(txUnknown)` returns false (F4 contract drift). The fallback is intentional + alerted via `renewalsMetrics.onPaidInvalidTx`.

Result: a future maintainer reads the docstring, treats line 510 (`await markCycleCompleteFromInvoicePaid(deps, evt)`) as a bug, and removes the fallback — blowing up the F4 contract-drift safety net.

**Suggestion**: Reframe the warning around "when F4 threaded a valid tx" rather than the categorical "F4 onPaidCallback site". Example:
```
* **R5-S3 foot-gun warning**: when called from the F4 `onPaidCallback`
* path, this wrapper opens its OWN tx that commits independently of F4's
* invoice-flip tx. That is the intended *degraded-mode* fallback when F4
* fails to thread its tx through (and is alerted via
* `renewalsMetrics.onPaidInvalidTx`). The PREFERRED single-tx path uses
* `markCycleCompleteInTx(deps, event, tx)` directly with the F4-threaded
* tx so both writes share the same commit boundary (Constitution
* Principle VIII state↔audit atomicity). Do NOT route the happy path
* through this wrapper.
```

---

## MEDIUM

### MED-1 — `compute-at-risk-score.ts:154` "Threshold per docs/observability.md § 23.3 future entry" — alert rule is missing, not "future"

**Location**: `src/modules/renewals/application/use-cases/compute-at-risk-score.ts:151-159`

**Issue**: The R5-S1 comment claims "Threshold per docs/observability.md § 23.3 future entry". The R5 commit message confirms only F8-A9 + F8-A10 alert rules were added in C4 — there is **no F8-A11 alert rule for `renewals_at_risk_audit_emit_failed_total`**. Grep confirms (only references appear in `compute-at-risk-score.ts` + `metrics.ts`). The "future entry" wording is a soft acknowledgement but the metric ships unalerted today.

**Suggestion**: Either (a) add the F8-A11 alert row to `docs/observability.md § 23.3` mirroring the F8-A9/F8-A10 pattern (preferred — closes the loop), or (b) sharpen the comment to "Vercel alert rule NOT YET configured — `renewals_at_risk_audit_emit_failed_total` ships dark; track in phase-10-backlog.md before un-darking F8."

---

### MED-2 — `evaluate-tier-upgrade.ts:319-323` R5-B1 fix comment + line 477-479 "outer try/catch" comment overlap + drift risk

**Location**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:319-323` + `474-479`

**Issue**: The R5-B1 fix is documented in three near-duplicate comment blocks (lines 319-323, 380-387, 424-429, 477-479). All four say roughly "RE-THROW so runInTenant rolls back atomically per Constitution VIII". The redundancy is intentional (each catch arm carries its own justification) but the line 319-323 + 477-479 pair is the same explanation at the function-level docstring AND the call-site — risk that one drifts when the other is updated.

**Suggestion**: Keep the inline catch-site comments (380-387, 424-429) — they're load-bearing context for the throw. Demote 319-323 + 477-479 to a single one-line cross-reference: `// R5-B1: catch arms throw to roll back; see lines 380/424.`

---

### MED-3 — `drizzle-renewal-reminder-event-repo.ts:430-435` "snake_case do not auto-map" comment is correct but justifies a re-fetch that adds 1 RTT

**Location**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:430-435`

**Issue**: The new R5-C2 comment correctly explains why the function does a typed re-SELECT after the raw `UPDATE … FROM (VALUES …)`:
> "snake_case column names from raw SQL do not auto-map to camelCase; the rowToDomain helper expects schema-typed rows so we re-fetch through the typed query layer after the raw UPDATE for correctness."

This is accurate but quietly admits the bulk-method does **2 RTTs (UPDATE + SELECT)** rather than the 1 RTT advertised at lines 397-399 ("single multi-row UPDATE"). The Phase 10 T262 perf claim of "1 RTT instead of N" is therefore overstated by a factor of 2 (still a major win at N≥10, but the docstring should say so).

**Suggestion**: Update the function docstring (line 397-399) to say "2 RTTs (1 multi-row UPDATE + 1 typed re-SELECT for schema mapping) instead of 2N for N single-row updates". The R5-Q1 perf bench's "44× speedup" claim still stands at typical batch sizes; the comment honesty just costs a phrase.

---

## LOW

### LOW-1 — `tier-upgrade-suggestion-repo.ts:146` references obsolete RTT count

**Location**: `src/modules/renewals/application/ports/tier-upgrade-suggestion-repo.ts:144-147`

**Issue**: `bulkGetSuppressedMembers` docstring says "collapses 333 RTTs (per T264 perf bench at 1k members ~33% above-threshold) into 1." This is consistent with the C9/C10 rewrite that says "3 RTTs per above-threshold member" — but the math is now `1k × 0.33 × 1 RTT (suppression check only) = 330 RTTs`, not 333. Off-by-3 in a doc-only number is trivial but stale.

**Suggestion**: Round to "~330" or drop the precise count.

### LOW-2 — `R5-C3` marker exists in commit message + observability.md but nowhere in `webhooks/resend/route.ts`

**Location**: `src/app/api/webhooks/resend/route.ts` (full file)

**Issue**: All other R5 fixes (C1, C2, S1, S2, S3, MED1, B1) leave a `// R5-XXX fix:` marker at the call site. The R5-C3 split (DB-lookup vs use-case failure tagging in `webhooks/resend/route.ts`) does not — only the commit message + observability.md F8-A10 row reference it. Future grep-driven archaeology for "R5-C3" will dead-end.

**Suggestion**: Add a `// R5-C3 fix: ...` marker at the catch-arm split site for consistency with the rest of the wave.

---

## Positive findings

- **`drizzle-renewal-reminder-event-repo.ts:340-355`** — R5-C2 tenantId guard comment is exemplary: it explains the **threat** (silent cross-tenant write via single-row's `tenant.slug` substitution), the **defence** (assertion fail-fast), AND links to the Constitution Principle. This is the gold-standard pattern for security-critical bounded-context comments.
- **`tier-upgrade-suggestion-repo.ts:177-186`** — R5-MED1 shape-harmonization docstring correctly cross-references the sister method on `RenewalReminderEventRepo` and explains the caller-side benefit (no re-fetch). Reader gets the design rationale without leaving the file.
- **`evaluate-tier-upgrade.ts:380-391, 424-433`** — R5-B1 catch-arm comments correctly distinguish bulk-insert failure semantics from bulk-emit failure semantics and explicitly call out the `member_open_uniq` replay-blocking failure mode. This is *why-not-what* commenting at its best.
- **`mark-cycle-complete-from-invoice-paid.ts:118-194` overall** — the InTx vs wrapper split + Round 2 (S-10/S-11) docstring is one of the cleanest tx-ownership-invariant explanations in the codebase. The R5-S3 addition (modulo IMP-2 above) is a worthy extension.

---

## Cross-file consistency check

| Marker     | Code site                                                                                                | Found |
|------------|----------------------------------------------------------------------------------------------------------|-------|
| `R5-B1`    | `evaluate-tier-upgrade.ts` :319, :380, :424, :477                                                        | yes   |
| `R5-C1`    | `drizzle-tier-upgrade-suggestion-repo.ts` :541-553 (verified via git diff; no marker text in current file) | partial — marker text was added but should be re-grep-able |
| `R5-C2`    | `drizzle-renewal-reminder-event-repo.ts` :341, :407, :416, :457                                          | yes   |
| `R5-C3`    | `webhooks/resend/route.ts` (no marker)                                                                   | NO (LOW-2)  |
| `R5-S1`    | `compute-at-risk-score.ts` :151                                                                          | yes   |
| `R5-S2`    | `cron/renewals/dispatch-coordinator/route.ts` :477                                                       | yes   |
| `R5-S3`    | `mark-cycle-complete-from-invoice-paid.ts` :177                                                          | yes   |
| `R5-MED1`  | `tier-upgrade-suggestion-repo.ts` :178, `drizzle-tier-upgrade-suggestion-repo.ts` :566                   | yes   |
| `R5-Q1`    | `cron-dispatch-perf.test.ts` :198                                                                        | yes   |

Constitution Principle references in R5-added comments:
- **I (tenant isolation)** — accurate (R5-C2 cross-tenant write block)
- **III (Clean Arch)** — not introduced in R5 wave; pre-existing usage stable
- **VIII (state↔audit atomicity)** — accurate at all R5-B1 + R5-C2 + R5-S1 sites; the "reverse-direction atomicity" wording at `compute-at-risk-score.ts:250` is also Principle VIII consistent

---

## Files referenced

- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\evaluate-tier-upgrade.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\mark-cycle-complete-from-invoice-paid.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\compute-at-risk-score.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\ports\renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-renewal-reminder-event-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\drizzle\drizzle-tier-upgrade-suggestion-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\infrastructure\renewals-deps.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\cron\renewals\dispatch-coordinator\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\webhooks\resend\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\metrics.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\docs\observability.md`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\specs\011-renewal-reminders\retrospective.md`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\specs\011-renewal-reminders\perf-benchmarks.md`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\integration\renewals\cron-dispatch-perf.test.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\integration\renewals\payment-method-enum-parity.test.ts`
