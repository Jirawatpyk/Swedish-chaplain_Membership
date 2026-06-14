All three core findings confirmed at source: the W0-02 change-plan race (no `deleted_at` re-check after lock acquisition at line 242, write at 260-263 uses pre-tx snapshot), the snooze sibling correctly emits outside the callback gated on `txResult.ok`, and the outreach emit incorrectly sits inside the callback. The `softDeleteGuarded` confirms the counterfactual mechanism. Findings are sufficiently verified — writing the report.

# Code Review — Go-Live Hardening Arc (HEAD~12..HEAD, PRs #55–#63)

## 1. Headline

**16 findings total: 4 CONFIRMED correctness · 1 PLAUSIBLE correctness · 3 altitude · 4 cleanup** (the 5th/6th/7th/8th in the list overlap — counted once below).

Breaking it down by kind across the verified set: **5 correctness (4 CONFIRMED + 1 PLAUSIBLE)**, **3 altitude/observability (CONFIRMED)**, **5 cleanup/reuse (CONFIRMED)**.

**Ship-blocker: YES — one.** Finding #1 (`change-plan.ts:242`) means the W0-02 advisory-lock refactor **did not actually close** the soft-delete-vs-assign race it was built for: a member can still be attached to a soft-deleted plan. Two of the three correctness items are go-live **data-loss** bugs in the one-time member importer (#2, #4, #5 below) that will silently drop real SweCham members during the `--commit` run. These should be fixed before the importer is run against production data.

## 2. Findings Table

| # | file:line | kind | verdict | one-line summary |
|---|-----------|------|---------|------------------|
| 1 | `members/.../change-plan.ts:242` | correctness | CONFIRMED | W0-02 lock never re-checks new plan `deleted_at` in the critical section → member assigned to soft-deleted plan (race + sequential) |
| 2 | `import-members/columns.ts:95` | correctness | CONFIRMED | single-token full name → `lastName:''` → `contactLastName required` error drops the whole member at `--commit` |
| 3 | `import-members/validate.ts` (group key) | correctness | CONFIRMED | members grouped by company display name only → two distinct legal entities merge into one; second company lost |
| 4 | `import-members/validate.ts` (emailCounts) | correctness | CONFIRMED | global email dup map, no company scoping → intra-member dup row drops the whole member as `duplicate_in_import` |
| 5 | `auth/.../enable-user.ts:75` (+`disable-user.ts`) | correctness | PLAUSIBLE | null read-after-write returns 404 after `enable()`+audit already committed → audit/DB vs API disagree |
| 6 | `cron/.../at-risk-recompute-coordinator/route.ts` (+3) | altitude | CONFIRMED | 4 coordinators omit `rateLimitFallbackCounter` → Upstash fail-open never increments alert counter |
| 7 | `cron/broadcasts/dispatch-scheduled/route.ts` | altitude | CONFIRMED | W2-05 typed err re-buckets infra failure from `uncaught_error` (page-now) to `unknown_error` |
| 8 | `lib/metrics.ts:2912` (`pipelineRowCount`) | altitude | CONFIRMED | 3rd hand-rolled gauge accumulator + manual `indexOf(':')` split; should use `observeGauge` (colon-split risk REFUTED) |
| 9 | `renewals/.../record-at-risk-outreach.ts:169` | correctness* | CONFIRMED | metric emit INSIDE tx callback → over-count on commit-time failure (unlike sibling snooze fix) |
| 10 | `tests/integration/plans/soft-delete-toctou-...test.ts` | test gap | CONFIRMED | "race closed" test runs sequentially → cannot detect lock removal (lock-rot blind) |
| 11 | `tests/unit/renewals/.../record-at-risk-outreach.test.ts` | test gap | CONFIRMED | vacuous: mock `runInTenant` has no commit phase → cannot catch #9's over-count |
| 12 | `cron/.../*-coordinator/route.ts` (×5) | cleanup | CONFIRMED | coordinator-metrics block copy-pasted ~10 sites; no `coordinatorSummary(kind, summary)` helper |
| 13 | `api/portal/account/data-export/route.ts` (+~24) | cleanup | CONFIRMED | rate-limit→429→Retry-After block hand-copied across ~25 routes; only `retryAfterSecondsFromRl` shared |
| 14 | `components/members/members-table.tsx` | cleanup | CONFIRMED | InlineCountry/NotesCell duplicate identical Enter/Space `onKeyDown`; no `activateOnEnterSpace` helper |
| 15 | `plans/.../plan-repo.ts:327` | cleanup | CONFIRMED | `softDelete` method + port decl now dead code (lock-less); footgun re-opens W0-02 TOCTOU if called |

\* #9 is a correctness defect in observability state (counter over-count), surfaced via the test-gap finding #11.

## 3. Per-Finding Detail — Correctness

### #1 — W0-02 advisory lock does not re-validate plan `deleted_at` (SHIP-BLOCKER)
`src/modules/members/application/use-cases/change-plan.ts:242`

**Failure scenario.** Concurrent: admin A soft-deletes plan `gold` (0 members → `softDeleteGuarded` wins the lock, counts 0, sets `deleted_at`, commits, releases). Admin B's `changePlan` then acquires the same key and writes member M onto `gold` — **never re-reading `deleted_at`**. The lock serialized them but B's write uses the pre-tx `newPlan` snapshot. Also fires **purely sequentially**: assigning to an already-soft-deleted plan succeeds, because neither the pre-tx `getPlan`/`findOne` (no `deleted_at IS NULL` filter; `PlanSummary` omits the column) nor the in-tx `updateFieldsInTx` filters on deletion.

**Quoted (verified at source).** Lock acquired 242, member-only re-read 250, write from snapshot 260-263:
```ts
await deps.planAdvisoryLock.acquire(tx, lockKey);
const lockedResult = await deps.memberRepo.findByIdInTx(tx, memberId);   // re-reads MEMBER only
const updated = await deps.memberRepo.updateFieldsInTx(tx, memberId, {
  planId: newPlan.value.planId,        // <- pre-tx snapshot, line 174; no deleted_at check
  planYear: data.new_plan_year,
});
```

**Fix.** Inside the lock, after acquiring it, re-read the NEW plan in-tx and abort if soft-deleted:
```ts
const planNow = await deps.plans.findByIdInTx(tx, newPlan.value.planId, data.new_plan_year);
if (!planNow || planNow.deletedAt !== null) throw new TxAbort({ type: 'plan_not_found' });
```
Add `deleted_at` to the `PlanSummary` port/adapter (or a dedicated in-tx lookup) so the validation read is also deletion-aware, and add a genuinely concurrent regression test (see #10).

### #2 — Mononym contact name drops the member at import
`scripts/import-members/columns.ts:95` → `validate.ts:256/311`

**Failure scenario.** A row with a single-word contact name ("Madonna", Thai given-name-only, single-display-name company) and no separate first/last columns: `splitFullName` returns `{firstName: full, lastName: ''}` → `blankToNull('') === null` → `contactLastName 'required'` error → `memberHasError = true` → member not pushed. Worse, `import-members.ts:306-313` **refuses the entire `--commit`** when `errorCount > 0`, so one mononym blocks every member until the operator edits data.

**Quoted.** `columns.ts:95` `if (parts.length <= 1) return { firstName: full.trim(), lastName: '' };` · `validate.ts:256` `if (blankToNull(r.contactLastName) === null) err(r.rowIndex, 'contactLastName', 'required');`

**Fix.** For a single-token name, treat it as the last name (or accept first-only) rather than emitting a blocking `required` error — Thai given-name-only and single-display-name entities are legitimate. Downgrade to a warning if surname truly cannot be derived, or seed `lastName` from `firstName` when only one token exists.

### #3 — Distinct companies merged by shared display name
`scripts/import-members/validate.ts` (`normCompanyKey` group key)

**Failure scenario.** Two different legal entities both listed as "Nordic Trading" (different tax IDs/tiers) group under one key (trim+lowercase+collapse-ws); only the **head row's** country/tier/tax_id/date survive, the sibling's contacts attach to the head, and the second company is never created. The only signal is a `warning` (gated on the head resolving), which never blocks `--commit`.

**Fix.** Include a stable disambiguator (tax_id, or row-explicit company-id) in the group key, or escalate the sibling-mismatch from `warning` to a blocking `error` when tax_id/tier differ within a group, so the operator must split the rows.

### #4 — Cross-import email-dup map drops legitimate single-member duplicates
`scripts/import-members/validate.ts` (global `emailCounts`)

**Failure scenario.** Same primary email pasted twice for one company → global `emailCounts[email]=2` → both rows get `duplicate_in_import` error → `memberHasError` → member dropped. No intra-member vs cross-member distinction; the operator gets a generic duplicate error for what is a dedupable within-member typo.

**Quoted.** `emailCounts.set(e.value, (emailCounts.get(e.value) ?? 0) + 1)` (global, no group scope) → `if ((emailCounts.get(email.value) ?? 0) > 1) err(r.rowIndex, 'contactEmail', 'duplicate_in_import')`.

**Fix.** Key the dedup map by `(companyKey, email)` and de-duplicate identical contacts within a member silently (or warn), reserving the `duplicate_in_import` error for the same email appearing across **distinct** company groups.

### #9 — Outreach metric emitted inside the tx callback → commit-failure over-count
`src/modules/renewals/application/use-cases/record-at-risk-outreach.ts:169`

**Failure scenario.** The COMMIT happens after the callback returns but before `runInTenant` resolves. On a commit-time failure (Neon drop / serialization error / statement timeout at COMMIT), the INSERT + audit roll back but `renewals.at_risk.outreach_recorded_total` has already incremented → counter diverges above durable rows. Violates the project invariant *"emit OTel metrics AFTER commit only"* (Principle VIII).

**Quoted (verified — emit is INSIDE the callback, lines 169-174, `});` closes at 175):**
```ts
// W0-09: ... emitted AFTER tx commit (same rationale as atRiskSnooze ...)  <- comment is FALSE
renewalsMetrics.atRiskOutreachRecorded(input.tenantId, input.channel, input.templateId);
return ok(inserted);
});
```
The sibling `snooze-at-risk-member.ts:115-117` (same W0-09 range) does it correctly: `const txResult = await runInTenant(...); if (txResult.ok) renewalsMetrics.atRiskSnooze(...)` — **outside** the callback, gated on commit.

**Fix.** Mirror snooze exactly: capture `txResult`, move the `renewalsMetrics.atRiskOutreachRecorded(...)` after `await runInTenant(...)`, gate on `if (txResult.ok)`. Then update test #11 to simulate a commit-phase failure.

### #5 — enable/disable read-after-write returns 404 after committing side effects (PLAUSIBLE)
`src/modules/auth/application/enable-user.ts:75` (+`disable-user.ts:123`)

**Failure scenario.** `enable()` (commits status flip) and `audit.append('account_reenabled')` (commits) are separate non-transactional awaits on the global `db`. If the row is concurrently hard-deleted in the gap before `findById`, `updated` is null → returns `{code:'not-found'}` → route 404. The account **is** enabled and the audit row exists, but the API says it doesn't exist. PLAUSIBLE (not CONFIRMED) because it requires a concurrent hard-delete in a narrow window.

**Quoted.** `await deps.users.enable(target.id);` → `await deps.audit.append({eventType:'account_reenabled', ...});` → `const updated = await deps.users.findById(target.id); if (!updated) return err({ code: 'not-found' });`

**Fix.** Wrap enable + audit + re-read in a single `runInTenant`/transaction with a row lock (the codebase already has `findByIdInTx` with `.for('update')`), so a null re-read and the side effects can never disagree. Lower priority than #1–#4 given the contingent trigger, but it is a genuine reverse-atomicity gap.

## 4. Cleanup / Altitude (brief)

- **#6 (altitude, real):** 4 of 5 renewals coordinators omit `rateLimitFallbackCounter`; only `dispatch-coordinator` forwards `() => renewalsMetrics.redisFallback()`. On Upstash fail-open the counter that Vercel alert rules bind to never increments — the Upstash-degradation alert stays dark on those 4 routes. (Note: `cronBearerAuthRejected` still fires, so on-call isn't *entirely* blind to the auth burst — but rate-limiter health is uncovered.) **Fix:** add `rateLimitFallbackCounter: () => renewalsMetrics.redisFallback()` to all four.
- **#7 (altitude, real):** W2-05's typed `err({kind:'dispatch.server_error'})` for a members-bridge throw now lands in the cron caller's `default` arm (`unknown_error` / "should be 0" / contract-drift signal) instead of the old `catch (e)` `uncaught_error` (page-immediately). Retry safety unchanged. **Fix:** add `case 'dispatch.server_error'` mapping it to `uncaught_error`, or have the use-case keep throwing for infra failures.
- **#8 (altitude, dup confirmed / dramatic risk REFUTED):** `pipelineRowCount` is the 3rd hand-rolled gauge accumulator; should call the existing `observeGauge` helper (its own docstring even claims it does). The colon-mis-split mislabelling **cannot** occur — `TenantSlug` regex `^[a-z0-9-]{1,63}$` forbids colons. Value is pure de-dup.
- **#10 / #11 (test gaps, confirmed):** the dedicated W0-02 race test runs sequentially (assign commits before softDelete starts) → passes even if the lock is deleted; the outreach unit test's mock `runInTenant` has no commit phase → cannot catch #9. Both give false green. Fix alongside #1 and #9 with genuinely concurrent / commit-failure tests.
- **#12 / #13 / #14 / #15 (cleanup, confirmed):** coordinator-metrics block (~10 sites, no `coordinatorSummary` helper); rate-limit→429 block (~25 routes, only `retryAfterSecondsFromRl` shared, and the 3 touched sites already diverge in envelope shape); duplicated Enter/Space `onKeyDown` in two inline cells; dead lock-less `softDelete` method + port decl in `plan-repo.ts` (footgun: re-opens the W0-02 TOCTOU if a future caller uses it — delete it, leaving `softDeleteGuarded` as the only path).

## 5. Bottom Line

**Do not run the member importer or ship the plan-change path as-is.** This arc has **four CONFIRMED correctness bugs**, and they cluster on exactly the two surfaces this go-live arc was meant to harden:

1. **#1 — the W0-02 advisory-lock refactor is incomplete.** It serializes soft-delete vs assign but never re-checks `deleted_at` inside the lock, so the precise outcome it set out to prevent (member attached to a soft-deleted plan) still happens — both under the race and in a plain sequential assign-to-deleted-plan. The dedicated regression test (#10) is sequential and would stay green even if the lock were deleted. This is a true ship-blocker.
2. **#2 + #3 + #4 — the one-time member importer silently drops/merges real members** (mononym names, shared display names, intra-member email dups). Because `--commit` refuses the whole run on any error, a single mononym blocks the entire import. These must be fixed before the production import, or you will lose SweCham member records with only per-row report lines as evidence.
3. **#9 (with #11) — outreach metric over-counts on commit failure**, diverging from the sibling snooze fix shipped in the same range. Lower blast radius (observability only) but trivially fixable by copying the snooze pattern.
4. **#5** is a PLAUSIBLE reverse-atomicity gap (404 after committed side effects) worth fixing but contingent on a concurrent hard-delete.

The altitude/cleanup items (#6–#8, #12–#15) are real and worth a follow-up pass — #6 and #7 are genuine alerting regressions that will delay incident triage — but none block.

**Recommendation: fix #1, #2, #3, #4 (and ideally #9 + tests #10/#11) before this arc goes to preview or the importer is run against production data.** The plan-change race and the importer data-loss bugs defeat the stated purpose of this hardening arc; everything else can be a fast-follow.

Relevant files:
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\members\application\use-cases\change-plan.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\scripts\import-members\columns.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\scripts\import-members\validate.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\scripts\import-members\import-members.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\record-at-risk-outreach.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\renewals\application\use-cases\snooze-at-risk-member.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\auth\application\enable-user.ts` / `disable-user.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\plans\infrastructure\db\plan-repo.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\cron\renewals\at-risk-recompute-coordinator\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\cron\broadcasts\dispatch-scheduled\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\metrics.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\integration\plans\soft-delete-toctou-advisory-lock.test.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\unit\renewals\application\use-cases\record-at-risk-outreach.test.ts`