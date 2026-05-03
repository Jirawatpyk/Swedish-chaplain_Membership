# Staff Review Report: F7 Email Broadcast — R7 Verification + Fresh Pass

**Reviewer**: AI Agent orchestrating 5 specialist sub-agents (`/speckit-staff-review-run`)
**Date**: 2026-05-03
**Branch**: `010-email-broadcast-phase-8` HEAD `28cc851` (R6 fixes commit)
**Base**: `main` (`a01d2fc`) — 7 commits ahead, 155 files changed (+8,868 / −1,197)
**Method**: 5 parallel specialist sub-agents (reliability, security, performance, spec, test). Each read R6 fixes fresh.
**Verdict**: ❌ **CHANGES REQUIRED** — 1 HIGH reliability defect + 2 HIGH test-coverage gaps that R6 missed.

---

## Executive Summary

R7 verifies R6 (commit `28cc851`) and runs a fresh pass on the same surfaces. R6 fixes are **largely correct** — all 4 Blockers (B1/B2/B3/B4) and most Warnings are properly implemented. However R7 surfaces three new HIGHs:

1. **HIGH-1 (Reliability)**: `approve-broadcast.ts:155` has the SAME bare-catch defect that R6 W-R2 fixed in `cancel-broadcast.ts`. The fix was applied to the cancel use-case only; the parallel approve use-case still swallows DB errors as `broadcast_concurrent_action_blocked` with `status: 'unknown'` instead of `approve.server_error`. Neon outage during admin approve = wrong HTTP code (409 vs 500), wrong metric counter, ops can't diagnose.

2. **HIGH-2 (Test Quality)**: R6 B1 changed the `delivered` webhook audit event type from `broadcast_send_started` to `broadcast_delivery_recorded`. The audit-port enum now has the new event, the production code emits it — but **no test in the entire `tests/` tree asserts this event type**. A regression that flips the emit back to `broadcast_send_started` would not be caught by CI.

3. **HIGH-3 (Test Quality)**: `broadcast_dispatch_idempotency_conflict_pre_send` (added in Phase 8 verify-fix R3 Errors-C1) has zero test assertions in the mock chain. The audit-event-type-emission test greps source literals so the event passes its grep — but no behaviour test pins that the use-case actually emits it on the concurrent-dispatch path.

In addition: 7 MEDIUM findings (mostly carry-forward documentation gaps + a legacy F1/F4 timing-unsafe Bearer compare flagged because user explicitly scoped "ทั้งหมด"); 9 LOW; 4 INFO. Static gates remain green: typecheck ✅, lint ✅, check:i18n ✅ (1,721 × 3), check:layout ✅ (68 pairs), full vitest 285 files / 3,153 tests GREEN.

The 3 HIGHs are all small fixes (< 1 hour total). Once closed, branch is /speckit.ship-ready pending the 3 stakeholder gates (DPO fill, Resend DPA scope, marketing-consent paperwork).

---

## R6 Fix Verification — Status Matrix

| R6 ID | Status | Evidence |
|-------|--------|----------|
| **B1** delivered audit semantic | ✅ Code | `process-webhook-event.ts:256` emits `broadcast_delivery_recorded`. Count assertion `extends 43`. **Test gap surfaces below as HIGH-2.** |
| **B2** zero-recipient guard | ✅ | `process-webhook-event.ts:475–477` `count > 0 && terminalCount >= count` |
| **B3** logger redact F7 paths | ✅ Code (test gap) | 11 fields × 2 assertions (`.not.toContain` + `.toContain('[REDACTED]')`). Depth-2 patterns added in `logger.ts`. **Test for depth-2 `audit.payload.recipient_emails` shape missing — see T-F7-12 below.** |
| **B4** outbox atomicity test | ✅ | Comment block rewritten honestly; assertion still `result.ok === true` per AS3 observability-not-tx contract. |
| **W-R1** send-now retry budget | ✅ | `epochForBudget = scheduledFor ?? approvedAt ?? createdAt` line 596–598 |
| **W-R2** cancel catch narrowed | ✅ partial | `cancel-broadcast.ts:193` narrowed. **`approve-broadcast.ts:155` NOT narrowed — see HIGH-1 below.** |
| **W-R3** subject_empty audit | ✅ | `audit-port.ts` count 43; emit `submit-broadcast.ts:350` matches Result kind. |
| **W-P1** admin queue N+1 | ✅ docs | Documented as bounded-by-page-size 50. |
| **W-P2** SLA stats cache | ✅ | `unstable_cache(computeSlaStatsForTenant, …, { revalidate: 300 })` per-tenant key. **No collision risk verified.** |
| **W-P3** tick-memoized bridge | ✅ | `makeTickMemoizedMembersBridge` correct spread + sort tier codes; per-tick scope. |
| **W-P4** reconcile parallel | ✅ | Chunked `Promise.allSettled` semaphore=5; counter race-safe (JS single-thread). |
| **W-P5** dead metric removed | ✅ | `cronSkippedCount` reason union narrowed; alert rule already removed in R3 G3. |
| **W-P6** active span | ✅ | `withActiveSpan` helper added. **Untested — see LOW-A below.** |
| **W-S1** audit count = 43 sync | ⚠️ partial | `audit-port.ts` ✅, `data-model.md § 5` ✅, `CLAUDE.md` Recent Changes ✅. **Active Technologies bullet still says "37" — see MED-1 below.** |
| **W-S2** drift_check emission | ✅ | `dispatch-scheduled-broadcast.ts:770`. |
| **W-S3** cross-tenant probe emission | ✅ | `enforce-tenant-context.ts:65,81`. Tenant-isolation comment updated. |
| **W-T1** immutable-trigger integration test | ✅ partial | 5 of 7 trigger-guarded fields covered. **`segment_type` + `segment_params` missing — see MED-3 below.** |
| **W-T2** drop `as unknown` cast | ✅ | Fixture type-aligned. |
| **W-T3** real DOMPurify in halt+sanitiser | ✅ | `stubSanitizer = dompurifySanitizer` alias. |
| **W-T4** Bangkok TZ boundary | ✅ | 2 tests with explicit `payload['quotaYear']` assertions. |
| **W-T5** phaseOf approved+sending | ✅ | 5 new tests with timestamp invariants pinned. |
| **W-T6** subject 200/201 boundary | ✅ partial | Test exists. **"exactly 200" uses conditional `if (!result.ok)`, doesn't assert `ok === true` — see MED-5 below.** |

**R6 closure rate: 19/21 fully closed; 2 partial (W-R2 missed approve-broadcast, W-S1 missed CLAUDE.md bullet); plus test-coverage gaps for B1/B3.**

---

## R7 Findings (top 24)

### 🔴 Blockers
None.

### 🟠 HIGH (3) — must fix before ship

| ID | File:Line | Defect | Fix |
|----|-----------|--------|-----|
| **HIGH-1** | `src/modules/broadcasts/application/use-cases/approve-broadcast.ts:155` | Bare `catch {}` swallows ALL throws from `applyTransition`. R6 W-R2 fixed the same pattern in `cancel-broadcast.ts:193` but missed the parallel approve use-case. Neon outage = wrong error kind, wrong HTTP, wrong metric. | Narrow to `catch (e) { if (!(e instanceof BroadcastConcurrentMutationError)) throw e; … }` per W-R2 pattern. |
| **HIGH-2** | `tests/unit/broadcasts/application/process-webhook-event.test.ts` | R6 B1 added `broadcast_delivery_recorded` event type + emission site. **Zero behaviour-tests assert this event in the mock chain.** A regression to `broadcast_send_started` ships green. | Add `it('delivered event → emits broadcast_delivery_recorded (not broadcast_send_started)')` with `audit.emits.find(e => e.eventType === 'broadcast_delivery_recorded').toBeDefined()`. |
| **HIGH-3** | `tests/unit/broadcasts/application/dispatch-scheduled-broadcast.test.ts` | `broadcast_dispatch_idempotency_conflict_pre_send` (Errors-C1, Phase 8 verify-fix R3) has zero test assertions in the mock chain. Comment at line 1710 lists it as test target but never authored. | Add concurrent-dispatch test: simulate `createAudience` pre-send conflict → assert this audit event emits. |

### 🟡 Warnings (10)

**Reliability**
- **MED-R1** `tick-memoized-members-bridge.ts:19` JSDoc says "pure pass-through for the other 6 methods" but `MembersBridgePort` has 9 methods. Comment drift, not a functional bug. Update to "8 methods".
- **MED-R2** `cancel-broadcast.ts:126` `broadcast_cancel_too_late` audit emits with `null` tx (outside `withTx`). No state mutation follows so impact = 0 today, but inconsistent with F5 in-transaction-audit pattern. Document or fold in.

**Security**
- **MED-S1** (T-F7-01) `src/app/api/cron/outbox-purge/route.ts:46` + `src/app/api/cron/lockout-cleanup/route.ts:46` use string `!==` for Bearer compare (timing-unsafe). F7 cron routes correctly use `verifyCronBearer()`. Legacy F1/F4 routes left untouched. **Side-channel risk on auth credential compare.** Backfill with `verifyCronBearer()` (out-of-F7-scope but user explicitly scoped "ทั้งหมด").
- **MED-S2** (T-F7-02) `tests/unit/lib/logger-redact.test.ts:449–467` tests `*.body_html` (depth-1) but does not exercise `audit.payload.recipient_emails` (depth-2) shape that production logs use. R6 added the depth-2 redact paths but didn't assert them in test. Add `captureLog({ audit: { payload: { recipient_emails: [...] } } })` assertion.
- **MED-S3** (T-F7-03) `process-webhook-event.ts:394` calls `setMemberHalt` with implicit privilege check (relies on system-context). No explicit guard `actorUserId === 'system:resend-webhook'`. Add typed `SystemActor` or runtime assertion.
- **MED-S4** (T-F7-04) `peekTokenTenantId`/`peekTokenLang` are pre-HMAC trusted reads. Used today only for UI `<title>` locale (acceptable). Add branded `UnverifiedTenantSlug` type to prevent accidental trusted use.
- **MED-S5** (T-F7-05) `dompurify-sanitizer.ts:90` `hookInstalled` module-level flag is Vercel Functions safe but would be unsafe under Edge runtime. Add explicit `if (typeof globalThis.window !== 'undefined') throw` Edge-runtime guard.

**Spec**
- **MED-1** `CLAUDE.md` Active Technologies bullet still says "37 new audit event types". `data-model.md § 5` and `audit-port.ts` correctly say 43. Carry-forward of W-S1 (R6) — partially missed.

**Test**
- **MED-T1** `tests/integration/broadcasts/immutable-after-submit.test.ts` covers 5 of 7 trigger-guarded fields. Add `segment_type` + `segment_params` UPDATE cases.
- **MED-T2** `tests/unit/broadcasts/application/process-webhook-event.test.ts` terminal-state guard test asserts `transitions === 0` but doesn't assert the delivery row IS still recorded (FR-025 idempotency requires terminal path ≠ replay path).
- **MED-T3** `submit-broadcast.test.ts` "exactly 200 chars → accepted" boundary test uses conditional `if (!result.ok) { expect(...).not.toBe('subject_too_long') }`. If `result.ok === true` (the desired path) all assertions skip silently. Replace with `expect(result.ok).toBe(true)`.

### 🟢 Suggestions (9)

- **LOW-P1** `src/app/api/broadcasts/.../approve/route.ts:132–135` — `approveSendNowDurationMs` histogram missing on exception path. Move to `finally`.
- **LOW-A** `withActiveSpan` (`src/lib/otel-tracer.ts`) untested. Add unit test covering happy path + exception propagation + child-span parenting.
- **LOW-B** `makeTickMemoizedMembersBridge` untested. Add unit test: cache hit on identical key, miss on different tier codes, pass-through `setMemberHalt`.
- **LOW-C** `unstable_cache` is first F7 use of this pattern. Add Complexity Tracking entry to `plan.md`.
- **LOW-D** (T-F7-06) `process-webhook-event.ts:580` `logger.error({ err: e })` could leak PII via `cause` chain. Strip cause: `err: { message: e.message, name: e.name }`.
- **LOW-E** (T-F7-07) `decodeBase64Loose` UTF-8 fallback during webhook secret rotation = silent misconfig. Promote warn to `broadcast_webhook_signature_rejected` audit.
- **LOW-F** (T-F7-09) Kill-switch check after tenant resolution. Reorder so kill-switch fires first.
- **LOW-G** (T-F7-11) Unknown Resend event type currently throws `bad_signature` — noisy alert. Return `kind: 'unknown_event_type'` for graceful 200-ack.
- **LOW-S1** `audit-port.ts:35` section header comment says "15 events" but the section has 16 entries. Off-by-one stale comment.

### ℹ️ INFO (4)
- **INFO-1** Submit rate-limit key construction not visible in agent's snippet — verify it's `f7:submit:${tenantId}:${memberId}` not just `${memberId}` (cross-tenant DoS surface).
- **INFO-2** `subject_empty` 422 wire code carries `'subject_too_long'` precondition tag (R6 W-R3 documented trade-off).
- **INFO-3** `audit-port.ts:25` comment marks `broadcast_unsubscribed` and 3 sibling events as "US5-deferred" — actually shipped Phase 6 (US4). Stale taxonomy comment.
- **INFO-4** `KNOWN_NOT_YET_EMITTED = []` post-R6 (good); grep is string-literal so dynamic event-type construction would evade detection (best-effort acceptable).

---

## SLO Status (UNVERIFIED)

| SLO | Budget | Status |
|-----|--------|--------|
| SLO-F7-001 Compose TTFB | < 600ms | UNVERIFIED — staging Speed Insights |
| SLO-F7-002 Submit endpoint | < 1.2s | UNVERIFIED |
| SLO-F7-003 Admin queue list | < 500ms @ 1k | UNVERIFIED (R6 W-P2 cache should help) |
| SLO-F7-004 Approve & send-now | < 1.5s | UNVERIFIED |
| SLO-F7-005 Webhook handler | < 250ms | UNVERIFIED |
| SLO-F7-006 Unsubscribe TTFB | < 400ms | UNVERIFIED |

All 6 require staging deployment + Vercel Speed Insights + 7-day prod RUM (human gates T213/T215 from `retrospective.md`).

---

## Constitution v1.4.0 Alignment (post-R6)

| Principle | Status | Notes |
|-----------|--------|-------|
| I — Tenant Isolation (NON-NEG) | ✅ | RLS+FORCE 4 tables; runInTenant; cross-tenant integration test green; W-S3 emission verified. |
| II — Test-First (NON-NEG) | ⚠️ | HIGH-2 + HIGH-3 are TDD gaps on R6/R3 audit-event semantic fixes. |
| III — Clean Architecture (NON-NEG) | ✅ | `tick-memoized-members-bridge.ts` correctly in Infrastructure; barrel exports proper. |
| IV — PCI DSS (NON-NEG) | N/A | F7 has no payment surface. |
| V — i18n | ✅ | 1,721 keys × EN/TH/SV. |
| VI — Inclusive UX (WCAG 2.1 AA) | ✅ | broadcast-a11y.spec.ts. |
| VII — Perf & Observability | ⚠️ | 6 SLOs UNVERIFIED; LOW-A `withActiveSpan` untested. |
| VIII — Reliability | ⚠️ | HIGH-1 `approve-broadcast` bare catch. |
| IX — Code Quality | ✅ | Solo-maintainer substitute. |
| X — Simplicity | ✅ | YAGNI rejections documented. |

---

## Metrics Summary

| Metric | Value |
|---|---|
| Files reviewed (R6+R7) | 155 |
| Lines added / removed | 8,868 / 1,197 |
| 🔴 Blockers | **0** |
| 🟠 HIGH | **3** (HIGH-1 reliability, HIGH-2 + HIGH-3 test coverage) |
| 🟡 Warnings | 10 (2 reliability + 5 security + 1 spec + 3 test) |
| 🟢 Suggestions | 9 |
| ℹ️ INFO | 4 |
| Static gates | typecheck ✅ · lint ✅ · check:i18n ✅ (1,721 × 3) · check:layout ✅ (68 pairs) |
| Test count | 285 files / 3,153 tests GREEN |
| R6 closure rate | 19/21 fully + 2 partial |
| Constitution NON-NEG | I ✅ · II ⚠️ (HIGH-2/3) · III ✅ · IV n/a |

---

## Recommended Actions

### Must Fix (HIGH — `/speckit.ship`-gating)
1. **HIGH-1** Narrow `approve-broadcast.ts:155` catch to `BroadcastConcurrentMutationError` only (mirror W-R2 pattern from cancel-broadcast).
2. **HIGH-2** Add `broadcast_delivery_recorded` audit-emit assertion in `process-webhook-event.test.ts` (delivered-event path).
3. **HIGH-3** Author `broadcast_dispatch_idempotency_conflict_pre_send` test in `dispatch-scheduled-broadcast.test.ts` (concurrent createAudience conflict path).

### Should Fix (Warnings)
4. **MED-S1** Backfill `verifyCronBearer()` in `outbox-purge/route.ts` + `lockout-cleanup/route.ts` (timing-safe).
5. **MED-S2** Add depth-2 `audit.payload.recipient_emails` test in `logger-redact.test.ts`.
6. **MED-1** Sync `CLAUDE.md` Active Technologies bullet to "43 audit event types".
7. **MED-T1** Add `segment_type` + `segment_params` cases to `immutable-after-submit.test.ts`.
8. **MED-T2** Assert delivery row insert in terminal-state guard test.
9. **MED-T3** Replace conditional with `expect(result.ok).toBe(true)` in 200-char boundary test.
10. **MED-S3 / MED-S4 / MED-S5** Optional hardening (privilege check, branded type, Edge-runtime guard).
11. **MED-R1 / MED-R2** Comment fixes (tick-memoized count drift, cancel_too_late audit doc).

### Nice to Fix (Suggestions)
- LOW-A withActiveSpan unit test
- LOW-B tick-memoized unit test
- LOW-C unstable_cache plan.md entry
- LOW-D logger.error err.cause stripping
- LOW-E webhook secret rotation audit
- LOW-F kill-switch ordering
- LOW-G unknown Resend event graceful handling
- LOW-P1 approveSendNowDurationMs finally
- LOW-S1 audit-port section header off-by-one

### Stakeholder Gates (cannot close in code — orthogonal)
- DPO contact fill in `breach-notification.md`
- Resend DPA scope confirmation for Broadcasts API surface
- Marketing-consent paperwork sign-off
- 9 human-gated tasks per `retrospective.md`

---

## Verdict Rationale

**❌ CHANGES REQUIRED.** R6 was a strong pass (19 of 21 findings fully closed) but R7 surfaces 3 HIGHs that R6 missed:

- **HIGH-1** is exactly the same defect R6 W-R2 fixed in `cancel-broadcast` — the parallel approve use-case was overlooked. The fix is mechanical (≤ 5 lines).
- **HIGH-2** and **HIGH-3** are TDD gaps (Constitution Principle II) on audit-event-type semantic fixes. Both R6 (B1) and Phase 8 verify-fix R3 (Errors-C1) added new audit event types but never asserted them in behaviour tests. The audit-event-type-emission test only does string-literal grep — meaningful for catching "did anyone declare-but-never-emit?" but not for catching "did the right code path emit the right event?". A regression to the old event type would ship green.

Once these 3 close, branch is /speckit.ship-ready pending the 3 stakeholder gates. Total fix scope: ≤ 1 hour for HIGHs alone, ≤ 4 hours including all MEDIUMs.

---

## Post-Review Actions

- **Recommended next step**: Fix HIGH-1 + HIGH-2 + HIGH-3 in a single PR with 3 small commits + new tests. Re-run static gates + full vitest.
- **Then**: address MEDIUMs in same PR or follow-up.
- **Then**: stakeholder gates → SLO measurement (T213/T215) → `/speckit.ship`.

---

## Method Note

R7 is the second deep pass (post-R6). Compared to R6, this round caught:
- A "fix-by-pattern-match" gap (W-R2 applied to one of two parallel use-cases).
- TDD gaps on R6's own behaviour-changes (B1) and earlier verify-fix audit additions (Errors-C1).
- Documentation drift introduced by R6 (CLAUDE.md bullet).

Lesson: when fixing a pattern (bare-catch narrowing), grep for ALL instances. When adding a new audit event type, write the behaviour-test alongside the emit. When updating audit count, update ALL three docs (audit-port + data-model + CLAUDE.md), not the first two.
