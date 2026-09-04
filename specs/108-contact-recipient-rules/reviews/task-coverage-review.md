# Task Coverage Review — 108 Contact Recipient Rules

**Run**: 2026-09-04 · `/speckit.superb.review` (post-`/speckit.tasks`) · reviewer: maintainer AI session
**Inputs**: spec.md (FR-001…FR-056, SC-001…SC-011, US1–US6, 13 edge cases), plan.md, tasks.md (T001–T100 at review start), data-model.md, contracts/ (3)

## 1. Requirements extracted

The spec already carries a stable ID scheme (FR-xxx / SC-xxx / USn-sN / edge cases). Requirement rows below reuse those IDs instead of inventing R-numbers. Classification: T = TESTABLE, O = OBSERVABLE, S = STRUCTURAL.

## 2. Coverage matrix

| Req | Requirement (short) | Type | Tasks | Coverage |
| --- | --- | --- | --- | --- |
| FR-001 | Money emails → live primary at queue time (incl. refund CN, replays) | T | T008–T011, T019–T022 | ✓ |
| FR-001a | Non-member buyer keeps the document email | T | T012, T019 | ✓ |
| FR-001b | Bounced/invalid primary: no redirect | T | — → **T101** | ✗ → fixed |
| FR-002 | Buyer identity frozen | T | T008 (assertion added), T027 | ✓ |
| FR-003 | No recipient: audit event, same tx, banners, resend remedy | T/O | T009, T015, T016, T019, T025 | ✓ |
| FR-004 | Processor gets primary email | T | T013, T026 | ✓ |
| FR-005 | Portal resend body no address | T | T014, T024 | ✓ |
| FR-006 | Override removed | S/T | T011, T022 | ✓ |
| FR-007 | Exactly one recipient, no cc/bcc | T | T008 (assertion added) | ~ → fixed |
| FR-008 | F8 live regression guard | T | — → **T102** | ✗ → fixed |
| FR-009 | Removed contacts ignored in lookups | T | T017, T023 | ✓ |
| FR-010 | Exactly one primary; races refused | T | T030, T031, T034–T037 | ✓ |
| FR-010a | DB guard + pre-check + V1 | T/O | T005, T031, T034 | ✓ |
| FR-011 | Remove primary refused | T | T030, T035, T037 | ✓ |
| FR-012 | Invariant on add/promote/remove/unarchive | T | T032, T037, T038 | ✓ |
| FR-013 | Erased excluded everywhere | T | T031, T068 (erased case added) | ~ → fixed |
| FR-014 | Unarchive designates primary; removed/concurrent refused | T | T032, T033, T038, T039 | ✓ |
| FR-020 | 1:N fan-out | T | T067, T068, T074–T076 | ✓ |
| FR-021 | Active only | T | T068, T071, T074 | ✓ |
| FR-022 | Exclusions incl. all sender contacts | T | T067, T068, T076 | ✓ |
| FR-022a | Opt-out on custom/attendee, drop + count | T | T068, T069, T070, T077 | ✓ |
| FR-022b | Self-exclusion hint | O | T079, T084 | ✓ |
| FR-023 | Dedupe | T | T067 (existing cases retained) | ✓ |
| FR-024 | Unsubscribe attribution | T | T068, T069, T073, T078 | ✓ |
| FR-025 | Suppression wins; staff cannot re-enable | T | T043, T044, T053 | ✓ |
| FR-026 | Custom/attendee rules unchanged | T | T068 re-pin + existing suites | ✓ |
| FR-027 | Opt-out default, no backfill | T | T045, T048 | ✓ |
| FR-027a | Pre-flight review surface + record | O | T058, T093 | ✓ |
| FR-028 | Reply-to unchanged | S | existing tests (no change) | ✓ |
| FR-029 | Orphan = zero eligible contacts | T | T067, T076 | ✓ |
| FR-030 | New right; toggle; audit | T | T042, T043, T052, T053, T055 | ✓ |
| FR-030a | Catalogue/pins/denials | T | T042, T046, T052, T060 | ✓ |
| FR-030b | 60/min rate limit | T | T043, T055, T063 | ✓ |
| FR-030c | No confirm; Undo toast | O | T056, T047 | ✓ |
| FR-031 | Primary badge + descriptor; states | O | T057 | ✓ |
| FR-031a | Status unavailable tri-state | T/O | T057, T058 | ✓ |
| FR-031b | Shared reason vocabulary | S/O | — → **T103** | ✗ → fixed |
| FR-032 | Portal own contact only; others hidden | T | T061, T063, T064 | ✓ |
| FR-033 | No money-off control; primary may opt out | T | T062 | ✓ |
| FR-034 | Read-only for others | T/O | T047, T058 | ✓ |
| FR-035 | Audience page (columns, filters, defaults, 50/page) | T/O | T045, T054, T058, T059 | ✓ |
| FR-035a | No PII beyond allow-list; no download | S | T058 (allow-list added) | ~ → fixed |
| FR-035b | Empty + loading states | O | T058 | ✓ |
| FR-035c | 320 px card layout | O | T047, T058 | ✓ |
| FR-040 | Count refresh + announce | O/T | T084, T088, T089 | ✓ |
| FR-040a | Numbers only | T | T082 | ✓ |
| FR-040b | Count unavailable; submit allowed | T/O | T082, T084, T089 | ✓ |
| FR-041 | No truncation; page failure aborts | T | T067, T074, T075, T081 | ✓ |
| FR-042 | Single ceiling | T | T083, T085 | ✓ |
| FR-043 | 20k within budget | T | T081 | ✓ |
| FR-044 | Resumable build; stuck 30 min; working set deleted + erasure | T | T081, T083, T086, T087, **T106** | ✓ (split) |
| FR-045 | Rollback + incident | S | T091, quickstart rollback matrix | ✓ |
| FR-050 | i18n EN/TH/SV | S/T | every UI task + `check:i18n` in T028/T041/T060/T092 | ✓ |
| FR-051 | WCAG 2.1 AA | T | T040, T047, T062, T084 (axe) | ✓ |
| FR-052 | Tenant-scoped + cross-tenant test | T | T043, T045, T071 (added) | ~ → fixed |
| FR-053 | 3 audit events + labels + gates | T | T015, T016, T049, T050, T078 | ✓ |
| FR-053a | No email in payload/log/toast | T | T044, T082, T090 | ✓ |
| FR-054 | Inventory test + gate | T | T008, T027 | ✓ |
| FR-055 | ROPA + LIA | S | T096 | ✓ |
| FR-056 | Erasure classification; suppression contact ref nulled | T | T051, — → **T104** | ~ → fixed |
| SC-001 | 0 money emails to non-primary | T | T008, T102 | ✓ |
| SC-002 | 0 violations under 100 races | T | T030 | ✓ |
| SC-003 | 100% eligible receive once | T | T068 | ✓ |
| SC-004 | Count = dispatched at 100/5k/20k; < 3 s | T | T081 | ✓ |
| SC-005 | Read state w/o dialog; ≤ 2 interactions | O | T047 | ✓ |
| SC-006 | Secondary unsubscribes honoured + attributed | T | T068 | ✓ |
| SC-007 | Secondary pays/resends: 0 emails, 0 addresses | T | T008, T014 | ✓ |
| SC-008 | No regression; gates green | T | T028, T041, T060, T092, T100 | ✓ |
| SC-009 | Inactive/archived contacts get 0 | T | T068 | ✓ |
| SC-010 | Pre-flight on one screen | O | T047 (preset), T093 | ✓ |
| SC-011 | Audience page count = compose count | T | — → **T105** | ✗ → fixed |
| US1-s1…s7 | acceptance scenarios | T | T008–T014 (+ T101) | ✓ |
| US2-s1…s5 | acceptance scenarios | T | T030–T033 | ✓ |
| US3-s1…s10 | acceptance scenarios | T | T067–T071 (s6 tier + erased added to T068) | ✓ |
| US4-s1…s9 | acceptance scenarios | T | T042–T047 | ✓ |
| US5-s1…s4 | acceptance scenarios | T | T081–T084 | ✓ |
| US6-s1…s4 | acceptance scenarios | T | T061, T062 | ✓ |
| Edge: queued-then-changed | accepted, documented | S | — (no task by design) | ✓ |
| Edge: no contacts at all | orphan signal | T | T067 | ✓ |
| Edge: unsubscribed re-added | stays suppressed | T | T068 (case added) | ~ → fixed |
| Edge: card payments | no email shared | T | T013 | ✓ |
| Edge: admin resend shows address | unchanged | T | T014 | ✓ |
| Edge: dormant override | removed | T | T011, T022 | ✓ |
| Edge: halted sender excluded | unchanged | T | T068 | ✓ |

## 3. Coverage gaps (before fixes)

| Gap | Requirement | Fix applied |
| --- | --- | --- |
| G1 | FR-001b bounced primary no redirect had no test | **T101** added (US1 tests) |
| G2 | FR-008 F8 regression guard had no task | **T102** added (US1 tests) |
| G3 | FR-031b shared reason vocabulary had no task | **T103** added (US4 implementation) |
| G4 | FR-056 suppression `contact_id` on erasure had no task | **T104** added (US3 tests/impl) |
| G5 | SC-011 audience-page vs compose-count parity had no test | **T105** added (US3 tests) |
| P1–P6 | FR-007, FR-013, FR-035a, FR-052, edge re-added, US3-s6 were partial | T008, T068, T058, T071 descriptions extended |

## 4. Task quality and TDD readiness

| Task | Issue | Action |
| --- | --- | --- |
| T087 | Overly broad (snapshot + push + resume + send + reconcile) | Split: reconcile-stuck moved to **T106** |
| T018 | Broad mechanical sweep (47 files) | Kept; it is one behaviour (port widening) and typecheck drives it |
| T076 | Resolver rewrite + 4 callers | Kept; callers change only their input shape; T067 is the driving test |
| all | No per-task `git commit` line | Header now states the RED/GREEN commit convention |

TDD readiness: every story phase opens with concrete, file-named test tasks that must fail first; foundational tasks are verifications and one test double (no speculative production code); each broad implementation task has at least one driving test. **READY.**

## 5. Summary

- Requirements extracted: 91 (56 FR, 11 SC, 39 scenarios folded into 6 rows, 13 edge cases folded into 7 rows)
- Fully covered after fixes: 91 (100%)
- Partially covered before fixes: 6 → 0
- Gaps before fixes: 5 → 0
- Task quality issues: 1 (T087, fixed by split) + 1 convention note
- Task count: 100 → **106** at this review; `/speckit.analyze` later added T107–T109 (spec-amendment split) → **109**

**Decision**: ✓ COVERAGE COMPLETE — tasks.md is ready for implementation. `/speckit.analyze` remains recommended for cross-artifact consistency (operations CHK023).
