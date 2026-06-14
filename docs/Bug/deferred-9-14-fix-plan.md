All six findings were already verified by the upstream analysis with current line numbers confirmed at HEAD 04cc09bb. I'll produce the consolidated fix plan directly.

# Deferred Code-Review Findings #9–#14 — Fix Plan (main @ 04cc09bb)

## 1. Status Table

| id | Status | Risk | Recommendation | One-line |
|----|--------|------|----------------|----------|
| F9 — enable/disable 404-after-commit | STILL_PRESENT | low | **fix_now** | Non-atomic mutate→audit→re-read returns self-contradicting 404 after a *successful* enable/disable; return constructed mutated state. |
| F10 — metrics gauge dedup | STILL_PRESENT | low | **scope_down** | Collapse `pipelineRowCount` into the generic `observeGauge` helper; leave `observeCycleStateGauge` alone (pure churn). |
| F11 — dispatch error rebucket | STILL_PRESENT | low | **fix_now** | `dispatch.server_error` (typed, transient) falls to `default`→`unknown_error`, raising a false enum-drift page; add explicit case → `summary.retryable`. |
| F12 — coordinator summary helper | STILL_PRESENT | low | **defer** | DRY-only collapse of 9 W0-09 emit blocks; zero functional change, touches all 5 cron coordinators — post-go-live. |
| F13 — rate-limit helper | STILL_PRESENT | medium | **scope_down** | 25 sites diverge into 7 response shapes; full unify hits PCI/auth/GDPR contracts. Ship Group-A-only helper (9 F4 sites). |
| F14 — inline-cell keyhandler | STILL_PRESENT | low | **fix_now** | Byte-identical Enter/Space display-mode `onKeyDown` duplicated in 2 cells; extract `activateOnEnterSpace`. |

All six are STILL_PRESENT — none dropped. (Sub-claim refutations noted inline: F10's "colon-mislabel" is REFUTED; F12's "~10 sites / all 5 have metric-emitting zero-tenant arm" is corrected to 9 blocks, dispatch's zero-arm audit-only.)

---

## 2. Per-Finding Fix Plan (STILL_PRESENT)

### F9 — enable/disable return constructed state (fix_now, low)
**Change.** The `users` table is never hard-deleted while active/disabled (only `pending` rows are deletable — `user-repo.ts:314-332`), so a null re-read after a successful mutation is should-never-happen and 404 is wrong.

- `src/modules/auth/application/enable-user.ts` — drop the second `findById` + `not-found` fallback (lines 71-76); replace with:
  ```ts
  return ok({ user: { ...target, status: 'active', failedSignInCount: 0, lockedUntil: null } });
  ```
  (mirrors `userRepo.enable` SET at `user-repo.ts:385-390`)
- `src/modules/auth/application/disable-user.ts` — drop the second `findById` + `not-found` fallback (lines 123-130); replace with:
  ```ts
  return ok({ user: { ...target, status: 'disabled' }, sessionsRevoked });
  ```
  (mirrors `userRepo.disable` SET at `user-repo.ts:381-383`)
- Update the W2-01 JSDoc (enable 72-74 / disable 124-125) to state the new invariant.
- **Do NOT** adopt the tx-wrap option (new `enableInTx`/`disableInTx` + audit-in-tx port + `db.transaction` plumbing) — disproportionate to a should-never-happen branch pre-go-live.

**Blast radius.** 2 source files. 0 signature changes — both still return `Result<…Success, …Error>` and `'not-found'` survives via the legit pre-mutation guards (enable 53-54/57, disable 75), so route `case 'not-found'` arms (`enable/route.ts:33`, `disable/route.ts:36`) stay valid → no route edits. Contract tests (`enable-user.test.ts:98-106`, `disable-user.test.ts:99`) mock the use case and assert route 404 for surviving not-found cases — unaffected. Integration `account-lifecycle.test.ts:242-363` exercises only happy + last-admin — unaffected. **Add 1 unit test per file** (mock `findById` happy → mutate → assert `ok` with mutated status) to lock the contract. Net: 2 files + 2 small tests.

**Risk: low** — removes a round-trip, no caller/route/type change.

### F11 — explicit `dispatch.server_error` case (fix_now, low)
**Change.** Add a case to the switch in `src/app/api/cron/broadcasts/dispatch-scheduled/route.ts` immediately before `gateway_retryable` (~L198-199):
```ts
case 'dispatch.server_error':
  summary.retryable++;
  logger.warn(
    { tenantId: tenant.slug, broadcastId: row.broadcast_id, reason: result.error.message },
    'cron.broadcasts.dispatch.server_error',
  );
  break;
```
**Bucket rationale.** It is a *known* union member (`dispatch-scheduled-broadcast.ts:91`, returned L443-446 + L471-476) where the row stays `approved` for clean next-tick retry (comment L459-462) — identical lifecycle to `gateway_retryable`. Today it falls to `default`→`summary.unknown_error++`+`cronUnknownErrorCount` (route L227-243), which `metrics.ts:1345-1360` documents as enum-drift "should be 0, pages on-call" → **false page**. Not `uncaught_error` (that's escaped throws). `summary.retryable` already exists (route L136) and is log-only (no metric counter → no false page). **No new metric method.**

**Blast radius.** 1 file, ~9 lines, additive. `dispatch.server_error` referenced in 5 files; use-case unit test (`dispatch-scheduled-broadcast.test.ts:689,1148`) tests the use case not the route — unaffected. No route-level switch test exists today (the switch buckets are currently unverified), so **optionally add 1 route-level test** asserting a thrown-bridge path lands in `summary.retryable` (additive, breaks nothing).

**Risk: low.**

### F14 — extract `activateOnEnterSpace` (fix_now, low)
**Change.** Add to `src/components/members/use-inline-edit-field.ts` (existing shared inline-edit module — no new file):
```ts
import { type KeyboardEvent } from 'react';
/** Enter/Space activation for non-default-activatable controls (e.g. a <button> whose only mouse path is dblclick). */
export function activateOnEnterSpace(activate: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
}
```
In `src/components/members/members-table.tsx` replace both display-mode handlers (InlineCountryCell L391-396, InlineNotesCell L512-517) with `onKeyDown={activateOnEnterSpace(startEdit)}`; keep the W1-06 comment above the prop. **Do NOT touch** the hook's edit-mode `handleKeyDown` (`use-inline-edit-field.ts:131`, Enter-submit/Escape — different concern).

**Blast radius.** 1 production file edited + 1 helper added. 0 test updates: `inline-edit-cells.test.tsx` enters edit mode via `fireEvent.doubleClick` and only fires keys on the input; `members-inline-edit.spec.ts` drives Enter/Escape on the input — neither targets the display-mode handler, so extraction is assertion-neutral.

**Out of scope (flag, do not fold in).** `member-picker.tsx:290` is a near-dup but adds `stopPropagation()` + `setSelected(null)`/`onChange(null)` on a `role="button"` span inside a PopoverTrigger — reusing the helper needs an optional `stopPropagation` flag and risks the popover/clear interaction. Leave as-is for go-live.

**Risk: low.**

### F10 — collapse `pipelineRowCount` into `observeGauge` (scope_down, low)
**Change.** In `src/lib/metrics.ts` replace the hand-rolled accumulator body of `pipelineRowCount` (L2912-2939) — keeping the public 3-arg signature so the sole caller `load-pipeline.ts:124` is untouched:
```ts
pipelineRowCount(tenantId, urgencyBand, rowCount): void {
  safeMetric(() => {
    observeGauge(
      'renewals.pipeline.row_count',
      'F8 pipeline page row count per load — last observed value per (tenant, urgency_band) (§ 23.1.1)',
      { tenant_id: tenantId, urgency_band: urgencyBand },
      rowCount,
    );
  });
}
```
OTel scrape output is byte-identical (same instrument name, `{tenant_id, urgency_band}` labels, value). Only the internal `gaugeValues` inner-map key changes from `'tenant-rg:t-30'` (colon) to the JSON-sorted-labels form. **Update 5 assertions** in `tests/unit/lib/metrics-w009-renewals.test.ts` (L383, 390, 397-398, 404-405) that read the raw key via `__test__readGaugeValues(...).get('tenant-rg:t-30')` → re-key to `JSON.stringify({tenant_id:'tenant-rg', urgency_band:'t-30'})`.

**Do NOT** convert `observeCycleStateGauge` (L2519-2549): dynamic per-state gauge names + dedicated test `metrics-cycle-state-gauge.test.ts` pins the bare-tenant-slug key across ~8 assertions → rewriting it = pure churn for zero output change on a hot cron path. The colon-mislabel sub-claim is **REFUTED** (tenant = prefix, band = suffix; band enum bounded).

**Blast radius (scoped).** 2 files: `metrics.ts` (1 method body, no signature change) + `metrics-w009-renewals.test.ts` (5 re-keyed assertions). Caller = 0 changes. No `check:*` gate references the gauge name.

**Risk: low.**

### F13 — Group-A-only `rateLimitedJson` helper (scope_down, medium — RISKIEST)
**Do NOT** introduce one global `rateLimitOrRespond` across all 25 sites. Verified divergence into 7 incompatible groups (5 sites don't even emit a plain 429):
- **A (9, F4 "classic")**: `{error:{code:'rate_limited', retryAfterMs: rl.reset-Date.now()}}` + `Retry-After` header. 8 of 9 still inline `Math.ceil` instead of `retryAfterSecondsFromRl`. → **only clean dedup target.**
- **B (4: payments/initiate, payments/[id]/cancel, refunds/initiate, members/bulk)**: emit a best-effort **audit row before the 429** (forensic, Threat F-09) — ordering load-bearing.
- **C (2, F8)**: route via `errorResponse({status:429,…})` (already a helper).
- **D (3)**: bare `{error:{code:'rate_limited'}}`, no `retryAfterMs`.
- **E (1: portal/account/data-export)**: `correlationId` in **body**.
- **F (2 auth)**: `{error:'rate_limited'}` (string) + **lowercase** `retry-after` — contract divergence, do not normalise without auth contract tests.
- **G (3)**: log-optimistic-flip returns `noContent(204)`; cron dispatch + at-risk-recompute wrap in fail-open try/catch with redisFallback metric — different control flow.

**Recommended now.** Add to `src/lib/rate-limit-helpers.ts`:
```ts
export function rateLimitedJson(rl: { reset: number }, opts?: { correlationId?: string }): NextResponse
```
returning the Group-A body + `Retry-After` via existing `retryAfterSecondsFromRl`. Keep per-site `logger.warn`/audit **outside** the helper. Replace only the **9 Group-A** return statements. Leave B/C/D/E/F/G untouched.

**Blast radius.** Scoped: 9 route files + 1 helper export. Body shape byte-identical → most F4 invoice/credit-note/settings contract assertions pass unchanged; verify with `pnpm vitest run tests/contract/invoicing tests/contract/credit-notes`. No audit/tenant-tx/advisory-lock/metric-ordering surfaces in Group A. (Full 25-site rewrite would touch payments+auth+audit contract suites — the ≥2-reviewer PCI/auth/GDPR surfaces — for cosmetic dedup; do not attempt pre-go-live.) The 3 F9 export routes ("touched this session") span Groups D+E and don't even share a body shape with each other — not a clean standalone scope-down target.

**Risk: medium** — highest of the six. Even scoped, it touches 9 route handlers + their contract tests; run the F4 contract suites before commit.

### F12 — `coordinatorSummary` helper (defer, low)
**Change (when done post-go-live).** Add `coordinatorSummary(cronKind, summary: {tenants_enqueued; tenants_succeeded; tenants_failed; duration_ms})` to `renewalsMetrics` in `src/lib/metrics.ts` (~after `coordinatorDurationMs` at :2803). **Inline** the 4 emits (Enqueued/Succeeded/`if(tenants_failed>0)`Failed/DurationMs) — do NOT delegate via `this.…` (breaks per-coordinator unit-test mocks that replace `renewalsMetrics` with a plain object). Replace all 9 inline W0-09 blocks across the 5 coordinators (dispatch 1; at-risk/lapse/reconcile/tier-upgrade 2 each) with one call each; the helper's internal `>0` guard makes zero-tenant 3-call arms collapse to the same call.

**Why defer.** Pure observability DRY, zero behaviour change; the 4 instruments already work and are unit-pinned in `metrics-w009-renewals.test.ts`. Touching all 5 production cron coordinators + rewriting 2 arg-asserting tests (`dispatch-coordinator.test.ts:336-370`, `tier-upgrade-coordinator.test.ts:118,131`) for no go-live benefit adds regression surface (botched inline-vs-delegate silently breaks the per-method mocks). **Correction to finding**: 9 blocks, not "~10" — dispatch's zero-tenant arm (`route.ts:300-319`) emits audit only, no W0-09. Normalising that asymmetry is a tiny intentional behaviour ADD when the helper lands; flag it explicitly.

**Risk: low** (but no urgency).

---

## 3. Recommended Execution Order + Scoping

**Group fix_now (land now, lowest blast radius first):**
1. **F14** — 1 component file + 1 helper, 0 test changes. Pure presentation, no contract/security surface. Safest possible warm-up.
2. **F9** — 2 application files, 0 route/signature change, +2 tiny unit tests. Fixes a real self-contradicting 404; tx-wrap explicitly rejected.
3. **F11** — 1 cron route file, +1 optional test. Stops a false enum-drift page; additive case.

**Group scope_down (land now, scoped — verify suites before commit):**
4. **F10** — `pipelineRowCount`→`observeGauge` only; 2 files. Run `pnpm vitest run tests/unit/lib/metrics-w009-renewals.test.ts`. Explicitly skip `observeCycleStateGauge`.
5. **F13 (RISKIEST — do last, scoped)** — Group-A `rateLimitedJson` over 9 F4 sites ONLY. This is the only **medium**-risk item: it touches route handlers and F4 contract tests. Land it after the four low-risk fixes are green so it can be reviewed/reverted in isolation. **Run `pnpm vitest run tests/contract/invoicing tests/contract/credit-notes` before commit.** Do NOT expand to Groups B–G (payments/auth/audit/GDPR ≥2-reviewer contract surfaces) pre-go-live.

**Group defer (post-go-live cleanup batch):**
6. **F12** — `coordinatorSummary` DRY across 5 cron coordinators. Zero functional benefit, real regression surface in arg-asserting mocks. Bundle into a post-launch observability-cleanup branch; normalise the dispatch zero-tenant-arm asymmetry there as an intentional choice.

**Final gate (per MEMORY).** Run `pnpm typecheck` as the LAST step after the final edit (it is not in pre-push and an earlier run misses later edits). Recommended commit grouping: one commit for F14+F9+F11 (low-risk, no contract surface), a separate commit for F10 (metrics-only), and an isolated commit/PR for F13 (the medium-risk contract-touching change) so it carries its own review and is independently revertable.