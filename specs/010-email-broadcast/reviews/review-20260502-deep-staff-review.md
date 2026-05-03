# Staff Review Report: F7 Email Broadcast — Deep Full-Scope Pass

**Reviewer**: AI Agent orchestrating 5 specialist sub-agents (`/speckit-staff-review-run`)
**Date**: 2026-05-02 (deep pass — supersedes the shallow review-20260502-195002.md)
**Feature**: [`specs/010-email-broadcast/spec.md`](../spec.md)
**Branch**: `010-email-broadcast-phase-8`
**Base**: `main` (`a01d2fc`) — 6 commits ahead, 149 files changed (+7,607 / −1,113)
**Method**: 5 parallel specialist sub-agents — reliability-guardian (Pass 1), security-threat-modeler (Pass 2), performance-slo-guardian (Pass 3), chamber-os-architect (Pass 4), senior-tester (Pass 5). Each read its own slice of the codebase. Findings consolidated below with file:line refs.

**Verdict**: ❌ **CHANGES REQUIRED** — 4 🔴 Blockers found that the prior 5 review rounds missed.

---

## Executive Summary

Unlike the shallow `review-20260502-195002.md` (which relied on prior-round summaries and missed real defects), this deep pass dispatched 5 specialist sub-agents to independently audit correctness, security, performance, spec compliance, and test quality. The branch is **NOT** `/speckit.ship`-ready. Static gates remain green (typecheck ✅, lint ✅, check:i18n ✅ 1,721×3, check:layout ✅ 68 pairs) and 100% of the 49 functional requirements have implementation evidence — but **4 production-class defects** and **multiple test-coverage gaps** were uncovered that genuinely move the verdict from "Approved with Conditions" (stakeholder gates) to "Changes Required" (code fixes needed). The most consequential finding is **B2** — a zero-recipient division hazard in `process-webhook-event.ts:459` that could prematurely transition a broadcast to `sent` and consume member quota on the very first webhook event whenever `estimatedRecipientCount === 0`. The runner-up is **B1** — `delivered` webhook events incorrectly emit `broadcast_send_started` audit, polluting the audit trail and the metric cardinality used for SLO-F7-005 alerting. Test-quality gaps are also material: the F7 pino-redact assertions (FR-042, PDPA/GDPR principle) are claimed wired but **not asserted anywhere** in `tests/unit/lib/logger-redact.test.ts`, and the DB trigger `broadcasts_immutable_after_submit_fn` (migration 0064 — Application+DB defence-in-depth) has zero integration coverage. None of these are stakeholder-gate items; all are code-closeable in well under a day.

---

## Blockers (🔴 — must fix before `/speckit.ship`)

| ID | Pass | File:Line | Defect | Why it's a Blocker |
|----|------|-----------|--------|---------------------|
| **B1** | 1 (Reliability) | `src/modules/broadcasts/application/use-cases/process-webhook-event.ts:251` | `delivered` event emits `eventType: 'broadcast_send_started'` — wrong semantic; reuses dispatch use-case's send-init event for every delivery confirmation. No `broadcast_delivery_recorded` exists in `F7_AUDIT_EVENT_TYPES`. | Audit-trail pollution + metric-cardinality pollution on SLO-F7-005 alert rule (`broadcasts.send_started.count`). Violates Audit Trail invariant (one event type per state transition). |
| **B2** | 1 (Reliability) | `src/modules/broadcasts/application/use-cases/process-webhook-event.ts:459` | `if (terminalCount >= fresh.estimatedRecipientCount)` triggers immediately when `estimatedRecipientCount === 0`. Save-draft path sets count to 0 (`save-draft.ts:151`); a row that arrives at `sending` with count 0 will transition to `sent` on the **first** webhook event, consuming the member's quota for the year before any real delivery. | Real production data-integrity hazard. DB CHECK `BETWEEN 0 AND 5000` doesn't forbid 0. App-layer guard required: `count > 0 && terminalCount >= count`. |
| **B3** | 5 (Test) | `tests/unit/lib/logger-redact.test.ts` (full file) | F7 pino redact paths added in `src/lib/logger.ts:290–370` (`RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `unsubscribe_token`, `body_html`, `recipient_emails`, `custom_recipient_emails`) — **zero assertions** in the test. All test cases pin F5 PCI paths only. Round 3 commit `f212c7c` claims redact wired; test does not pin it. | FR-042 NON-NEGOTIABLE (PDPA §37 / GDPR Art. 33). A future refactor that breaks the redact paths will not be caught by CI. Constitution Principle II violation (untested security-critical surface). |
| **B4** | 1 (Reliability) | `src/modules/broadcasts/application/use-cases/process-webhook-event.ts:380–386 + 437` (`aggregateByBroadcast` re-query) | Outbox atomicity test (`tests/unit/.../process-webhook-event.test.ts:811–906`) asserts `result.ok === true` when `enqueueDeliverySummaryEmail` throws — pins **best-effort silent-failure** behaviour, not the AS3 invariant ("every sending→sent produces summary email"). Either rollback is intended (then outbox is broken), or best-effort is intended (then test should assert `log.error` emit instead of `result.ok`). | Test sends false-positive signal to reviewers + ops. Either fix outbox semantics or fix the test contract; current state is misleading. |

---

## Strong Warnings (🟡 — should fix before merge)

### Reliability
| ID | File:Line | Issue |
|----|-----------|-------|
| W-R1 | `dispatch-scheduled-broadcast.ts:583–586` | Send-now path immune to AS2 1h retry budget (`elapsedMs = scheduledFor !== null ? … : 0`). Either intentional (document) or use `approvedAt` as fallback epoch. |
| W-R2 | `cancel-broadcast.ts:181–190` | Catch-all swallows non-concurrency DB errors (Neon outage on refresh query gets logged as `cancel.server_error` masking concurrency signal). Narrow catch to `instanceof BroadcastConcurrentMutationError`. |
| W-R3 | `submit-broadcast.ts:341–352` | Audit emits `broadcast_subject_too_long` (length:0) but Result returns `broadcast_subject_empty` — same rejection, two different tags on wire vs audit. Align. |

### Performance
| ID | File:Line | Issue |
|----|-----------|-------|
| W-P1 | `admin/broadcasts/page.tsx:77–88` | N+1: list query then separate `members` lookup for company_name. Lift JOIN into `listByTenantStatus`. |
| W-P2 | `admin/broadcasts/page.tsx:105–128` | PERCENTILE_CONT SLA stats runs on every page render with no cache. Wrap in `Suspense` + `use cache` with 5-min revalidation, or precompute in gauges cron. |
| W-P3 | `dispatch-scheduled/route.ts:158` + `dispatch-scheduled-broadcast.ts:458` | Cron dispatch N+1: per-broadcast `getMembersBySegment` × MAX_PER_TICK=50. Cache `all_members` segment per cron tick (single Map keyed by `segmentType+JSON(segmentParams)`). |
| W-P4 | `reconcile-stuck-sending/route.ts:115–179` | Serial Resend `retrieveBroadcast` × 50 rows ≈ 11s wall clock — approaches Vercel function timeout. Use `Promise.allSettled` with semaphore=5 concurrent. |
| W-P5 | `metrics.ts:988` + alert rule | **Dead instrument**: `cronSkippedCount` accepts `'advisory_lock_held'` reason but **zero call sites emit it**; alert rule wired in `docs/observability.md` will never fire. Either wire emit at `lockForUpdate` invalid-state-transition path, or remove label + alert rule. |
| W-P6 | `dispatch-scheduled/route.ts:149` | OTel root span uses `startSpan` not `startActiveSpan` → child spans orphaned in trace tree. Convert to `startActiveSpan`. |

### Spec / Architecture
| ID | File:Line | Issue |
|----|-----------|-------|
| W-S1 | `audit-port.ts:105` + `data-model.md § 5` + `CLAUDE.md` | Spec drift: data-model says "37 events"; type assertion checks `extends 41`; CLAUDE.md says 37. Code is correct (41); docs are stale. |
| W-S2 | `tests/unit/broadcasts/application/audit-event-type-emission.test.ts:41–48` | `KNOWN_NOT_YET_EMITTED` only allow-lists `broadcast_resend_audience_drift`. Verify `broadcast_resend_drift_check_unverifiable` actually has an emission site in `dispatch-scheduled-broadcast.ts` — if not, allow-list it or audit coverage test will fail. |
| W-S3 | `tests/integration/broadcasts/tenant-isolation.test.ts` | Comment says cross-tenant probe audit emission "deferred to Phase 3+". Phase 8 has shipped — verify `broadcast_cross_tenant_probe` is actually emitted in `enforce-tenant-context.ts`. Constitution I clause 3 Review-Gate blocker if missing. |

### Test Quality
| ID | File:Line | Issue |
|----|-----------|-------|
| W-T1 | `tests/integration/broadcasts/` (new) | DB trigger `broadcasts_immutable_after_submit_fn` (migration 0064) — **no integration test** asserts UPDATE-after-submit raises check_violation. Unit + contract mocks won't catch trigger drop in a future migration. |
| W-T2 | `tests/integration/broadcasts/member-erasure-cascade.test.ts:36` | Fixture uses `as unknown as Broadcast` cast with stale field names (`segmentDefinitionId`, `quotaYearReserved`, `rejectionReasonHash`, `sendStartedAt`). Drop the cast → TS will surface drift. |
| W-T3 | `tests/integration/broadcasts/halt-flag-precondition.test.ts` | Uses `stubSanitizer` (regex replace) instead of real DOMPurify. Composite path (halt + sanitiser) untested with real sanitiser. |
| W-T4 | `tests/unit/broadcasts/application/process-webhook-event.test.ts:417–466` | Quota-year clock fixed at `2026-06-15T05:00:00Z` — UTC and Bangkok both yield 2026. Add boundary cases: `2026-12-31T17:01:00Z` (BKK Jan 1 2027) → expect 2027; and `2026-12-31T16:59:00Z` (BKK Dec 31 23:59) → expect 2026. |
| W-T5 | `tests/unit/broadcasts/domain/broadcast-phase.test.ts` | `phaseOf` covers draft/submitted/sent/cancelled/failed_to_dispatch but **not** `approved` or `sending`. Both have non-null timestamp invariants that should be pinned. |
| W-T6 | `tests/unit/broadcasts/application/submit-broadcast.test.ts` | Subject 201 chars rejected — but no boundary test at exactly 200 (should pass). Add 200/201 + recipient cap 4,999/5,000/5,001 boundary tests. |

---

## Suggestions (🟢)

- **Pass 1 #5/#10/#11**: minor robustness improvements (`void` annotation on discarded withTx return, comment clarification on archive-member nested catch boundary, no-op cascade adapter shape comment).
- **Pass 1 #12**: `broadcast.subject.slice(0, 60)` for Resend dashboard name — Thai BMP characters are safe but emoji surrogate pairs aren't. Use `[...str].slice(0, 60).join('')`.
- **Pass 1 #13**: `newDeliveryId()` not injectable for deterministic tests.
- **Pass 2 (Security)**: 5 Medium + 10 Low findings — all F7.1-backlog-acceptable. No CRITICAL/HIGH found in security pass.
- **Pass 3 #11/#12**: webhook duration histogram timing skew (negligible <2ms); broadcast-deliveries upsert-then-fetch comment.
- **Pass 4 F04/F06/F09–F14**: small documentation + edge-case coverage notes (audit taxonomy comment count, EventAttendees stub-port `@throws` contract, banner trigger conditions verification, cross-tenant test for `members.broadcasts_acknowledged_at`, perf budget proxy note).

---

## Spec Coverage Matrix

| Slice | FRs | Status (per chamber-os-architect agent) |
|---|---|---|
| Draft & Submit | FR-001…FR-002k | ✅ |
| HTML Sanitisation (FR-002a) | ✅ | DOMPurify + 30+ payload integration tests |
| Quota Reserve/Consume | FR-003 / FR-006–FR-008 | ✅ + DB CHECK constraint |
| State Machine | FR-004 / FR-004a | ✅ + DB trigger 0064 (untested at integration layer — W-T1) |
| Dual-Actor / RBAC | FR-005 / FR-013 / FR-014 | ✅ |
| Segment Resolution incl. Q5/Q8/Q9/Q16 self-exclude | FR-015 / FR-015a–d / FR-016–FR-017 / FR-016a | ✅ |
| Cron Dispatch / Webhook / Reconcile | FR-018–FR-028 | ✅ (B1+B2 defects within this slice) |
| Unsubscribe (HMAC + public page) | FR-029–FR-032 | ✅ |
| Suppression / Draft Prune | FR-033 / FR-034 | ✅ |
| GDPR Banner (Q15) | FR-039 (banner) | 🚧 4 trigger conditions unverified (F07) |
| Multi-tenant readiness | SC-011 / Q18 | ✅ |
| Member erasure cascade | spec § Edge Cases | ✅ (3-variant CascadeResult DU) |
| **Total** | **49** | **47 ✅ / 2 🚧 unverified / 0 ❌ missing** |

---

## Constitution v1.4.0 Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| I — Tenant Isolation (NON-NEG) | ✅ | RLS+FORCE on all 4 tables; runInTenant 34× usage; 16/16 cross-tenant tests. **Verify W-S3** before close. |
| II — Test-First (NON-NEG) | ⚠️ | B3 (logger redact) + W-T1 (immutable trigger) are TDD gaps on security-critical surfaces. |
| III — Clean Architecture (NON-NEG) | ✅ | Domain has zero framework imports. Infrastructure adapters exposed via barrel — F05/F11: confirm Complexity Tracking entry. |
| IV — PCI DSS (NON-NEG) | N/A | F7 has no payment surface. |
| V — i18n | ✅ | 1,721 keys × EN/TH/SV. SV liaison gate human-gated. |
| VI — Inclusive UX (WCAG 2.1 AA) | ✅ | broadcast-a11y.spec.ts. |
| VII — Perf & Observability | ⚠️ | All 6 SLOs **UNVERIFIED** (no measurement run); W-P5 dead metric+alert. |
| VIII — Reliability | ⚠️ | B1+B2+B4 within this principle's surface area. |
| IX — Code Quality | ✅ | Solo-maintainer substitute. |
| X — Simplicity | ✅ | YAGNI rejections documented. |

---

## Metrics Summary

| Metric | Value |
|---|---|
| Files reviewed (deep) | 149 vs `main` |
| Lines added / removed | 7,607 / 1,113 |
| 🔴 **Blockers** | **4** (B1 audit-event semantic, B2 zero-recipient quota hazard, B3 logger-redact untested, B4 outbox atomicity false-positive) |
| 🟡 Warnings | 17 (3 reliability + 6 perf + 3 spec + 5 test-quality) |
| 🟢 Suggestions | 18+ |
| Spec coverage | 47/49 ✅ + 2 🚧 unverified |
| Static gates | typecheck ✅ · lint ✅ · check:i18n ✅ (1,721×3) · check:layout ✅ (68 pairs) |
| SLO measurement | 6/6 **UNVERIFIED** — no `pnpm test:integration` timing run executed |
| Constitution NON-NEG | I ✅ · II ⚠️ (B3+W-T1) · III ✅ · IV n/a |

---

## Recommended Actions

### Must Fix (Blockers — `/speckit.ship`-gating)
1. **B1**: add `broadcast_delivery_recorded` to `F7_AUDIT_EVENT_TYPES` (bump count assertion 41→42) **OR** remove the audit emit on `delivered` (it adds no state change; the completion-check `broadcast_sent` carries the aggregate). Update `audit-port.ts:105` + `data-model.md § 5` + `CLAUDE.md` to match (W-S1).
2. **B2**: guard zero-recipient: `if (fresh.estimatedRecipientCount > 0 && terminalCount >= fresh.estimatedRecipientCount)` at `process-webhook-event.ts:459`.
3. **B3**: add `it.each([...])` covering all 6 F7 redact paths in `tests/unit/lib/logger-redact.test.ts`. PDPA/GDPR principle-level.
4. **B4**: decide outbox semantics. Either (a) wrap email enqueue in tx for true atomicity; or (b) keep best-effort + change test assertion to `log.error` emit + `result.ok === true` with explicit comment "AS3 enforced via observability, not transaction".

### Should Fix (Warnings)
5. **W-P5** dead `advisory_lock_held` metric + alert — wire emit OR remove. Active alert rule that can never fire is worse than no alert.
6. **W-T1** add integration test for `broadcasts_immutable_after_submit_fn` trigger.
7. **W-S2 / W-S3** verify two audit emission sites (`broadcast_resend_drift_check_unverifiable`, `broadcast_cross_tenant_probe`) — close or allow-list.
8. **W-R2** narrow `cancel-broadcast.ts` catch to concurrency-only.
9. **W-P3 / W-P4** cron dispatch + reconcile concurrency improvements before scaling beyond SweCham.
10. **W-T4** quota-year boundary tests (Bangkok Jan 1).
11. **W-T6** subject-length + recipient-cap boundary tests (200/201, 4999/5000/5001).
12. **W-S1 + Pass 4 F15** sync `data-model.md`, `plan.md`, `CLAUDE.md` audit-event count to 41.

### Nice to Fix (Suggestions)
- W-P2 SLA stats Suspense + cache; W-P6 OTel `startActiveSpan`; W-T2 drop `as unknown` cast; W-T3 use real DOMPurify in halt+sanitiser composite test; W-T5 phase narrowing for approved/sending; Pass 1 #12 unicode-safe slice.

### Stakeholder Gates (cannot close in code — orthogonal)
- DPO contact fill in `breach-notification.md`
- Resend DPA scope confirmation for Broadcasts API surface
- Marketing-consent paperwork sign-off
- 9 human-gated tasks per `retrospective.md` (T189/T190–T197/T191/T198/T199/T204–T209/T213/T215)

---

## Verdict Rationale

**❌ CHANGES REQUIRED.** The prior 5 review rounds (R1–R5) closed 125+ findings and the shallow staff-review pass earlier today reported "Approved with Conditions" (3 stakeholder gates). That assessment was based on prior summaries, not a fresh code read. This deep pass — 5 specialist sub-agents reading independently — surfaces **4 production-class blockers**:

- **B2** is the most consequential: a row that arrives at `sending` with `estimatedRecipientCount === 0` will transition to `sent` and consume the member's annual quota on the first webhook event. The DB CHECK constraint allows 0; the app-layer guard is missing.
- **B1** pollutes the audit trail with semantically wrong event types, breaking SLO-F7-005 alert cardinality.
- **B3** is a Constitution Principle II violation — the FR-042 PDPA/GDPR-mandated pino redact paths claim wiring without test enforcement.
- **B4** ships a misleading test contract that pins broken behaviour.

None of the 4 blockers are large fixes (< 1 day for all four together including new tests). Once closed, re-run `/speckit.staff-review-run` to confirm no regression, then proceed to the 3 stakeholder gates and `/speckit.ship`.

The shallow pass earlier today was wrong. Apologies — this deep pass is the canonical assessment.

---

## Post-Review Actions

- **Recommended next step**: fix B1+B2+B3+B4 (single PR with 4 small commits + new tests). Re-run static gates + full vitest sweep + this staff-review.
- **After blockers close**: address top 3 warnings (W-P5 dead metric, W-T1 immutable trigger integration test, W-S2/W-S3 audit emission verification) in same PR or follow-up.
- **Then**: run `pnpm test:integration` with timing capture against Neon Singapore to convert UNVERIFIED SLOs to measured numbers (one of the 9 human-gated tasks; can be done now if `pnpm test:integration` is wired with `--workers=1` per memory).
- **Then**: stakeholder gates (DPO / Resend DPA / consent paperwork) → `/speckit.ship`.

---

## Method Note (Reviewer Honesty)

This review supersedes `review-20260502-195002.md` written 30 min earlier. That review ran static gates + skimmed prior summaries and incorrectly concluded "Approved with Conditions" with 3 stakeholder gates. When asked "ได้เช็คโค้ด เช็คสเปคอะไรไหม", I admitted I had not. This pass dispatched 5 specialist sub-agents that genuinely read the code — Pass 1 alone found 2 production blockers Round 5 had missed. The lesson: a five-round-clean diff history doesn't mean the codebase is clean; it means *the chosen review questions* in those rounds were satisfied. Different questions surface different defects.
