---
feature: F9 — Admin Dashboard + Audit + Timeline + Benefit Usage + Directory/E-Book + GDPR Export
branch: 015-admin-dashboard
date: 2026-05-31
completion_rate: 99      # 109 / 110 tasks (T101 = post-merge operator gate)
spec_adherence: 97       # see § Metrics
requirements_total: 54   # 41 FR + 0 NFR + 13 SC
counts:
  implemented: 51
  partial: 3
  modified: 0
  not_implemented: 0
  unspecified: 0
  critical_findings: 0
---

# F9 Retrospective — Spec Adherence & Drift Analysis

## Executive summary

F9 (the oversight & insight layer over F1–F8) shipped with **high spec fidelity**:
all 41 functional requirements implemented, 10/13 success criteria fully verified,
3 success criteria PARTIAL (post-launch usability/adoption KPIs + the prod-scale
perf RUM that needs a 5k-member staging run). **Zero requirements dropped, zero
silent scope creep, zero constitution violations.** Implementation completed
109/110 tasks; the single open task (T101) is a post-merge operator action
(cron-job.org coordinators), not code.

Quality was driven by an unusually deep verification cycle: **four review passes**
(code-review max → adversarial Round 2 → multi-agent PR bot → deferred-item
cleanup), two of which caught real fix-induced regressions — most notably Round 2
catching that the round-1 FR-016 µs-boundary fix was **end-to-end dead** (truncated
by `new Date()` in both consumers). Tenant isolation (Principle I) is two-layer and
proven by a 12/12 cross-tenant blocker test; the FR-016 timeline sargability fixes
(migrations 0196/0197) are EXPLAIN-verified to use every expression index.

Spec adherence is **not** lowered by any divergence — the only "modifications" were
spec **clarifications** resolved in-session (FR-007 manager finance-visibility) that
the spec itself records. The notable positive deviation (GDPR truncation disclosure)
strengthens FR-037 beyond its letter.

## Metrics

```
Spec Adherence % = ((IMPLEMENTED + MODIFIED + PARTIAL*0.5) / (Total − UNSPECIFIED)) * 100
                 = ((51 + 0 + 3*0.5) / (54 − 0)) * 100
                 = (52.5 / 54) * 100
                 = 97.2%   → 97%

Completion rate  = 109 / 110 = 99%   (T101 = post-merge operator gate)
```

## Proposed Spec Changes *(report-only — NOT applied; see Human Gate)*

Three optional spec clarifications surfaced; none are blocking. **Default = NO**;
I will not edit `spec.md` without explicit `y`/`yes`.

| # | Target | Proposed change | Rationale |
|---|--------|-----------------|-----------|
| PSC-1 | FR-037 | Promote the **truncation-disclosure** behaviour into the requirement: when a defensive per-category cap is hit, the archive MUST disclose it (manifest `completeness.complete=false` + capped files, plus a localised README warning). | Implemented beyond spec (positive deviation); codifying it prevents a future regression silently re-introducing a "complete-looking" partial export. |
| PSC-2 | FR-015 | Document the known edge: a `actorKind=member` filter classifies a member-linked audit actor; a **dual-role** user (staff account also linked as a member contact) is classified `member` for their staff actions. | Records the accepted limitation (rare, no data leak — redaction keys on `source`, not `actorKind`) so it is a decision, not a surprise. |
| PSC-3 | SC-002 / Scale-headroom assumption | Note the `member_timeline_v` **audit-branch** `COALESCE(member_id, related_member_id)` defeats the `audit_log_member_timeline_idx` expression index, so that branch scans via the tenant index at large-tenant scale; split into two partial indexes if a tenant approaches the ~20k revisit trigger. | EXPLAIN-observed; pre-existing view characteristic, out of the FR-016 sargability scope but worth recording against the existing 10x-growth revisit trigger. |

## Requirement coverage matrix

### Functional Requirements (41) — all IMPLEMENTED

| Group | FRs | Status | Evidence |
|-------|-----|--------|----------|
| US1 Dashboard | FR-001, 001a, 002, 003, 004, 005, 006, 007, 007a | ✅ Implemented | `src/app/(staff)/admin/page.tsx`, `compute-dashboard-snapshot`, `list-smart-insights`, `activity-feed-query`, SVG charts w/ a11y table; engagement = inverse F8 score |
| US2 Audit Viewer | FR-008, 009, 010, 011, 012, 013 | ✅ Implemented | `audit-query` + `audit-redaction` (role map), CSV export (audited), keyset; FR-008 p95<1s@50k EXPLAIN 20–28 ms (T098) |
| US3 Timeline | FR-014, 015, 016, 017, 018 | ✅ Implemented | `member_timeline_v` 6-source UNION, `timeline.<source>.<kind>` i18n keys, keyset; FR-016 sargability EXPLAIN-verified (0196/0197) |
| US4 Benefit Usage | FR-019, 020, 021, 022, 023 | ✅ Implemented | `compute-benefit-usage`, under-use ≥25pt warning, calendar-year scope |
| US5 Directory/E-Book | FR-024, 025, 025a, 026, 027, 028 | ✅ Implemented | `search-directory`, opt-in field toggles, sharp logo pipeline (EXIF strip), deterministic PDF E-Book, JSON export, field-level hiding |
| US6 GDPR Export | FR-029, 030, 031, 032, 032a | ✅ Implemented | `gdpr-archive-*` (README + manifest), admin-on-behalf, async job, archived-member exportable |
| Cross-cutting | FR-033, 034, 035, 036, 037 | ✅ Implemented | 2-layer tenant isolation (12/12 blocker), EN/TH/SV (3503×3 keys), WCAG 2.1 AA (axe e2e), `member_timeline_viewed` read-audit, hybrid sync/async export + no-silent-fail |

### Success Criteria (13)

| SC | Status | Note |
|----|--------|------|
| SC-001 usability (≥80% locate in ~10s) | ⚠️ Partial | Surface supports it; **moderated test is post-launch** (not code-verifiable) |
| SC-002 dashboard p95<1.5s @5k | ⚠️ Partial | Indexes EXPLAIN-verified + RUN_PERF gates committed; **full prod RUM @5k pending** (SweCham ≈131) |
| SC-003 audit lookup <30s | ✅ | Viewer + combinable filters; e2e round-trip |
| SC-004 filtered export <2min | ✅ | Sync CSV export, UTC+local |
| SC-005 100% multi-source timeline | ✅ | `timeline-multisource` integration (all 6 sources, chrono) |
| SC-006 benefit usage = manual reconcile | ✅ | `compute-benefit-usage` unit + integration |
| SC-007 directory zero-leakage | ✅ | `listPublishedInTx` SC-007 zero-leakage integration test |
| SC-008 GDPR export + manifest validates | ✅ | `gdpr-export` integration (manifest sha256 validates) |
| SC-009 cross-tenant zero | ✅ | **12/12 cross-tenant blocker** (Principle I) |
| SC-010 WCAG 2.1 AA + EN/TH/SV | ✅ | axe e2e + check:i18n 3503×3, check:strict-aria 0 |
| SC-011 role redaction (audit+timeline) | ✅ | per-role assertions; dashboard no-finance-redaction (aligned w/ FR-007) |
| SC-012 adoption KPI (≥50%/≥70%) | ⚠️ Partial | **Counters instrumented** (T037/T068); KPI itself is post-launch |
| SC-013 rollback trigger | ✅ | `FEATURE_F9_DASHBOARD` kill-switch, reversible in seconds |

## Architecture drift (vs plan.md)

**No material drift.** Implementation matched the planned Clean-Architecture module
layout (`src/modules/insights/{domain,application,infrastructure}` + presentation in
`(staff)/admin` & `(member)/portal`). Plan-faithful choices:

| Area | Plan | Actual | Drift? |
|------|------|--------|--------|
| Module boundary | new `insights` bounded context, public barrel | as planned (`insights-barrel` arch test) | No |
| Tenant isolation | RLS + `tenant_id` predicate (Principle I) | as planned + 2nd-wall predicates added at review | No (hardening) |
| Charts | SVG custom (zero-dep, a11y, budget) | SVG custom | No |
| Tables/migrations | 4 tables + view + indexes (0185–0194) | 4 tables + view; **+0195 (F3 address), +0196/0197 (perf indexes added at review)** | Minor additive — index refinement post-review, not a design change |
| Export delivery | hybrid sync/async + single-use HMAC proxy | as planned; consume made atomic at Round 1 | No (hardening) |

## Significant deviations

- **POSITIVE — GDPR truncation disclosure (FR-037+):** beyond "no silent fail",
  capped categories are now disclosed in the manifest + a localised README warning
  (over-fetch-by-one boundary so exactly-N reports complete). → PSC-1.
- **POSITIVE — audit-label localisation via fallback:** the viewer/feed resolver
  falls back to the timeline `audit.eventType` catalogue (≈99 localised labels)
  before humanising — TH/SV admins see localised labels with **zero new i18n keys**.
- **MINOR (clarification, not drift) — FR-007 manager finance visibility:** resolved
  in-spec (2026-05-25) that managers (read-only-on-finance) DO see revenue; no
  dashboard finance redaction. Implemented as clarified.
- **MINOR (accepted limitation) — FR-015 dual-role actorKind:** see PSC-2.

## Innovations & best practices (reuse candidates)

1. **`enable_seqscan=off` sargability proof** for expression indexes on small-data
   tenants — a repeatable technique to verify index usability before scale.
   *Constitution candidate:* add to the Perf & Observability gate as the standard
   index-verification method when prod data is below planner-cost thresholds.
2. **Adversarial Round-2 self-review** caught a *dead* round-1 fix (FR-016 µs bound
   truncated by `Date`). *Lesson:* a fix that adds precision at a producer must be
   traced end-to-end to the consumer; "the test pins the producer output" ≠ "the
   behaviour changed".
3. **`rootCause()` helper** centralising the `(x as {cause?}).cause` single-step
   unwrap (11 sites) — removes a brittle, duplicated cast. Reuse repo-wide.
4. **Over-fetch-by-one truncation flag** (`length > MAX`, not `>= MAX`) — correct
   boundary pattern for "is this list capped?" without a second COUNT query.

## Constitution compliance

| Principle | Status | Evidence |
|-----------|--------|----------|
| I Tenant Isolation (NON-NEG) | ✅ | 2-layer (RLS+FORCE + explicit predicate); 12/12 cross-tenant blocker; `runInTenant` tx threaded; super-admin n/a |
| II Test-First (NON-NEG) | ✅ | acceptance/integration/contract per story; 100% branch on security-critical paths; coverage gates |
| III Clean Architecture (NON-NEG) | ✅ | `insights` barrel + `no-restricted-imports`; domain framework-free |
| IV PCI DSS (NON-NEG) | ✅ n/a | F9 reads no cardholder data (revenue = settled-invoice projection); no Stripe surface |
| V i18n | ✅ | EN/TH/SV 3503×3; BE display-only |
| VI Inclusive UX | ✅ | WCAG 2.1 AA axe e2e; skeletons/empty/error states; reduced-motion |
| VII Perf & Observability | ✅ | snapshot cache + as-of; 12 metrics/6 SLOs; FR-016 indexes EXPLAIN-verified |
| VIII Reliability | ✅ | Result<T,E>; advisory locks (`insights:export:`); audit trail; idempotent jobs |
| IX Code Quality | ✅ | typecheck 0 / lint 0; 4 review passes; security review signed |
| X Simplicity | ✅ | zero new runtime deps for the timeline/index work; SVG over a chart lib |

**Violations: None.** Documented deviation: hosting (Singapore region) inherited from
F1's Complexity-Tracking escape clause — unchanged by F9.

## Unspecified implementations

None at the requirement level. The in-session cleanups (`rootCause` helper,
audit-label fallback, error-code harmonisation) are refactors/UX-polish within
existing requirements (FR-034/FR-035 + code quality), not new unscoped features.

## Task execution analysis

- **109/110 complete (99%).** Open: **T101** — cron-job.org coordinator config
  (snapshot-refresh */5 + process-export-jobs */5), a **post-merge operator gate**,
  not a code task. T104 (full cross-module CI) is a ship-day verification.
- **Added post-tasks (review-driven):** migrations 0196 (timeline index sargability
  + actor-kind classification) and 0197 (payments + contacts expression indexes) —
  authored during code-review remediation, applied to live Neon + integration-verified.
- **No dropped tasks.** TDD discipline held (acceptance tests authored before impl).

## Lessons learned & recommendations

| Priority | Lesson | Recommendation |
|----------|--------|----------------|
| HIGH | A producer-side fix (FR-016 µs cap) was dead because consumers re-truncated via `Date`. | When changing a value's precision/shape, add an **end-to-end** test that asserts the *consumer's observable behaviour*, not just the producer output. (Round-2 added the µs-boundary integration test.) |
| HIGH | A "payments is already text" assumption skipped a needed index (Round-2 #4). | Verify column types against the **migration/DB**, not the Drizzle schema, when reasoning about index sargability (schema-vs-DB drift exists). |
| MEDIUM | Two parallel i18n label namespaces (`audit.eventType` vs `admin.dashboard.activity.events`) diverged. | Consider consolidating audit-event label namespaces (the fallback bridges them today); track as tech-debt. |
| MEDIUM | `enable_seqscan=off` was the only way to prove indexes at SweCham scale. | Adopt it as the standard pre-scale index-verification step (innovation #1). |
| LOW | Audit-branch COALESCE defeats its expression index at large scale. | PSC-3 — split into 2 partial indexes at the ~20k revisit trigger. |

## File traceability (appendix, abridged)

- Domain: `src/modules/insights/domain/{dashboard-snapshot,benefit-usage,smart-insight,engagement-score,directory-listing,export-job,trend-window,insight-cycle-key}.ts`
- Application: `src/modules/insights/application/use-cases/*` (compute-dashboard-snapshot, audit-query, activity-feed-query, list-smart-insights, compute-benefit-usage, search-directory, generate-directory-export, request/process/download-export, set-directory-logo, dismiss-insight) + `audit-redaction.ts`, `gdpr-audit-subset.ts`
- Infrastructure: `repos/{drizzle-snapshot,drizzle-directory,drizzle-export-job,drizzle-insight-dismissal}-repo.ts`, `sources/*-adapter.ts`, `blob/`, `logo/` (sharp), `pdf/` (react-pdf), `gdpr-archive-*`
- Presentation: `src/app/(staff)/admin/{page,audit,directory}/**`, `src/app/(member)/portal/{benefits,timeline,profile/directory,account/data-export}/**`, `src/components/{dashboard,audit,directory,benefits,data-export}/**`
- Migrations: `0185–0194` (F9 core) + `0196/0197` (perf indexes)
- Cross-cutting: `src/lib/{audit-event-label,log-id,tenant-day-range,export-download-token,csv,cron-auth,timeline-*}.ts`

## Self-assessment checklist

| Item | Result |
|------|--------|
| Evidence completeness (deviations cite file/task/behaviour) | PASS |
| Coverage integrity (all FR/SC IDs accounted for) | PASS — 41 FR + 13 SC, none missing |
| Metrics sanity (formulas applied) | PASS — adherence 97.2%, completion 99% |
| Severity consistency | PASS |
| Constitution review (violations listed or None) | PASS — None |
| Human-Gate readiness (Proposed Spec Changes populated) | PASS — 3 PSCs, awaiting consent |
| Actionability (specific, prioritised, tied to findings) | PASS |

---
*Generated by `/speckit.retrospective.analyze`. Report-only — no `spec.md` change made.*
