# 15 findings (8 confirmed correctness)

## 1. [correctness/CONFIRMED] src/modules/members/application/use-cases/change-plan.ts:242  (angle=A-line-by-line)
**W0-02 advisory lock does not re-validate the new plan's deleted_at inside the critical section. changePlan validates `newPlan` exists at line 174 BEFORE the tx/lock, then acquires the lock and writes the member FK without re-reading the plan. softDeleteGuarded can win the lock first, count 0 members, soft-delete the plan, commit; then changePlan acquires the lock and assigns a member to the now-soft-deleted plan.**

_Failure:_ Concurrent admin soft-deletes plan 'gold' (0 members so it succeeds) while another admin assigns member M to 'gold'. soft-delete grabs the lock first (counts 0), deletes; change-plan then grabs the lock and writes member M onto deleted_at!=NULL 'gold'. The lock serialized the two but, because change-plan never re-checks deleted_at after acquiring the lock, the exact race W0-02 set out to close still produces a member attached to a soft-deleted plan.

_Quote:_
```
      await deps.planAdvisoryLock.acquire(tx, lockKey);

      // M1: re-read + LOCK the row inside the tx (FOR UPDATE) so the audit's
      ...
      const lockedResult = await deps.memberRepo.findByIdInTx(tx, memberId);
      ...
      const updated = await deps.memberRepo.updateFieldsInTx(tx, memberId, {
        planId: newPlan.value.planId,
        planYear: data.new_plan_year,
      });
```

_Reasoning:_ After acquiring the advisory lock at change-plan.ts:242, the critical section re-reads ONLY the member (findByIdInTx, line 250) and writes planId from the pre-tx newPlan snapshot loaded at line 174 (updateFieldsInTx, lines 260-263). It never re-reads or re-validates the new plan's deleted_at inside the lock.

The pre-tx validation path also never checks deletion: getPlan -> planRepo.findOne (plan-repo.ts:166-181) has NO `deleted_at IS NULL` filter, and PlanSummary (plan-lookup-port.ts:14-37 / adapter lines 45-72) omits deleted_at entirely. So a soft-deleted plan passes the `newPlan.ok` gate at line 176.

Race trace (claim's scenario): softDeleteGuarded (plan-repo.ts:350-388) acquires the SAME lock key (planSoftDeleteLockKey), counts members on the plan (line 360), and for a 0-member plan sets deleted_at and commits, releasing the lock. changePlan then acquires the lock, never re-checks deleted_at, and writes the member's FK onto the now-soft-deleted plan. The advisory lock serializes the two operations but, because change-plan never re-validates deleted_at after acquiring the lock, the exact outcome W0-02 aimed to prevent (a member attached to a soft-deleted plan) still occurs. No DB FK/trigger prevents assignment to a soft-deleted plan (deleted_at is a nullable timestamp on a still-present PK row).

Note: there is also a simpler purely-sequential variant of the same defect — assigning a member to an ALREADY soft-deleted plan succeeds, since neither the pre-tx lookup nor the in-tx write filters on deleted_at.

## 2. [correctness/CONFIRMED] scripts/import-members/validate.ts:1102  (angle=A-line-by-line)
**Rule-2 cross-import duplicate detection uses a global emailCounts map keyed only by lowercased email, with no scoping to distinct company groups. Two contacts in the SAME company group sharing one email, and the same email appearing across two different company rows, are both counted identically; the per-row error 'duplicate_in_import' fires on every row sharing the email but there is no way to tell an intra-member duplicate (data-entry typo within one member) from a genuine cross-member collision.**

_Failure:_ A workbook lists the same primary email twice for one company (e.g. operator pasted the same row). emailCounts=2 marks BOTH rows as duplicate_in_import errors, so the entire company is excluded from import even though it is a single legitimate member with one duplicated row — the operator gets a generic duplicate error rather than a dedupe-within-member, and a real member silently fails to import.

_Quote:_
```
  const emailCounts = new Map<string, number>();
  for (const r of rows) {
    if (normCompanyKey(r.companyName).length === 0) continue;
    const e = asEmail(r.contactEmail);
    if (e.ok) emailCounts.set(e.value, (emailCounts.get(e.value) ?? 0) + 1);
  }
...
      if ((emailCounts.get(email.value) ?? 0) > 1) {
        err(r.rowIndex, 'contactEmail', 'duplicate_in_import');
      }
```

_Reasoning:_ Note: the cited line number 1102 does not exist — the file is 347 lines and the described mechanism lives at lines 144-149 (the tally) and 252-254 (the error emit). The line citation is wrong, but the substantive claim is fully accurate, so per recall mode this is not REFUTED.

Tracing the code:
- Lines 144-149 build a GLOBAL `emailCounts` Map keyed ONLY on `e.value` (lowercased email). There is zero scoping to company groups — the only filter is skipping blank-company rows. So an email that appears twice anywhere in the workbook gets count=2, whether the two rows belong to the same company group or different ones.
- Lines 252-254: inside the per-row contacts loop, ANY row whose `emailCounts.get(email.value) > 1` gets `err(..., 'contactEmail', 'duplicate_in_import')` — an `error` (not warning).

Failure scenario walk-through (same primary email pasted twice for ONE company):
1. Both rows have the same non-blank companyName → both pass the `continue` guard → `emailCounts[email] = 2`.
2. Both rows group under the same company key (lines 153-160).
3. In the contacts loop, both rows satisfy `emailCounts.get(...) > 1` → `duplicate_in_import` error fires on BOTH rows.
4. At lines 307-309, `memberErrorsAfter > memberErrorsBefore` is true → `memberHasError = true`.
5. At line 311 the member is NOT pushed → the entire legitimate single-company member is silently excluded from import.

There is no intra-group dedup or intra-vs-cross distinction anywhere (contacts are pushed unconditionally at 277-286; emailCounts is purely global). The error code is the generic `duplicate_in_import`, giving the operator no signal that this was a within-member data-entry duplicate (which could be auto-deduped) rather than a genuine cross-member collision. Both the wrong-output behavior (whole member dropped) and the misleading-diagnostic behavior described in the candidate are exactly what the code does. CONFIRMED.

## 3. [correctness/CONFIRMED] src/modules/renewals/application/use-cases/record-at-risk-outreach.ts:169  (angle=B-removed-behavior)
**W0-09 added `renewalsMetrics.atRiskOutreachRecorded(...)` INSIDE the `runInTenant(async (tx) => {...})` callback (line 169, before `return ok(inserted)` on line 174 which is still inside the callback). The comment on line 166 claims it is "emitted AFTER tx commit (same rationale as atRiskSnooze: durable state only)" — but unlike the snooze use-case fixed in the SAME range (snooze-at-risk-member.ts:108-117 deliberately moves the emit OUTSIDE the callback, gated on `txResult.ok`), this emit fires while the tx is still open, before the COMMIT. This violates the project invariant 'emit OTel metrics AFTER commit only' and contradicts the W0-09 commit message which explicitly called out the original snooze emit-inside-tx as a bug ('its comment falsely claimed after commit → over-counted on a post-emit commit failure; moved it after the await').**

_Failure:_ If the database COMMIT fails after the callback body finishes (connection drop / serialization failure / Neon timeout at commit time — runInTenant rejects, not the inner audit/insert), the at_risk_outreach_recorded INSERT and audit row roll back, but renewals.at_risk.outreach_recorded_total has already incremented. The OTel counter then diverges above the actual durable outreach rows (over-count) — the exact failure the sibling snooze fix in this range prevents. The mock-only unit test 'does NOT emit when audit throws (tx rolled back)' passes only because the audit throw precedes the emit line; there is no test for a commit-time failure (vi-mocked runInTenant never fails the commit), so the regression is invisible to the suite.

_Quote:_
```
    // W0-09: § 23.1.2 outreach counter — emitted AFTER tx commit (same
    // rationale as atRiskSnooze: durable state only). `template_id` is
    // forwarded as-is from the input (undefined when channel is not email).
    renewalsMetrics.atRiskOutreachRecorded(
      input.tenantId,
      input.channel,
      input.templateId,
    );
    return ok(inserted);
  });
}
```

_Reasoning:_ The emit is verifiably INSIDE the runInTenant callback. The use-case body is `return runInTenant(deps.tenant, async (tx) => { ...insert...; ...audit emitInTx...; renewalsMetrics.atRiskOutreachRecorded(...); return ok(inserted); });` — lines 169-173 run while `tx` is still open, and line 174 `return ok(inserted)` is still inside the callback (closing `});` is line 175). The comment on lines 166-168 falsely claims "emitted AFTER tx commit (same rationale as atRiskSnooze)".

The sibling snooze-at-risk-member.ts, edited in the SAME W0-09 range, does NOT match: it does `const txResult = await runInTenant(...)` and then emits OUTSIDE the callback gated on `if (txResult.ok) { renewalsMetrics.atRiskSnooze(...) }`, with a comment explicitly stating "The earlier in-callback emit over-counted on any post-emit commit failure and its 'after commit' comment was inaccurate." So the candidate's emit does NOT replicate the snooze pattern despite its comment claiming so — it is precisely the buggy pattern the snooze fix removed.

Mechanism: runInTenant (@/lib/db) wraps the callback in a DB transaction; COMMIT occurs after the callback returns but before runInTenant's promise resolves. The metric instrument is real — metrics.ts atRiskOutreachRecorded() does `counter('renewals.at_risk.outreach_recorded_total', ...).add(1, {...})`. On a commit-time failure (Neon connection drop / serialization failure / statement timeout at COMMIT — runInTenant rejects, not the inner insert/audit), the at_risk_outreach INSERT and the audit row both roll back, but the counter has already incremented by 1. Result: renewals.at_risk.outreach_recorded_total diverges above the actual durable outreach rows (over-count), violating the project invariant "emit OTel metrics AFTER commit only" and Principle VIII expectations.

Test invisibility confirmed: tests/unit/.../record-at-risk-outreach.test.ts line 29 mocks `runInTenant: async (_ctx, fn) => fn(...)` — it merely awaits the callback and never simulates a commit failure. The "does NOT emit ... when audit throws (tx rolled back)" test (line 239) passes only because the audit `throw` precedes the emit line (short-circuit). No test exercises a fully-successful callback followed by a COMMIT failure, so the over-count regression is undetectable by the suite. All line numbers in the claim (166 comment, 169 emit, 174 return-inside-callback) match the current source exactly.

## 4. [correctness/CONFIRMED] scripts/import-members/columns.ts:582  (angle=D-lang-pitfall)
**splitFullName maps a single-token 'Full Name' cell to {firstName: full, lastName: ''}. validate.ts:1106 then errors contactLastName 'required' (via blankToNull) for that contact. If that mononym contact is a member's only/primary contact, the whole member fails validation and is dropped from the import.**

_Failure:_ A workbook row with a single-word contact name ('Madonna', a Thai given-name-only entry, or a company using one display name) and no separate first/last columns is silently rejected at --commit. The member is never created, with only a per-row contactLastName 'required' error in the report — a real SweCham member is dropped during the one-time go-live import.

_Quote:_
```
scripts/import-members/columns.ts:95  if (parts.length <= 1) return { firstName: full.trim(), lastName: '' };
scripts/import-members/validate.ts:256  if (blankToNull(r.contactLastName) === null) err(r.rowIndex, 'contactLastName', 'required');
```

_Reasoning:_ Full chain traced through the real --commit path (import-members.ts:301 mapDataRows → :303 validateRows):

1. splitFullName (columns.ts:93-97): a single-token cell yields {firstName: full.trim(), lastName: ''} — line 95 confirms exactly the claimed mapping.
2. mapDataRows (columns.ts:116-122): when contactFirstName/contactLastName columns are absent (only a full-name alias column, FULLNAME_ALIASES line 34, which buildColumnMap accepts as the name source at lines 70-72), the full-name split path fires and contactLastName becomes ''.
3. validate.ts:256: blankToNull('') returns null (line 106-109), so an 'error'-severity contactLastName 'required' issue is pushed.
4. Member-drop: that error makes memberErrorsAfter > memberErrorsBefore → memberHasError = true (line 307-309) → the `if (!memberHasError ...)` block at line 311 is skipped → the member is NOT added to members[]. If the mononym is the member's only contact, the whole member is dropped, with only a per-row contactLastName 'required' error in the report — exactly the claimed failure.

The candidate is actually understated: import-members.ts:306-313 REFUSES the entire --commit when errorCount > 0, so a single mononym error blocks every member, not just its own, until the operator fixes the data/header. Either way a real SweCham member (Thai given-name-only entry, single-display-name company) is blocked from the one-time go-live import.

Only inaccuracy: the cited line numbers (columns.ts:582, validate.ts:1106) are wrong — the actual lines are columns.ts:95/118-119 and validate.ts:256/311 (files are 147 and 347 lines). File paths, function names, blankToNull reference, and behavior all match precisely, so the substance of the claim holds.

## 5. [correctness/CONFIRMED] scripts/import-members/validate.ts:1004  (angle=D-lang-pitfall)
**Members are grouped solely by normCompanyKey (trim + lowercase + collapse whitespace). Two genuinely DISTINCT companies that share a display name are merged into ONE member: only the head row's member-level fields (country/tier/tax_id/date) survive, the second company's contacts are attached to the first, and the second company is never created.**

_Failure:_ Two different legal entities both listed as e.g. 'Nordic Trading' (different tax IDs, different tiers) collapse into a single member. The sibling-mismatch warning fires only if the head row resolved, and even then it is just a warning, so --commit proceeds: one company is lost and its contacts are mis-attached to the other.

_Quote:_
```
function normCompanyKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
...
  const groups = new Map<string, RawRow[]>();
  for (const r of rows) {
    const key = normCompanyKey(r.companyName);
    if (key.length === 0) {
      err(r.rowIndex, 'companyName', 'required');
      continue;
    }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
...
  for (const groupRows of groups.values()) {
    const head = groupRows[0]!;
...
      members.push({
        companyName: head.companyName.trim(),
        country: country.value,
        taxId,
        planId: tier.value.planId,
...
        contacts: normalizedContacts,
        rowIndices: groupRows.map((r) => r.rowIndex),
      });
```

_Reasoning:_ The cited line number (1004) does not exist — the file is 348 lines — but the substantive mechanism is fully borne out by the actual source. Grouping is keyed solely on normCompanyKey(companyName) = trim+lowercase+collapse-whitespace (lines 102-104, 152-160); tax_id, tier, country, and date never participate in the group key. Therefore two distinct legal entities sharing a display name (e.g. "Nordic Trading") land in one groupRows array. All member-level fields are read exclusively from head = groupRows[0] (country L171, tier L174, regDate L177, taxId L181-198, turnover L200, locale L205, city/province/postal L323-325), so only the head's country/tier/tax_id/date survive; the sibling's tax_id and tier are silently discarded. The contact loop iterates over ALL groupRows (L246), so the second company's contacts are attached to the single merged member, and only ONE member object is pushed per group (L314-328) — the second company is never created. The sole signal is the sibling-mismatch warning, which is gated on the head having resolved (headPlanId !== null L231 / headCountry !== null L236) and is emitted via warn() (L234, L239) at severity 'warning'. The member-validity gate (L307-311) only blocks on errors and resolution failures, never warnings, so --commit proceeds and the merged member is inserted with head fields + both contact sets. The developer comments at L211-213 and L220-229 explicitly acknowledge this exact failure mode ("two DISTINCT companies wrongly merged under a shared display name (only the head row's values survive)... we cannot auto-resolve without a stable key... siblings are never independently resolution-error-checked"). Named inputs/state and wrong output are all present and proven; only the line-number citation is an artifact.

## 6. [correctness/CONFIRMED] src/app/api/cron/renewals/at-risk-recompute-coordinator/route.ts:144  (angle=E-wrapper-proxy)
**gateCronBearerOrRespond is called with only `metricsCounter` and NO `rateLimitFallbackCounter`. The same omission exists in lapse-cycles-on-grace-expiry-coordinator/route.ts (line 55), reconcile-pending-reactivations-coordinator/route.ts (line 48), and tier-upgrade-evaluate-coordinator/route.ts (line 126). Only dispatch-coordinator/route.ts (line 237) forwards `rateLimitFallbackCounter: () => renewalsMetrics.redisFallback()`. The helper's option is documented (cron-auth.ts:87-96) as the way to surface an OTel counter on Upstash fail-open so Vercel alert rules — which bind to counters, not log strings — can fire on sustained rate-limiter degradation. Because the option is optional (`options.rateLimitFallbackCounter?.()` at cron-auth.ts:134), omitting it silently drops the only durable signal.**

_Failure:_ Upstash is down AND a Bearer-rejected (probe/misconfig) request hits one of the 4 non-dispatch coordinators: the rate-limit check throws, the helper logs cron.coordinator.rate_limit_check_failed_fail_open and proceeds, but no OTel counter increments. Pino logs roll off in ~30 days; the F8 alert pipeline (counter-based) stays green during a sustained Upstash outage on those routes, so on-call is never paged for the rate-limiter degradation that dispatch-coordinator would correctly surface.

_Quote:_
```
// at-risk-recompute-coordinator/route.ts:144-148
const authResponse = await gateCronBearerOrRespond(request, {
  route: '/api/cron/renewals/at-risk-recompute-coordinator',
  metricsCounter: () =>
    renewalsMetrics.coordinatorAuditEmitFailed('at_risk_recompute'),
});

// vs dispatch-coordinator/route.ts:234-238 (the only coordinator that forwards it)
const gateResponse = await gateCronBearerOrRespond(request, {
  route: '/api/cron/renewals/dispatch-coordinator',
  metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('dispatch'),
  rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
});

// cron-auth.ts:127-135 — fail-open path; counter is a no-op when option omitted
} catch (e) {
  logger.warn(
    { errKind: errKind(e), ip, route: options.route },
    'cron.coordinator.rate_limit_check_failed_fail_open',
  );
  options.rateLimitFallbackCounter?.();
}
```

_Reasoning:_ Every factual claim is confirmed at the source. The four non-dispatch coordinators (at-risk-recompute:144-148, lapse-cycles-on-grace-expiry:55-59, reconcile-pending-reactivations:48-52, tier-upgrade-evaluate:126-130) all pass only `metricsCounter` and omit `rateLimitFallbackCounter`. dispatch-coordinator:237 is the sole coordinator forwarding `rateLimitFallbackCounter: () => renewalsMetrics.redisFallback()`. The helper invokes it optionally via `options.rateLimitFallbackCounter?.()` (cron-auth.ts:134) inside the catch that logs `cron.coordinator.rate_limit_check_failed_fail_open` — so when omitted, the catch is a pure no-op for metrics. The dropped counter `renewals_redis_fallback_total` is documented (metrics.ts:2142-2150; cron-auth.ts:90-94) as the durable OTel signal that Vercel alert rules bind to for "sustained Upstash degradation" ("Alert rule: any non-zero rate sustained for 5 min"), because alert rules attach to counters not log strings. Pino logs roll off, so during a sustained Upstash outage with Bearer-rejected traffic on those four routes, the Upstash-degradation alert pipeline stays dark while dispatch-coordinator would fire it. One precision correction to the candidate's wording: line 165 `renewalsMetrics.cronBearerAuthRejected(route)` DOES still increment unconditionally on every 401 path (the F8-A3 alert, >=5/min), so on-call is not entirely blind to the Bearer-rejection burst — but that counter measures auth-probe volume, a different condition than rate-limiter health. The signal uniquely and silently lost is precisely the Upstash fail-open counter, exactly as the candidate identifies. Trigger is environmental (requires concurrent Upstash outage + auth-rejected traffic on those specific coordinators), but the code asymmetry and the missing-signal mechanism are unambiguous and inconsistent with dispatch-coordinator's own stated intent (R5-BLK-1 closure preserving the K14-5/R13-W3 invariant), making this a genuine observability-correctness regression that the diff introduced unevenly.

## 7. [correctness/CONFIRMED] tests/integration/plans/soft-delete-toctou-advisory-lock.test.ts:212  (angle=sweep)
**Test 2 ('Race condition closed') claims to verify the W0-02 advisory-lock serialization but runs entirely SEQUENTIALLY: STEP 1 acquires the lock, assigns the member, and COMMITS (releasing the lock) BEFORE STEP 2 even calls softDeleteGuarded (lines 242-270, and the test header at lines 254-263 states this explicitly). Because the assign is already committed when softDeleteGuarded runs, its count would see the member with OR WITHOUT the advisory lock — even the old two-separate-round-trip code (count trip then delete trip) counts a member that committed before the count. So this test asserts the same property as Test 1 (member present before delete -> refuse) with a no-op lock acquire/release inserted; it cannot distinguish locked from unlocked code.**

_Failure:_ A future refactor removes the pg_advisory_xact_lock from softDeleteGuarded (or from change-plan Side B), re-opening the exact TOCTOU window W0-02 closed. This suite — the only dedicated W0-02 regression guard — still passes green because neither test exercises a real concurrent interleave (count-running-while-assign-uncommitted). The genuine race (assign uncommitted in another tx while softDelete counts) is never reproduced, so the lock can silently rot.

_Quote:_
```
// STEP 1 (simulates Thread B winning the lock):
    // Assign member to targetPlan inside the advisory-lock scope,
    // then commit. This simulates changePlan arriving BEFORE softDelete.
    const lockKey = planSoftDeleteLockKey(tenant.ctx.slug, targetPlanId, PLAN_YEAR);
    await runInTenant(tenant.ctx, async (tx) => {
      // Acquire the SAME lock key that softDeleteGuarded uses
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      // "Assign" the member to targetPlan (simulates changePlan's UPDATE)
      await tx
        .update(members)
        .set({ planId: targetPlanId })
        .where(eq(members.memberId, memberId));
      // tx commits here → releases lock → assignment is now visible to DB
    });
    ...
    const guardResult = await planRepo.softDeleteGuarded(
```

_Reasoning:_ Traced the test (tests/integration/plans/soft-delete-toctou-advisory-lock.test.ts:206-280) against the production code (src/modules/plans/infrastructure/db/plan-repo.ts:350-388 softDeleteGuarded; src/modules/plans/application/soft-delete-plan.ts).

The claim is accurate on every point:

1. STEP 1 (lines 236-247) opens a runInTenant tx, acquires the advisory lock, UPDATEs the member onto targetPlan, and the `await` fully resolves — meaning the tx COMMITS and releases the lock — BEFORE STEP 2 begins. The test's own header (lines 200-203) confirms: "This test is NOT a concurrent Promise.all test... It is a controlled sequential test." The inline comment at line 246 confirms "tx commits here → releases lock → assignment is now visible to DB."

2. STEP 2 (line 258) then calls softDeleteGuarded, which opens a FRESH tx, acquires the (now uncontended) lock at plan-repo.ts:353-356, counts at line 360, sees the already-committed member (count=1), and refuses. Because the assign committed before this tx even started, the count reads committed data regardless of whether the lock is acquired.

3. Counterfactual (lock-rot scenario): if a future refactor deletes lines 353-356 (pg_advisory_xact_lock) from softDeleteGuarded, the count at line 360 still reads STEP 1's committed member → still count=1 → test still passes GREEN. The lock in softDeleteGuarded is never contended in this test, so the test cannot distinguish locked from unlocked code.

4. The test asserts the same property as Test 1 ("member present before delete → refuse"), with a no-op lock acquire/release in STEP 1 that exercises the TEST's own lock acquisition, not the production changePlan Side-B serialization under genuine concurrency. The real TOCTOU race (assign uncommitted in a concurrent tx while softDelete counts in the window between count and delete) is never reproduced — there is no Promise.all and no uncommitted-overlap. Even the old two-round-trip code (separate countActivePlanMembers then softDelete, per soft-delete-plan.ts:24-29) would pass this sequential test because its count round-trip would also read the already-committed assign.

This is the dedicated W0-02 regression guard, and it provides no protection against silent lock removal. The verdict is CONFIRMED.

## 8. [correctness/CONFIRMED] tests/unit/renewals/application/use-cases/record-at-risk-outreach.test.ts:79  (angle=sweep)
**The new test 'does NOT emit atRiskOutreachRecorded when audit throws (tx rolled back)' is vacuous for the property the W0-09 change claims to enforce ('emit AFTER tx commit'). The mocked runInTenant (lines 28-31) just calls fn(tx) and returns its value — there is NO commit step. The audit-emit throw happens at record-at-risk-outreach.ts:164, BEFORE the metric emit at line 169 (which is INSIDE the runInTenant callback, contradicting its 'AFTER tx commit' comment). So the test only proves the emit is skipped when audit throws-before-it; it does NOT and CANNOT cover the post-emit commit-failure over-count that the SAME W0-09 range deliberately fixed in the sibling snooze-at-risk-member.ts (which moved the emit OUTSIDE the callback gated on txResult.ok). The symmetrically-written test gives false confidence that outreach has the same after-commit guarantee as snooze, when it does not.**

_Failure:_ In production a post-emit COMMIT failure (serialization error / connection drop at commit time) on recordAtRiskOutreach increments renewals.at_risk.outreach_recorded_total even though the outreach row was rolled back, over-counting outreach volume on SRE dashboards. The unit suite stays green because its fake runInTenant has no commit phase, so the regression the W0-09 commit message says it fixed for snooze remains LIVE for outreach and is untestable as written.

_Quote:_
```
record-at-risk-outreach.ts:166-174 (INSIDE the runInTenant callback):
    // W0-09: § 23.1.2 outreach counter — emitted AFTER tx commit (same
    // rationale as atRiskSnooze: durable state only). ...
    renewalsMetrics.atRiskOutreachRecorded(
      input.tenantId,
      input.channel,
      input.templateId,
    );
    return ok(inserted);
  });

vs. the genuinely-fixed sibling snooze-at-risk-member.ts:69,115-117 (OUTSIDE the callback, gated on commit):
  const txResult = await runInTenant(deps.tenant, async (tx) => { ... });
  ...
  if (txResult.ok) {
    renewalsMetrics.atRiskSnooze(input.tenantId, input.actorRole);
  }

test lines 28-31 (fake runInTenant, no commit phase):
vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

test line 239 (the impugned test):
  it('does NOT emit atRiskOutreachRecorded when audit throws (tx rolled back)', async () => {
    const { deps } = fakeDeps({
      emitImpl: async () => { throw new Error('audit failed'); },
    });
    await expect(recordAtRiskOutreach(deps, baseInput)).rejects.toThrow();
    expect(atRiskOutreachRecordedMock).not.toHaveBeenCalled();
  });
```

_Reasoning:_ Source confirms the structural asymmetry. snooze-at-risk-member.ts was fixed in this exact W0-09 range to capture txResult and emit the metric OUTSIDE the runInTenant callback gated on `if (txResult.ok)` (lines 69, 115-117), with a commit message/comment explicitly stating the prior in-callback emit "over-counted on any post-emit commit failure." record-at-risk-outreach.ts received NO such fix: the metric emit (lines 169-173) sits INSIDE the callback, between the audit emit and `return ok(inserted)`, and its added comment falsely claims "emitted AFTER tx commit (same rationale as atRiskSnooze)" — but in real runInTenant the COMMIT happens only after the callback returns, so line 169 executes BEFORE commit.

The test is vacuous for the post-commit property as claimed: the mocked runInTenant (lines 28-31) is just `fn({})` — there is no commit phase, so a post-emit commit failure cannot be simulated. The test at line 239 only proves the metric is skipped when audit emit throws, and that skip is solely due to throw-ordering: the audit catch `throw e` at source line 164 fires BEFORE the metric at line 169. It passes for the wrong reason and cannot exercise the serialization-error/connection-drop-at-commit over-count path. The symmetrically-written outreach and snooze metric tests give false confidence that outreach has the same after-commit guarantee snooze has, when structurally it does not. In production a commit-time failure on recordAtRiskOutreach increments renewals.at_risk.outreach_recorded_total despite the row being rolled back — the exact regression the W0-09 commit said it fixed for snooze remains LIVE for outreach and is untestable as written. Every element of the claim (vacuous test, contradicted "AFTER commit" comment, structural divergence from snooze, untestable live over-count) is verified against current source.

## 9. [correctness/PLAUSIBLE] src/modules/auth/application/enable-user.ts:75  (angle=A-line-by-line)
**Read-after-write null guard returns {code:'not-found'} AFTER deps.users.enable() (line 60) and the account_reenabled audit (line 62) have already been committed (separate awaits, no shared tx). On a null re-read the side effects persist but the caller is told the user does not exist — an audit row records a successful re-enable while the API returns 404. Same shape in disable-user.ts.**

_Failure:_ User row is concurrently hard-deleted between enable() and the re-read findById. The user is actually enabled and an account_reenabled audit event is written, but enableUser returns not-found → route returns 404. Audit trail and DB state disagree with the API response; an operator sees a 404 yet the audit log shows the account was re-enabled.

_Quote:_
```
  await deps.users.enable(target.id);

  await deps.audit.append({
    eventType: 'account_reenabled',
    actorUserId: input.actorUserId,
    targetUserId: target.id,
    sourceIp: input.sourceIp,
    summary: `re-enabled ${target.role} ${target.email}`,
    requestId: input.requestId,
  });

  const updated = await deps.users.findById(target.id);
  // W2-01: a null read-after-write must surface as not-found, NOT fall back to the
  // stale pre-update `target` ...
  if (!updated) return err({ code: 'not-found' });
```

_Reasoning:_ The mechanism is real and verified against current source. enableUser performs three independent, non-transactional awaits on the pool-global `db`: (1) enable-user.ts:60 `deps.users.enable(target.id)` runs `db.update(users).set({status:'active',...})` which commits immediately (user-repo.ts:385-391, no tx); (2) line 62 `deps.audit.append({eventType:'account_reenabled',...})` commits the audit row in a separate await; (3) line 71 `findById` is a separate `db.select()` (user-repo.ts:205-208). If `updated` is null (line 75), it returns `{code:'not-found'}`, which the route (enable/route.ts) maps to HTTP 404. So the status flip AND the `account_reenabled` audit row are already durably persisted when the caller is told the user does not exist — the audit log says re-enabled, the API says 404. disable-user.ts:123-125 has the identical shape (account_disabled + sessions-revoked audit committed before the null re-read returns not-found). There is no shared tx or row lock here (unlike findByIdInTx which uses `.for('update')`), so nothing guards the window. Why PLAUSIBLE not CONFIRMED: the divergence only manifests on a null re-read, which requires the user row to be concurrently hard-deleted (or otherwise vanish) in the narrow gap between line 60 and line 71 — a timing/operationally-contingent trigger, not a deterministic input→wrong-output. To confirm, exhibit a concurrent DELETE landing in that window (e.g. an integration test that stubs `enable()` to succeed and `findById` (second call) to return null) and observe the persisted audit row plus the 404. The candidate's claim that audit and DB state can disagree with the API response is factually correct; the line comment shows the not-found-over-stale choice is deliberate, but it does not address the already-committed audit row, so this is a genuine reverse-atomicity/consistency gap rather than a fabricated one.

## 10. [altitude/CONFIRMED] src/lib/metrics.ts:2310  (angle=I-altitude)
**pipelineRowCount hand-rolls the observable-gauge accumulator (gaugeValues.get/set, observableGauges.has, addCallback) with a manual `${tenantId}:${urgencyBand}` composite key split via indexOf(':'), duplicating the third copy of this boilerplate (alongside observeCycleStateGauge). The generic observeGauge(name, description, labels, value) helper already exists right above and handles arbitrary multi-label maps via a JSON-serialised key — it was the intended reuse point.**

_Failure:_ The slice(0, colonIdx)/slice(colonIdx+1) parsing assumes a single colon; a tenant slug containing ':' (or a future urgency band with one) mis-splits the composite key, mislabelling the gauge tenant_id/urgency_band. Each new gauge also re-copies ~18 lines, so a bug fix in the accumulator (e.g. callback cleanup) must be applied in three places.

_Quote:_
```
  pipelineRowCount(tenantId: string, urgencyBand: string, rowCount: number): void {
    safeMetric(() => {
      const gaugeName = 'renewals.pipeline.row_count';
      const stateBucket = gaugeValues.get(gaugeName) ?? new Map<string, number>();
      // Key by tenant+urgency_band so different filters don't overwrite each other.
      const key = `${tenantId}:${urgencyBand}`;
      stateBucket.set(key, rowCount);
      gaugeValues.set(gaugeName, stateBucket);

      if (!observableGauges.has(gaugeName)) {
        const gauge = meter().createObservableGauge(gaugeName, { ... });
        observableGauges.set(gaugeName, gauge);
        gauge.addCallback((result) => {
          const bucket = gaugeValues.get(gaugeName);
          if (!bucket) return;
          for (const [compositeKey, count] of bucket.entries()) {
            const colonIdx = compositeKey.indexOf(':');
            const tid = compositeKey.slice(0, colonIdx);
            const band = compositeKey.slice(colonIdx + 1);
            result.observe(count, { tenant_id: tid, urgency_band: band });
          }
        });
      }
    });
  },
```

_Reasoning:_ This is an altitude (duplication / missed-reuse) finding, and the core altitude claim is verified by source. NOTE: line is 2912, not 2310 as cited, but the symbol and code are exactly as described.

CONFIRMED parts of the claim:
1. Hand-rolled triplicate boilerplate. `pipelineRowCount` (metrics.ts:2912) manually re-implements the observable-gauge accumulator: `gaugeValues.get/set`, `observableGauges.has/set`, `createObservableGauge`, `gauge.addCallback`. This is the THIRD copy: the generic `observeGauge` helper (line 109) is copy #1, `observeCycleStateGauge` (line 2519) is copy #2 (verified — it hand-rolls the same get/set/has/addCallback block), and `pipelineRowCount` is copy #3. Each copies ~18 lines, so an accumulator bug fix (e.g. callback cleanup) must be applied in three places.
2. Manual composite key + indexOf(':') split. Line 2917 builds `const key = \`${tenantId}:${urgencyBand}\`` and lines 2931-2933 split it via `compositeKey.indexOf(':')` + `slice(0, colonIdx)` / `slice(colonIdx + 1)`.
3. observeGauge was the intended reuse point. The generic helper (lines 109-141) handles arbitrary multi-label maps via a stable JSON-serialised key (`JSON.stringify(Object.fromEntries(Object.entries(labels).sort(...)))`) and the callback `JSON.parse`s it back — so `observeGauge('renewals.pipeline.row_count', desc, { tenant_id, urgency_band }, rowCount)` would have produced the same gauge with zero manual key parsing. The function's own docstring (lines 2906-2910) even states it is "Implemented as an observable gauge via the existing `observeGauge` helper" — yet the code does NOT call observeGauge, so the doc contradicts the implementation. This is a legitimate cleanup.

REFUTED part (the dramatic "failure scenario"): the claimed colon-mis-split mislabelling cannot trigger. `tenantId` is a TenantSlug validated against `/^[a-z0-9-]{1,63}$/` (tenant-context.ts:46 and tenant-slug.ts:27) — lowercase alphanumeric + hyphen only, no colon possible. Since the tenant is the head segment, a colon could only mis-split if it appeared in the tenant part, which the regex forbids. A colon in a future urgency band would land in the tail (`slice(colonIdx+1)`) and split correctly anyway. So the runtime correctness risk is not real; the value of this finding is purely the altitude/duplication cleanup, which is confirmed.

## 11. [altitude/CONFIRMED] src/app/api/cron/broadcasts/dispatch-scheduled/route.ts:227  (angle=C-cross-file)
**W2-05 changed dispatch-scheduled-broadcast to return the typed err({kind:'dispatch.server_error'}) when deps.membersBridge.getMemberPrimaryContact throws (Neon/RLS/timeout), instead of letting the throw propagate. The cron dispatch caller's switch on result.error.kind has no case for 'dispatch.server_error', so it now lands in the default arm: `summary.unknown_error++; broadcastsMetrics.cronUnknownErrorCount(tenant.slug)` with log tag 'cron.broadcasts.dispatch.unknown_error_kind'. Before W2-05 the same bridge throw was caught one block lower at the `catch (e)` (line 245) as `summary.uncaught_error++; broadcastsMetrics.cronUncaughtErrorCount(...)`, whose comment explicitly says that class is for 'programming bugs ... alert immediately'. The change silently re-buckets a transient/expected infra failure from the uncaught (alert-now) counter to the unknown-kind counter, shifting alerting semantics. The broadcast row stays 'approved' either way so retry safety is unchanged (no correctness bug); this is an observability classification regression. Lower confidence: Step-1's catch at L442 already produced dispatch.server_error → default, so this path pre-existed; W2-05 only adds a second source feeding it.**

_Failure:_ A persistent members-bridge failure (RLS/Neon outage) now increments renewals/broadcasts 'unknown_error' instead of 'uncaught_error'; an SRE alert rule bound to cronUncaughtErrorCount (the 'programming bug, page immediately' signal) never fires, and the failure is logged under the misleading 'unknown_error_kind' tag, delaying triage of a real dispatch-blocking outage.

_Quote:_
```
// route.ts default arm (no `case 'dispatch.server_error'`):
default: {
  summary.unknown_error++;
  broadcastsMetrics.cronUnknownErrorCount(tenant.slug);
  const errKind = (result.error as { kind?: string }).kind ?? 'unknown';
  logger.error({ tenantId: tenant.slug, broadcastId: row.broadcast_id, errorKind: errKind }, 'cron.broadcasts.dispatch.unknown_error_kind');
}

// route.ts catch (e) (the pre-W2-05 destination):
} catch (e) {
  summary.uncaught_error++;
  broadcastsMetrics.cronUncaughtErrorCount(tenant.slug);
  ... 'cron.broadcasts.dispatch.uncaught_error'

// W2-05 use-case change (git commit 20796dfd, dispatch-scheduled-broadcast.ts:466-476):
  try {
    requestingPrimary = await deps.membersBridge.getMemberPrimaryContact(deps.tenant, requestingMember);
  } catch (e) {
    return err({ kind: 'dispatch.server_error', message: e instanceof Error ? e.message : 'unknown error' });
  }
```

_Reasoning:_ Every link in the chain is verified against current source + git history.

1. W2-05 (commit 20796dfd, "fix(P2): Wave-2 cheap wins — ... bridge throw mapping") wrapped the Step-2 getMemberPrimaryContact call in try/catch returning err({kind:'dispatch.server_error'}). The git diff confirms the prior code was a bare `await` with no catch — a throw therefore propagated out of dispatchScheduledBroadcast() into the caller.

2. The cron caller's switch in route.ts (lines 198-244) has NO case for 'dispatch.server_error' (grep confirms no match). It handles only gateway_retryable / broadcast_resend_resource_missing / broadcast_failed_to_dispatch / broadcast_audience_post_suppression_empty, then default. So dispatch.server_error lands in default → summary.unknown_error++ + broadcastsMetrics.cronUnknownErrorCount(tenant.slug) + log tag 'cron.broadcasts.dispatch.unknown_error_kind'.

3. Before W2-05 the same bridge throw was caught one block lower at `catch (e)` (line 245) → summary.uncaught_error++ + cronUncaughtErrorCount, whose comment + metric docstring (metrics.ts:1363-1368) explicitly say 'programming bug, or infra outage ... alert immediately'. route.ts had ZERO changes in this range, so the caller behavior is unchanged — only the error SOURCE shifted from throw to typed Result.

4. Retry safety unchanged: both paths return before any state transition, so the row stays 'approved'. No correctness bug — purely an alerting re-classification.

5. The 'lower confidence' caveat is also confirmed true: at HEAD~12 Step-1's catch already returned dispatch.server_error, so the default→unknown_error path pre-existed; W2-05 only adds a second source feeding it.

The classification regression is real and, if anything, slightly understated: cronUnknownErrorCount is documented (metrics.ts:1347-1352) as an enum-DRIFT/'should be 0' signal, so a sustained Neon/RLS outage now masquerades as a use-case↔route contract-drift alert instead of firing the page-immediately uncaught_error counter — delaying triage of a dispatch-blocking outage. This is an observability/altitude regression, not a correctness bug, exactly as the candidate frames it.

## 12. [cleanup/CONFIRMED] src/app/api/cron/renewals/at-risk-recompute-coordinator/route.ts:1491  (angle=F-reuse)
**The W0-09 coordinator-metrics block — coordinatorTenantsEnqueued + coordinatorTenantsSucceeded + (conditional coordinatorTenantsFailed) + coordinatorDurationMs — is copy-pasted identically across all 5 coordinator routes (dispatch, at-risk-recompute, lapse, reconcile, tier-upgrade-evaluate), in both the zero-tenant early-return arm and the main arm (~10 sites). Every site already has an OrchestratedSummary with tenants_enqueued/succeeded/failed/duration_ms. A single `renewalsMetrics.coordinatorSummary(cronKind, summary)` taking the summary collapses all of them and guarantees the 'fire tenants_failed only when >0' rule stays consistent.**

_Failure:_ One coordinator (or just its zero-tenant arm) is edited to add/rename a counter or fix the >0 guard but a sibling copy is missed; F8-A1/F8-A3 alert dashboards then under- or over-count failures for that one cron_kind and an SRE triages the wrong coordinator during an incident.

_Quote:_
```
// W0-09: § 23.1.3 coordinator-level metrics.
  renewalsMetrics.coordinatorTenantsEnqueued('at_risk_recompute', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('at_risk_recompute', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('at_risk_recompute', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('at_risk_recompute', summary.duration_ms);
```

_Reasoning:_ This is a cleanup/F-reuse finding and the claim is factually accurate.

DUPLICATION VERIFIED across all 5 coordinator routes (dispatch, at-risk-recompute, lapse, reconcile-pending-reactivations, tier-upgrade-evaluate):
- Grep on coordinatorTenants*/coordinatorDurationMs returns the same 4-line emit block in every coordinator, in TWO arms each.
- All 5 have an `if (activeTenants.length === 0)` zero-tenant early-return arm (confirmed via grep) AND a main arm. The zero-tenant arm emits Enqueued(...,0) + Succeeded(...,0) + DurationMs (3 calls, no Failed); the main arm emits Enqueued + Succeeded + conditional `if (summary.tenants_failed > 0) coordinatorTenantsFailed(...)` + DurationMs (4 calls). That is ~10 emit sites total — exactly as claimed.
- The canonical dispatch-coordinator (route.ts:478-484) carries the identical block with the same `// tenants_failed_total is F8-A1 — must fire whenever tenantsFailed > 0` invariant inlined at the call site.

NO AGGREGATE HELPER EXISTS: src/lib/metrics.ts exposes only the 4 primitive methods (coordinatorTenantsEnqueued @2742, coordinatorTenantsSucceeded @2757, coordinatorTenantsFailed @2777, coordinatorDurationMs @2795). There is no `coordinatorSummary(cronKind, summary)` aggregate. Since every site already builds an `OrchestratedSummary` (tenants_enqueued/succeeded/failed/duration_ms), a single `coordinatorSummary(cronKind, summary)` helper would collapse all ~10 sites and centralize the 'fire tenants_failed only when >0' guard — which is currently re-asserted (or silently omitted in zero-tenant arms) at each site.

DRIFT RISK IS REAL: the metric doc-comments tie `renewals.coordinator.tenants_failed_total` to F8-A1 / SLO dashboards keyed by cron_kind. A future edit to one coordinator (e.g. rename a counter or relax/tighten the >0 guard) that misses a sibling copy would make the F8-A1 alert under/over-count failures for exactly one cron_kind, misdirecting SRE triage — the stated failure scenario.

Not a present-tense crash or wrong-output bug, but the angle is kind=cleanup and the duplication, the absence of the proposed aggregate, and the maintenance/drift hazard are all confirmed against current source.

## 13. [cleanup/CONFIRMED] src/app/api/portal/account/data-export/route.ts:1825  (angle=F-reuse)
**The rate-limit-then-429 block — `rateLimiter.check(key, n, window)` → `if (!rl.success) return 429 { error:{code:'rate_limited'} } with Retry-After: retryAfterSecondsFromRl(...)` — is reproduced inline in all 3 routes touched this range (portal/account/data-export, admin/members/[id]/data-export:1403, portal/renewal/[memberId]/confirm:1873) and ~15 other routes. Only retryAfterSecondsFromRl is shared. A `rateLimitOrRespond({ key, limit, window, correlationId })` helper next to retryAfterSecondsFromRl in rate-limit-helpers.ts would dedupe the check + envelope + header (response shape varies only slightly: some add correlationId, confirm uses errorResponse).**

_Failure:_ A future change to the rate-limited envelope (e.g. add a standard `retryAfter` body field, or switch all 429s to also emit a metric) must be applied to ~18 hand-copied sites; any miss leaves an inconsistent 429 contract that the shared contract tests for rate_limited may not catch per-route.

_Quote:_
```
// portal/account/data-export/route.ts
  const rl = await rateLimiter.check(`gdpr-export-request:${tenant.slug}:${memberId}`, 3, 3600);
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' }, correlationId },
      {
        status: 429,
        headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() },
      },
    );
  }

// admin/members/[id]/data-export/route.ts:46-59 (no correlationId in body)
  const rl = await rateLimiter.check(`gdpr-export-admin:${tenant.slug}:${ctx.current.user.id}`, 20, 3600);
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' } },
      { status: 429, headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() } },
    );
  }

// portal/renewal/[memberId]/confirm/route.ts:81-89 (uses errorResponse helper)
  const rl = await rateLimiter.check(`renewal-confirm:${ctx.tenant.slug}:${ctx.memberId}`, 10, 3600);
  if (!rl.success) {
    return errorResponse({ status: 429, code: 'rate_limited', correlationId, headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() } });
  }

// rate-limit-helpers.ts — the ONLY shared piece:
export function retryAfterSecondsFromRl(rl: { readonly reset: number }): number {
  return Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
}
```

_Reasoning:_ This is a kind=cleanup / F-reuse finding (not a runtime bug), and the duplication claim is factually CONFIRMED.

Verified facts:
1. The check→429→Retry-After block is reproduced inline. The three cited sites all exist exactly as claimed:
   - portal/account/data-export/route.ts: raw NextResponse.json with `{ error: { code: 'rate_limited' }, correlationId }` + Retry-After header.
   - admin/members/[id]/data-export/route.ts:46-59: same shape but body OMITS correlationId.
   - portal/renewal/[memberId]/confirm/route.ts:81-89: same logic but routed through an `errorResponse({...})` helper instead of raw NextResponse.json.
2. rate-limit-helpers.ts exports ONLY `retryAfterSecondsFromRl` — there is no shared rateLimitOrRespond helper. Confirmed by reading the full file (it contains just that one function).
3. The claim said "~18 sites"; an actual ripgrep for `rateLimiter.check` across src/app finds 25 route files — the duplication is even broader than claimed.

The failure scenario (a future change to the 429 envelope/metric must be hand-applied to every copied site, and a miss yields an inconsistent contract) is not merely hypothetical: the three cited sites ALREADY diverge in shape — one includes correlationId in the body, one does not, and one uses errorResponse — which is precisely the per-route inconsistency the finding predicts. A `rateLimitOrRespond({ key, limit, window, correlationId })` helper next to retryAfterSecondsFromRl would dedupe the check + envelope + header.

No incorrect output or crash exists today (correctly classified as cleanup, not a correctness bug), but the reuse/dedup opportunity is real, present, and actionable across ~25 sites.

## 14. [cleanup/CONFIRMED] src/components/members/members-table.tsx:1914  (angle=F-reuse)
**InlineCountryCell and InlineNotesCell each add the same Enter/Space keyboard-activation handler `onKeyDown={(e)=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); startEdit(); } }}` (the second copy at members-table.tsx ~1928). Both pair an onDoubleClick-only button with this exact W1-06 a11y handler. A tiny shared `onActivateKey(startEdit)` helper (or `activateOnEnterSpace`) removes the duplicated key-list + preventDefault logic.**

_Failure:_ A reviewer later adds keyboard support for another key (or fixes a Space-scroll edge case) in one inline cell but not the other, so one editable grid cell becomes keyboard-activatable in a way the sibling cell is not — an inconsistent a11y behaviour that the per-cell e2e assertions may not both cover.

_Quote:_
```
InlineCountryCell (line 391-396):
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            startEdit();
          }
        }}

InlineNotesCell (line 512-517):
        // W1-06 (a11y SC 2.1.1): keyboard activation (see InlineCountryCell).
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            startEdit();
          }
        }}
```

_Reasoning:_ In the current HEAD version of src/components/members/members-table.tsx, InlineCountryCell (button at lines 384-396) and InlineNotesCell (button at lines 508-517) each pair an onDoubleClick={startEdit}-only button with a byte-identical inline onKeyDown handler: `if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }`. A grep for the key-list pattern finds exactly two occurrences (lines 392 and 513) and no shared helper such as onActivateKey/activateOnEnterSpace. The second copy's comment ("keyboard activation (see InlineCountryCell)") explicitly acknowledges the cross-reference/duplication. This change is in scope: it landed in this review range via commit d3e59701 ("Wave-1 — keyboard edit", W1-06). The cleanup claim is accurate — a tiny shared helper would remove the duplicated key-list + preventDefault + startEdit logic — and the divergence failure scenario (one cell's keyboard handling updated without the sibling, yielding inconsistent grid-cell a11y) is realistic. The candidate's cited line numbers (1914/1928) are off (the file is 1018 lines; the components sit near 382/507), but the named components, the exact handler text, and the W1-06 provenance all match, so the line drift does not undermine the finding. This is a genuine, low-risk reuse/cleanup opportunity, not a correctness bug.

## 15. [cleanup/CONFIRMED] src/modules/plans/infrastructure/db/plan-repo.ts:327  (angle=G-simplify)
**W0-02 replaced softDeletePlan's only call to planRepo.softDelete with softDeleteGuarded (soft-delete-plan.ts now calls softDeleteGuarded; route.ts dropped the `members` dep). The `softDelete` repo method body (plan-repo.ts:327-342) plus its PlanRepo port declaration (ports.ts:103) are now unreachable production code — grep confirms the only remaining references are doc comments and test `vi.fn()` mocks (tests/unit/plans/application/*). Simpler form: delete the `softDelete` method + port decl and drop the `softDelete: vi.fn()` lines from the plan-repo mocks, leaving softDeleteGuarded as the single soft-delete path.**

_Failure:_ A future maintainer calls planRepo.softDelete believing it is the live path and silently bypasses the W0-02 advisory lock + member-count guard, re-opening the soft-delete-vs-assign TOCTOU the refactor was meant to close.

_Quote:_
```
src/modules/plans/application/soft-delete-plan.ts:100  guardResult = await deps.planRepo.softDeleteGuarded(
src/modules/plans/application/soft-delete-plan.ts:24  * round-trip by `planRepo.softDelete` call) has been replaced by the single
src/modules/plans/infrastructure/db/plan-repo.ts:327  async softDelete(tenant, planId, year, deletedAt, updatedBy) { ... bare UPDATE, NO advisory lock, NO member-count guard ... }
```

_Reasoning:_ Claim verified. The W0-02 refactor moved the live soft-delete path to softDeleteGuarded: soft-delete-plan.ts:100 calls deps.planRepo.softDeleteGuarded(...), and the in-file comment at line 24-29 states the former planRepo.softDelete two-step call "has been replaced by the single atomic softDeleteGuarded method." A repo-wide grep for the plans-module softDelete method shows ZERO remaining production callers — the only references are (a) the unreachable method body at plan-repo.ts:327-342, (b) its PlanRepo port declaration at ports.ts:103, (c) doc comments, and (d) test vi.fn() mocks across tests/unit/plans/application/*. (The broadcasts-module softDelete at broadcast-templates-port.ts / delete-broadcast-template.ts is a SEPARATE port and is genuinely live — it is not the plans method under review.) The simpler form proposed (delete the plans softDelete method + its port decl, drop the softDelete: vi.fn() mock lines) is correct and leaves softDeleteGuarded as the single soft-delete path. The footgun is real: the surviving softDelete body (plan-repo.ts:327-342) is a bare UPDATE with no pg_advisory_xact_lock and no member-count check, so a future maintainer who calls it would silently bypass the W0-02 advisory lock + member-count guard and re-open the soft-delete-vs-assign TOCTOU that the refactor closed. This is a valid cleanup/G-simplify finding; the mechanism is factually present in the current source, though the failure is latent (no caller exercises it today).
