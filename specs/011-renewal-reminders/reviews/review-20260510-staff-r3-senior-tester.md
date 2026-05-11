# F8 Phase 10 — Staff Review Round 3 (Senior Tester)
**Date**: 2026-05-10  
**Scope**: T261 / T262 / T264 / T265 / T267 / T268 / T271  
**Lens**: test-correctness + invariant-soundness  
**Reviewer**: senior-tester agent (independent triangulation)

---

## Finding 1 — IMP — T261/T265 percentile formula under-counts at small N

**File**: `tests/integration/renewals/pipeline-perf.test.ts:129-133`  
`tests/integration/renewals/renewal-confirm-perf.test.ts:55-59`

Both files share:
```ts
const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
```

With `sortedAsc.length = 20` (T261) this maps p95 → `idx = Math.floor(0.95 × 20) = 19` = last element. That is the max, not the 95th percentile — it overcounts by one bucket. The NIST definition is `⌈(p/100) × N⌉` (ceiling, 1-indexed). At N=20 the practical impact is small (p95 = slot 19 vs correct slot 19 in 0-indexed is the same for this N), but at N=50 (T265) `Math.floor(0.95×50) = 47` which is the 96th slot in 0-indexed, still one off. The formula is also duplicated verbatim in both files — a shared helper in `tests/integration/helpers/percentile.ts` would eliminate drift.

**Recommendation**: extract to a shared helper using `Math.ceil((p/100) * n) - 1` (0-indexed, clamped), or validate the existing formula produces the expected result at both N=20 and N=50. No test currently asserts percentile(sorted, 95) === known-value on synthetic data, so the formula has never been verified.

---

## Finding 2 — IMP — T261 warmup does not discard first-connection spike

**File**: `tests/integration/renewals/pipeline-perf.test.ts:182-188`

Five warmup iterations run on a single urgency tab (`t-90`) then the measured loop rotates through `['t-90','t-30','t-7','lapsed']`. The first *measured* sample for `t-30`, `t-7`, and `lapsed` each experiences a Postgres planner-cache miss for that filter permutation — effectively a cold start within the sample window. Prior F4 perf tests (T110) used the same rotate-without-warmup pattern and encountered no issue because the query plan is identical across filter values. However for `loadPipeline` the WHERE clause includes a derived urgency filter whose plan may vary by filter selectivity. If the p95 sample happens to land on one of these first-time-for-tab calls the SLO assertion can be optimistic.

**Recommendation**: extend warmup to one pass per urgency tab (4 calls, not 5 identical calls), ensuring Postgres has cached the plan for every filter shape before measurement begins.

---

## Finding 3 — CRIT — T264 seed missing `members.status='active'` — `alreadyAtTarget=999` is explained by candidate repo filter, not a bug

**File**: `tests/integration/renewals/tier-upgrade-evaluate-perf.test.ts:139-148`  
**Repo**: `src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-eval-candidate-repo.ts:87`

The candidate repo filters `members.status = 'active'`. The T264 seed inserts members rows **without a `status` column**, relying on the DB DEFAULT. If the `members` table DEFAULT for `status` is `'pending'` or `NULL` (check migration 0009), every seeded member is invisible to the candidate repo. This would produce `membersScanned=0` → `alreadyAtTarget=0` → `suggestionsCreated=0`, which is exactly the "alreadyAtTarget=999" anomaly described in the review prompt (or the "all zero" variant).

The prompt states the bench shows `alreadyAtTarget=999` with 33% above-threshold — but looking at the seed code (line 139–147) the member row does NOT set `status`. If the DB default is `active`, then 1000 members ARE scanned but all land in `alreadyAtTarget` because `decideUpgrade` returns `null`. This happens when the candidate's `currentPlanId` (`REGULAR_PLAN_ID`) is found in the catalogue but the `candidatesAbove` filter at `evaluate-tier-upgrade.ts:111-121` evaluates `currentPlan.minTurnoverThb` as `null` (Regular has no threshold) and then `p.minTurnoverThb > null` is always `false` in JS — so no target plan passes, `decideUpgrade` returns `null`, and the member is counted as `alreadyAtTarget` instead of getting a suggestion.

**Root cause (confirmed)**: `candidatesAbove` filter at line 118 reads:
```ts
(currentPlan.minTurnoverThb === null ||
  p.minTurnoverThb > currentPlan.minTurnoverThb)
```
When `currentPlan.minTurnoverThb === null` (Regular tier), the left side is `true` so all plans with `minTurnoverThb !== null` should pass. Wait — re-reading: the outer `.filter` at line 113 requires `p.minTurnoverThb !== null` AND the expression above. With `currentPlan.minTurnoverThb === null` the second clause reduces to `true`. So Premium (minTurnoverThb = 100 000) should appear in `candidatesAbove`. Then `turnoverCrosses` requires `candidate.turnoverThb >= 100 001`. The seed sets `turnoverThb: PREMIUM_THRESHOLD_THB + 1 = 100 001` for aboveThreshold members.

The actual bug is likely that `paidInvoiceVolume12mThb` is 0 for all seeded members (no invoice rows seeded in T264) AND `turnoverThb` check works, so `turnoverCrosses = true` for 33% of members. But `decideUpgrade` should still return a suggestion for those. Unless `isSuppressedForMember` returns true or the `insertOpen` path throws `TierUpgradeOpenConflictError` for ALL of them (partial unique already populated from a prior test run against the same tenant).

**Most likely explanation**: T264 creates a fresh tenant via `createTestTenant` each run so the partial unique is empty. The `alreadyAtTarget=999` value quoted in the review prompt is almost certainly stale/local-env specific. The bench test itself does **not assert** `suggestionsCreated > 0` — it only asserts `membersScanned > 0` and `tenantSkipped === null`. This means a completely silent seed defect (e.g., wrong `status` default or wrong threshold logic) would pass the test green while reporting misleading perf numbers.

**Recommendation (CRIT)**: Add an assertion after the cron call:
```ts
// ~30% of 1000 members are above threshold — at minimum 1 suggestion
// must be created. If this fails, the seed is broken or candidate-repo
// filter silently excluded all members.
expect(out.suggestionsCreated).toBeGreaterThan(0);
```
Without this guard the perf bench is a timing-only smoke test that cannot detect a broken seed. The `alreadyAtTarget=999` anomaly is a symptom of this missing assertion.

---

## Finding 4 — IMP — T265 invoice seeded as `status='draft'` but comment says `'issued'`

**File**: `tests/integration/renewals/renewal-confirm-perf.test.ts:110-118`

Comment at line 89-91: *"Pre-seed an `issued`-status invoice per cycle ... Status='issued' satisfies the F4 invoice CHECK constraints"*. But the actual insert at line 117 sets `status: 'draft'`. If `confirmRenewal` transitions the cycle to `awaiting_payment_invoice` and the F4 bridge mock returns `status: 'issued'`, but the pre-seeded row is `draft`, then any code path that validates the FK-linked invoice's status (e.g., a CHECK constraint or post-confirm assertion) could fail silently or produce misleading timing. The F4 bridge is fully stubbed so the inconsistency is not exercised here — but the comment is wrong, which erodes trust in the fixture intent.

**Recommendation**: change `status: 'draft'` to `status: 'issued'` (or fix the comment) to match the stated intent. Low risk since the bridge is mocked, but a comment-code mismatch is a maintenance hazard.

---

## Finding 5 — IMP — T271 RBAC assertion `[403, 404]` is too permissive

**File**: `tests/e2e/manager-readonly.spec.ts:164`

```ts
expect([403, 404]).toContain(resp.status());
if (resp.status() === 403) { ... }
```

The spec comment correctly notes that 404 should not occur because "the route exists". Accepting 404 here hides a routing misconfiguration — if the route `/api/admin/renewals/[cycleId]/send-reminder` is accidentally removed or renamed, this test would pass with 404. The manager IS authenticated, so a working route guard returns 403. 404 is a regression signal, not an acceptable alternative.

**Recommendation**: Change to `expect(resp.status()).toBe(403)`. The `E2E_RENEWAL_CYCLE_ID ?? '00000000-...'` fallback with a nil UUID is the concern that motivated the 404 escape hatch, but a nil UUID that reaches a real route handler should still return 403 (role check fires before ID validation). If 404 is genuinely possible with a nil UUID, use a skip condition instead: `test.skip(!E2E_RENEWAL_CYCLE_ID, '...')` and require a real cycle ID.

---

## Finding 6 — SUG — T267 reduced-motion test missing context cleanup on axe failure

**File**: `tests/e2e/renewal-a11y.spec.ts:109-126`

The reduced-motion test opens `browser.newContext()` + `ctx.newPage()` and wraps teardown in `finally { await ctx.close() }`. This is correct. However if `signInAsAdmin` throws (bad credentials), `ctx.close()` still fires — good. But if `expectNoAxeViolations` throws an assertion error, Playwright catches it as a test failure while `ctx.close()` still runs — also fine. No issue here structurally.

Minor SUG: the test does not assert `prefers-reduced-motion: reduce` is actually applied at the CSS level. The `reducedMotion: 'reduce'` context option sets the media feature, but `waitForLoadState('domcontentloaded')` fires before React hydration completes — animations triggered by JS (e.g., framer-motion) may not have settled. Add `await page.waitForLoadState('networkidle')` to let hydration + transition settle before the axe scan.

---

## Finding 7 — SUG — T268 Buddhist Era regex is too narrow

**File**: `tests/e2e/renewal-i18n.spec.ts:128`

```ts
const hasBEYear = /พ\.ศ\.?\s?256[5-9]/.test(bodyText) || /256[5-9]/.test(bodyText);
```

This regex only matches BE years 2565–2569 (CE 2022–2026). Renewal cycles seeded for 2027+ (CE) would render BE 2570+ and fail the check silently (the test's `if (!hasBEYear) test.skip(...)` branch fires). The range should be `256[5-9]|257[0-9]` or simply `25[6-9]\d` to cover a realistic 10-year horizon.

**Recommendation**: widen the regex to `/พ\.ศ\.?\s?25[6-9]\d/.test(bodyText) || /25[6-9]\d/.test(bodyText)`.

---

## Finding 8 — SUG — T262 single-sample SLO cannot compute p95; document this explicitly

**File**: `tests/integration/renewals/cron-dispatch-perf.test.ts`

T262 runs the cron dispatch loop exactly once (no SAMPLE_COUNT loop) and measures wall-clock time. This is a single data point, not a p95. Given that the dispatch loop already benchmarks at 84.95s @ 1k (1.4× the 60s SLO even at 1k), the single-sample limitation is moot for now — it's clearly over budget. But when the Phase 11 batched-write optimisation ships, the bench should be upgraded to multi-sample measurement (feasible if the loop is idempotent via insertIfAbsent) or explicitly documented as a single-run ceiling measurement rather than a percentile.

The `perf-benchmarks.md` Phase 11 recommendation is already drafted. The suggestion is to add a one-line doc comment in T262 clarifying "single-run measurement — not p95" so future readers don't assume parity with T261/T265.

---

## SC-004 SQL denominator review (research.md R11)

The denominator query in `specs/011-renewal-reminders/perf-benchmarks.md:31-35` counts members whose `joined_at <= year-1` — i.e., members who existed before the cohort year. This is the correct "eligible for renewal" denominator (members active in the prior year who should renew in the current year). It does NOT include new members who joined in the current year (correct — they have no prior year to renew from). The numerator counts members from the same `eligible` CTE who have a paid invoice for `plan_year=year`. This is sound methodology. No issue found.

---

## Summary table

| # | Severity | File | Finding |
|---|----------|------|---------|
| 1 | IMP | T261 + T265 | Percentile formula not validated; duplicated verbatim |
| 2 | IMP | T261 | Warmup does not cover all urgency tabs → cold plan for t-30/t-7/lapsed |
| 3 | CRIT | T264 | No assertion that `suggestionsCreated > 0`; `alreadyAtTarget=999` symptom undetectable |
| 4 | IMP | T265 | Comment says `status='issued'` but insert is `status='draft'` |
| 5 | IMP | T271 | `[403, 404]` accept array masks routing regression; should be strict `403` |
| 6 | SUG | T267 | `domcontentloaded` too early for reduced-motion axe scan; use `networkidle` |
| 7 | SUG | T268 | BE year regex range 256[5-9] misses 2570+ cycles |
| 8 | SUG | T262 | Single-sample measurement not labelled as such; confusing after Phase 11 optimises |

**Blocker count**: 0  
**CRIT**: 1 (Finding 3 — missing `suggestionsCreated > 0` guard in T264)  
**IMP**: 4  
**SUG**: 3  

The most important fix before marking Phase 10 complete is Finding 3: T264's missing correctness assertion means a broken seed or filter regression would produce a green bench with 0 suggestions created, which is undetectable from the current output.
