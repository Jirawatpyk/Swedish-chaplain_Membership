The key facts check out. The `observeGauge` helper signature matches the F10 call exactly, and the JSON-key serialization with sorted labels confirms the test re-keying is correct. The disable-user audit double-emit (account_disabled + concurrent_sessions_revoked when sessionsRevoked > 0) confirms the finding about the test not asserting append call count. All five findings are mechanically verified. Writing the report.

---

# Code-Review #9–#14 Remediation — Defect Report

## 1. Headline

**No ship-blocker. Zero CONFIRMED correctness defects introduced by the diff.**

All five verified findings are **CONFIRMED** but every one is **low-severity / informational**: two are pre-existing or non-introduced test-quality gaps, two are missing-assertion / missing-test gaps in the remediation's own coverage, and one is a low-severity response-staleness window that is **non-exploitable through the API today** (the constructed `user` object is dead at the HTTP boundary). The five fixes (F9, F10, F11, F13, F14) are mechanically sound: typecheck 0, lint 0, and every cited GREEN suite holds. F12 is intentionally deferred (out of scope).

- Ship-blocker: **none**
- CONFIRMED correctness defects (state/security/persistence): **0**
- CONFIRMED low-severity / test-coverage / altitude findings: **5**

## 2. Findings Table

| Rank | File:line | Kind | Verdict | Summary |
|------|-----------|------|---------|---------|
| 1 | `src/modules/auth/application/enable-user.ts:79` (+ `disable-user.ts:128-131`) | correctness | CONFIRMED (low) | Spread of pre-mutation `target` echoes stale `role`/`email`/`displayName` if a concurrent op committed between read and mutation. Mutated fields are correct. |
| 2 | `tests/unit/lib/metrics-w009-renewals.test.ts:101` | correctness (test) | CONFIRMED (low) | `beforeEach` never resets module-internal `gaugeValues`; tests pass only via distinct tenant ids. Pre-existing, **not** introduced by F10. |
| 3 | `src/app/api/cron/broadcasts/dispatch-scheduled/route.ts:199` | correctness (coverage) | CONFIRMED (low) | New `case 'dispatch.server_error'` route arm has **no** unit/contract/route test; only the use-case producer is covered. |
| 4 | `tests/unit/auth/application/enable-disable-return-state.test.ts:105` | altitude (test) | CONFIRMED (low) | disable success test mocks `deleteByUserId→2` (fires 2 audit appends) but never asserts `append` call count → second `concurrent_sessions_revoked` emission unlocked. |
| 5 | `src/modules/auth/application/enable-user.ts:78` | altitude | CONFIRMED (info) | Constructed `user` object is **dead** at HTTP boundary — neither route reads `result.value.user`; finding #1 is non-exploitable through the API today. |

## 3. Per-Finding: failure + quoted line + fix

### Finding 1 — stale spread fields (correctness, low)
**Failure:** Admin A re-enables user U while Admin B concurrently commits a role change `member→manager`. A's response payload echoes the pre-mutation snapshot, reporting `role: 'member'` even though the committed DB row is now `manager`. The deleted post-mutation re-read would have observed the concurrent change. The mutated fields (`status`/`failedSignInCount`/`lockedUntil`) are always correct — they're hard-set by the spread to mirror the SQL SET.
```
return ok({ user: { ...target, status: 'active', failedSignInCount: 0, lockedUntil: null } });
```
**Fix (optional, low priority):** None required for ship — persisted DB state is correct and the contract only promises the mutated fields. If a future surface starts rendering `result.value.user` optimistically (see Finding 5), restore a single post-mutation `findById` **without** the self-contradicting 404 (return the constructed state as fallback if the re-read is null, so it never re-introduces the W2-01 audit-vs-404 contradiction). Do **not** block the commit on this.

### Finding 2 — missing `gaugeValues` reset in metrics test (test-quality, low)
**Failure:** A future `pipelineRowCount` test reusing an existing `tenant+band` pair (e.g. `tenant-rg`/`t-30`) silently reads the stale `42` from the earlier test instead of its own value — order-dependent false green.
```
beforeEach(() => {
    counterAddsByName.clear();
    histogramRecordsByName.clear();
    observableGaugesCreated.clear();
  });
```
**Fix:** Add a `__test__clearGaugeValues()` reset export to `src/lib/metrics.ts` and call it in `beforeEach`. **Pre-existing gap — F10 did not introduce it** (HEAD beforeEach was identical and already relied on distinct tenants). Not a remediation defect.

### Finding 3 — no route-level test for `dispatch.server_error` arm (coverage, low)
**Failure:** A refactor renaming/moving the `dispatch.server_error` kind silently drops it back into the `default:` arm (re-paging on-call for transient DB blips via `cronUnknownErrorCount()` + ERROR span), or a genuinely-permanent kind gets mis-added here and stops paging — neither is caught by the test net. The use-case unit suite (34 GREEN) verifies the producer; the e2e only asserts `status===200` + processed count.
```
case 'dispatch.server_error':
            // code-review #11 ...
            summary.retryable++;
            logger.warn( ... 'cron.broadcasts.dispatch.server_error', );
            break;
```
**Fix:** Add a cheap route-level unit test mocking `dispatchScheduledBroadcast → { ok:false, error:{ kind:'dispatch.server_error' } }` and asserting `summary.retryable===1 && summary.unknown_error===0 && cronUnknownErrorCount not called`. Recommended before close, not a blocker.

### Finding 4 — disable test does not lock second audit emission (test-altitude, low)
**Failure:** `deleteByUserId` mocked to `2` makes the source fire `audit.append` **twice** (`account_disabled` + `concurrent_sessions_revoked`, confirmed at `disable-user.ts:104` and `:113`), but the test asserts only `sessionsRevoked===2` (sourced from the mock return, not the audit emission). A refactor dropping the `concurrent_sessions_revoked` block stays green.
```
expect(disable).toHaveBeenCalledOnce();
    expect(findById).toHaveBeenCalledOnce();
```
**Fix:** Add `expect(append).toHaveBeenCalledTimes(2)` (and ideally a `toHaveBeenCalledWith` on the `concurrent_sessions_revoked` event) to the disable success test. Test correctly locks the #9 scope (status transition + findById-once); this is an additive hardening, not a blocker.

### Finding 5 — constructed `user` is dead at HTTP boundary (altitude, info)
**Failure (latent only):** `enable/route.ts` returns `{ ok: true }` and `disable/route.ts` returns `{ ok: true, sessionsRevoked }` — neither reads `result.value.user`. The carefully-constructed object is never serialized today, so Finding 1's staleness is non-exploitable through the API. No integration test pins the constructed object against the real SQL SET; only the new unit test (which hand-builds the same fixture) does, so it cannot catch construction-vs-SET drift.
```
if (result.ok) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }
```
**Fix:** None for this commit. If a future endpoint returns `result.value.user`, add an integration test that re-reads via `db.select()` and compares to the returned object to catch drift between the hand-construction and `userRepo.enable/disable`'s SET.

## 4. Bottom Line

**The #9–#14 diff is SAFE to commit.** It introduces **zero correctness defects** that affect persisted state, tenant isolation, security, audit ordering, or `Result<T,E>` semantics. Verified facts:

- **F9** (enable/disable return-state): constructed states mirror the repo SET exactly (`enable` SET = status+failedSignInCount=0+lockedUntil=null; `disable` SET = status only). The deleted re-read was a should-never-happen path for never-hard-deleted active/disabled rows. The only residue is a low-severity, currently-dead response-staleness window (Findings 1 + 5).
- **F10** (metrics): `observeGauge` 4-arg signature matches the call; JSON sorted-label keying is identical OTel output; the 4 re-keyed assertions are correct. Latent test-isolation gap (Finding 2) is pre-existing, not introduced.
- **F11** (dispatch arm): correctly buckets the transient typed infra error to `retryable` (log-only) before `default:`, preventing a false `unknown_error` page. Coverage gap only (Finding 3).
- **F13** (`rateLimitedJson`): body byte-identical to prior inline shape; standardizes the floor-1s `Retry-After` (never `0`) across all 9 F4 routes; correctly scoped to F4 Group-A and leaves per-site `logger.warn`/audit at the call site. No semantic regression.
- **F14** (`activateOnEnterSpace`): pure extraction of the Enter/Space handler, behaviorally identical (`preventDefault()` + activate), correctly distinguished from edit-mode `handleKeyDown`.

Recommended (non-blocking) follow-ups: add the route-level test for the `dispatch.server_error` arm (Finding 3) and the `append` call-count assertion to the disable test (Finding 4) before closing the review thread.

Relevant file paths:
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\auth\application\enable-user.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\modules\auth\application\disable-user.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\app\api\cron\broadcasts\dispatch-scheduled\route.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\metrics.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\src\lib\rate-limit-helpers.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\unit\lib\metrics-w009-renewals.test.ts`
- `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\tests\unit\auth\application\enable-disable-return-state.test.ts`