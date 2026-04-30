# Critique Report: F7 — Email Broadcast (E-Blast) — Round 4 (Final)

**Date**: 2026-04-29 (Round 4, post-clarify-session-6 final convergence)
**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Round 1 report**: [critique-20260429-074517.md](./critique-20260429-074517.md)
**Round 2 report**: [critique-20260429-081224-round2.md](./critique-20260429-081224-round2.md)
**Round 3 report**: [critique-20260429-084621-round3.md](./critique-20260429-084621-round3.md)
**Verdict**: ✅ **PROCEED** (0 🎯 Must-Address; 5 💡 plan-narrative polish items; 0 🤔 Questions)

---

## Executive Summary

The spec has converged. **No blocking concerns.** All 4 critique rounds + 6 clarify sessions = 19 clarifications + 11 critique remediation edits = 30 design points finalised. Constitution Check is GREEN unchanged.

Round 4's scan found **5 narrative-drift polish items** in plan.md — typical for a feature that has accumulated changes across 6 clarify sessions + 3 critique remediation rounds. None block /speckit.tasks; all are corrigible during the natural plan.md updates that /speckit.tasks normally triggers (it reads from plan.md and may surface these gaps as task-generation noise).

The most material is **R4-NEW-1**: plan.md line 72 lists test coverage as "every FR-002 precondition `a`–`j`" but FR-002 now has preconditions `a-k` (Round 3 added `k`). This is one stale phrase — a single-character fix.

The plan is **tasks-ready** as it stands. Optionally applying the 5 polish edits will reduce noise in the eventual /speckit.tasks output.

---

## Round 1+2+3 fix verification ✅

| Source | Verification | Status |
|--------|--------------|--------|
| Round 1 — FR-020 stable idempotency-key | spec ✅ + plan ✅ + research ✅ | ✅ STILL CORRECT |
| Round 1 — `<img>` removed from FR-002a | spec ✅ + research ✅ + CLAUDE ✅ | ✅ STILL CORRECT |
| Round 2 — Tiptap Image extension disabled | research § 2 ✅ | ✅ STILL CORRECT |
| Round 2 — Stuck-`sending` reconciliation | plan § Reliability ✅ | ✅ STILL CORRECT |
| Round 2 — Sanitiser-strip-warn UX | spec FR-002a ✅ | ✅ STILL CORRECT |
| Round 3 — FR-002 precondition `k` | spec ✅ + audit catalogue +1 (37) ✅ | ✅ STILL CORRECT |
| Round 3 — Q15 banner trigger refinement | spec Q15 narrative ✅ + US3 AS6-9 ✅ | ✅ STILL CORRECT |
| Round 3 — Q14 clear-halt UI on F7 admin queue | spec Q14 narrative ✅ | ⚠ **NOT IN plan.md project-structure** (R4-NEW-3) |
| Round 3 — Plan alert #11 | plan § VII alerts ✅ | ✅ STILL CORRECT |
| Round 3 — US3 banner ASes 6-9 | spec ✅ | ✅ STILL CORRECT |
| Session 6 — Q18 SC-011 per-release invariant | spec SC-011 ✅ | ⚠ **JCC-test CI nightly job not in plan § Testing** (R4-NEW-5) |
| Session 6 — Q19 banner per-tenant confirmation | spec Q19 narrative ✅ (was already integrated in Round 3) | ✅ STILL CORRECT |
| Audit count | 37 across spec + data-model + plan + CLAUDE | ✅ CONSISTENT |
| Migration count | 0064–0071 across spec + data-model + plan + CLAUDE | ✅ CONSISTENT |
| F3 `members` 2 new columns | data-model ✅ + plan ✅ + CLAUDE ✅ | ✅ CONSISTENT |
| Clarifications | 19 in spec | ✅ |
| NEEDS CLARIFICATION markers | 0 | ✅ |

---

## NEW Findings (Round 4 — all 💡 polish, 0 🎯)

### Engineering Lens 💡

| ID | Severity | Finding | Suggestion |
|----|----------|---------|------------|
| R4-NEW-1 | 💡 | **Plan.md line 72 lists test coverage as "every FR-002 precondition `a`–`j`"** — but FR-002 now has preconditions `a–k` (Round 3 R3-NEW-1 added `k` for `broadcasts_halted_until_admin_review`). One stale character. /speckit.tasks may generate 10 precondition tests instead of 11, missing the new halt-flag check test. | Update plan.md line 72: `(every FR-002 precondition `a`–`k` + sanitiser invocation + reservation insert atomicity + rate-limit check + halt-flag check)`. Single character change. |
| R4-NEW-2 | 💡 | **Plan.md line 15 narrative says "12 clarifications resolved across 4 sessions"** but the project now has 19 clarifications across 6 sessions. The detail-by-Q listing is correct (mentions Q13/Q14/Q15/Q18 explicitly) but the lead-in count is stale. | Update plan.md line 15: "**Scope confirmed from spec** (19 clarifications resolved across 6 sessions + 3 critique-remediation rounds): ..." |
| R4-NEW-3 | 💡 | **Plan.md project structure does not enumerate the Q14 clear-halt UI component or the Q15 banner component.** Both are spec'd in their respective Clarifications narratives (Q14 says "F7 admin queue page top-of-page banner per halted member"; Q15 says "member portal banner") but plan.md `src/app/...` tree doesn't list them. /speckit.tasks may not generate the matching component tasks. | Add to plan.md § Project Structure: (a) `src/app/(staff)/admin/broadcasts/_components/halt-state-banner.tsx` (NEW — Q14/R3-NEW-3 clear-halt UI; lists halted members + Clear button per row + confirmation dialog), (b) `src/app/(staff)/admin/broadcasts/_components/clear-halt-dialog.tsx` (NEW — typed-phrase confirmation), (c) `src/app/(member)/portal/_components/marketing-acknowledgement-banner.tsx` (NEW — Q15/R3-NEW-2 GDPR Art. 7 banner; server-rendered, every-sign-in-until-acknowledged, per-tenant scope per Q19). |
| R4-NEW-4 | 💡 | **Plan.md project structure shows `src/modules/members/` as F3-existing-extends-barrel** — but session 5 + Round 3 added 2 new columns to F3 `members` schema (migrations 0070 + 0071). The schema-change is mentioned in data-model § 1.3a but the F3 module entry in plan.md § Project Structure doesn't say "EDITED — schema gains `broadcasts_halted_until_admin_review` + `broadcasts_acknowledged_at` columns". | Update plan.md § Project Structure F3 entry: add comment "EDITED — F3 schema gains `broadcasts_halted_until_admin_review` (migration 0070) + `broadcasts_acknowledged_at` (migration 0071) columns to support Q14 per-broadcast halt + Q15 GDPR acknowledgement banner. Cross-feature schema extension lands on F7's branch, same pattern as F4→F3 + F5→F4 barrel extensions." |
| R4-NEW-5 | 💡 | **Q18 introduced a new CI requirement** — "JCC-test tenant fixture CI nightly job that creates fresh test-tenant + provisions + dispatches + tears down in <5 minutes" — but plan.md § Testing has only the standard `tenant-isolation.test.ts`. The CI-nightly fixture is a NEW test artefact not yet listed. | Add to plan.md § Testing > Integration tests: `tests/integration/broadcasts/jcc-test-tenant-fixture.test.ts` (Q18/SC-011 — provisioning dry-run; CI nightly schedule; <5min runtime budget; verifies cross-tenant suppression isolation + zero F7 code change required for new tenant). Also add a CI workflow note to quickstart.md mentioning the nightly cadence. |

### Constitution Re-Check (Round 4)

| Principle | Status |
|-----------|--------|
| I. Data Privacy & Security | ✅ unchanged |
| II. Test-First Development | 🟡 R4-NEW-1 + R4-NEW-5 surface test-coverage narrative gaps but not principle violations (FR-002 itself lists precondition `k`, so a thoughtful task generator catches it) |
| III. Clean Architecture | ✅ unchanged |
| IV. Payment Security (PCI DSS) | N/A |
| V. Internationalization | ✅ |
| VI. Inclusive UX | 🟡 R4-NEW-3 surfaces missing component enumeration but not a principle violation |
| VII. Performance & Observability | ✅ |
| VIII. Reliability | ✅ |
| IX. Code Quality Standards | ✅ |
| X. Simplicity (YAGNI) | ✅ |

**Verdict**: ✅ GREEN. All 5 R4 findings are plan.md narrative drift, not principle issues.

---

## Findings Summary Table (Round 4)

| ID | Lens | Severity | Category | Finding | Suggestion |
|----|------|----------|----------|---------|------------|
| R4-NEW-1 | Engineering | 💡 | Test coverage | plan.md line 72 says "FR-002 precondition `a`–`j`" but FR-002 has `a-k` | Update to "`a`–`k` + halt-flag check" |
| R4-NEW-2 | Engineering | 💡 | Narrative drift | plan.md line 15 says "12 clarifications across 4 sessions" but actual is 19 across 6 sessions | Update to "19 clarifications resolved across 6 sessions + 3 critique-remediation rounds" |
| R4-NEW-3 | Engineering | 💡 | Project structure | Plan.md does not enumerate Q14 clear-halt UI + Q15 banner components | Add 3 new component entries under `_components/` |
| R4-NEW-4 | Engineering | 💡 | Project structure | Plan.md does not mark `src/modules/members/` schema as EDITED for migrations 0070+0071 | Add EDITED comment to F3 entry |
| R4-NEW-5 | Engineering | 💡 | Test coverage | Q18 JCC-test fixture CI nightly job not in plan.md § Testing | Add `tests/integration/broadcasts/jcc-test-tenant-fixture.test.ts` + CI workflow note in quickstart.md |

---

## Verdict

✅ **PROCEED**

**Reasoning**:
- All Round 1+2+3 fixes verified consistent ✅
- Session 6 clarifications (Q18+Q19) integrated correctly into spec ✅
- 0 Must-Address findings — all 5 Round 4 findings are plan.md narrative-drift polish
- Constitution Check GREEN unchanged
- Migration count, audit count, FR count, clarifications count all consistent across artefacts
- 0 NEEDS CLARIFICATION markers
- The plan is **tasks-ready as-is**; the 5 polish edits will reduce /speckit.tasks output noise but are not gating

The natural workflow at /speckit.tasks will consume plan.md + spec.md and surface any genuinely-blocking issues mechanically (it cross-checks FR-id mapping, test coverage, project structure consistency). The 5 R4 findings are exactly the kind /speckit.tasks would surface — either fix now or rely on /speckit.tasks to flag them in its output.

---

## Recommended remediation (all optional)

Five surgical edits, all to plan.md (no spec.md changes needed):

### Edit 1 (💡): plan.md line 72 — FR-002 precondition `k`

**Current**: `submit-broadcast.ts (every FR-002 precondition `a`–`j` + sanitiser invocation + reservation insert atomicity + rate-limit check)`

**Proposed**: `submit-broadcast.ts (every FR-002 precondition `a`–`k` + sanitiser invocation + reservation insert atomicity + rate-limit check + halt-flag check per Critique R3-NEW-1)`

### Edit 2 (💡): plan.md line 15 — clarifications count

**Current**: `**Scope confirmed from spec** (12 clarifications resolved across 4 sessions): 6 user stories ...`

**Proposed**: `**Scope confirmed from spec** (19 clarifications resolved across 6 sessions + 3 critique-remediation rounds — see audit-report-2026-04-29.md + 3 critique reports for full provenance): 6 user stories ...`

### Edit 3 (💡): plan.md § Project Structure — add 3 new component entries

Add under `src/app/(staff)/admin/broadcasts/_components/`:
```text
│   │   ├── halt-state-banner.tsx                    # NEW — Q14/R3-NEW-3 clear-halt UI; top-of-page list of halted members + per-row Clear button
│   │   ├── clear-halt-dialog.tsx                    # NEW — typed-phrase confirmation for Clear halt action
```

Add under `src/app/(member)/portal/_components/` (or similar — implementer's choice):
```text
│   │       ├── marketing-acknowledgement-banner.tsx # NEW — Q15/R3-NEW-2 GDPR Art. 7 banner; server-rendered; every-sign-in-until-acknowledged; per-tenant scope per Q19
```

### Edit 4 (💡): plan.md § Project Structure — F3 module schema-change comment

**Current**: `├── modules/members/                                    # F3 existing — F7 extends barrel`

**Proposed**: `├── modules/members/                                    # F3 existing — F7 EXTENDS barrel + EDITS schema (migrations 0070 + 0071 add 2 columns: broadcasts_halted_until_admin_review per Q14 + broadcasts_acknowledged_at per Q15)`

### Edit 5 (💡): plan.md § Testing — JCC-test fixture CI nightly job

Add under "Integration tests" section:

```
- **New JCC-test tenant fixture for SC-011** (Q18/R3-NEW-6 per-release multi-tenant readiness invariant): `tests/integration/broadcasts/jcc-test-tenant-fixture.test.ts` — CI nightly job that creates fresh test-tenant ("JCC-test"), seeds default segments via migration 0068, configures Resend test-mode account stub, submits + approves + dispatches a synthetic broadcast (single test recipient), verifies cross-tenant suppression isolation + tenant-scoped audit + tenant-scoped metrics, and tears down. Total runtime budget < 5 minutes. Failure = F7 ship blocker per SC-011 sub-criteria.
```

Also add to quickstart.md § 7 "Daily dev loop" or § new "CI / nightly":

```
pnpm test:integration:nightly        # runs the JCC-test tenant fixture (Q18/SC-011 multi-tenant readiness)
```

---

**Apply these changes?** (all / select / none)

Reply with:
- `all` — apply all 5 polish edits
- `1, 2` — apply only the 2 most impactful (test coverage + clarifications count) and defer the rest to /speckit.tasks
- `none` — proceed to `/speckit.tasks` with current artefacts; these gaps will surface naturally during task generation and can be addressed inline

After applying, **next gate is `/speckit.tasks`** — no further critique rounds expected. The spec + plan have fully converged.

---

## Final Convergence Summary

| Phase | Output |
|-------|--------|
| /speckit.specify (sessions 1) | Q1 + Q2 — spec.md baseline (493 lines) |
| /speckit.clarify × 4 (sessions 2-4) | Q3-Q12 — full design space exploration |
| /speckit.plan (initial) | plan + research + data-model + contracts × 3 + quickstart |
| Audit pass | Reconciled audit-event count 31→32 |
| Critique Round 1 + remediation | E2/X2 + E9/X3 — 2 fixes |
| Critique Round 2 + remediation | R2-NEW-1/2/3 — 3 fixes |
| /speckit.clarify session 5 | Q13-Q17 — 5 carry-over R1 Questions resolved |
| Critique Round 3 + remediation | R3-NEW-1 (🎯) + 4 polish — 5 fixes |
| /speckit.clarify session 6 | Q18-Q19 — 2 carry-over R3 Questions resolved |
| **Critique Round 4 (this — final)** | **0 🎯 + 5 💡 polish + ✅ PROCEED verdict** |

**Total**: 19 clarifications + 11 critique remediation edits = **30 design decisions finalised** before /speckit.tasks.

**Strategic Question status (final)**:
- ✅ Resolved (10 of 10): all Round 1 (5/8) + Round 3 (2/2) Questions answered
- 📋 Deferred to /speckit.tasks (3 of 8): E11 (pino redact verification), E15 (suppression EXPLAIN at scale), E23 (Tiptap pinning convention) — all verification-or-convention items that belong at the tasks-gate level, not spec level

The spec has fully converged. **/speckit.tasks is the appropriate next gate.**
