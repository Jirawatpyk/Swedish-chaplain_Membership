# Staff Review Report — F8 Phase 8 (US6 Manual Escalation Task Queue) — FINAL

**Reviewer**: Claude Code (Opus 4.7) — `/speckit-staff-review-run` orchestrating **5 specialised agents** in parallel
**Sub-agents engaged**: drizzle-migration-reviewer · senior-tester · chamber-os-architect · chamber-os-ux-architect · pdpa-gdpr-compliance-officer
**Date**: 2026-05-10
**Branch**: `011-renewal-reminders` · HEAD: `ef8bc90d` (Round 9 close: 12/12 findings)
**Phase 8 scope**: 8 commits (`38981048`..HEAD) · 69 files / +7159 / -130
**Prior reviews**: 9 `/speckit-review` rounds + 1 prior staff review (Phase 6)

**Verdict**: ⚠️ **APPROVED WITH CONDITIONS**

---

## Executive Summary

Final staff-engineer-level audit of F8 Phase 8 (US6 Manual Escalation Task Queue) before ship-dark behind `FEATURE_F8_RENEWALS=false`. After 9 `/speckit-review` rounds closing 100+ findings, this final pass cross-validates against Constitution v1.4.0 + PDPA/GDPR + WCAG 2.1 AA + ARIA APG patterns through 5 specialised agents.

**Overall assessment**: Phase 8 is structurally sound — tenant isolation is the strongest in the codebase (dual `payload->>'task_id'` + `payload::text LIKE` audit-leak probe per Constitution Principle I clause 4), atomic state↔audit invariants hold across all 4 use-cases, TOCTOU race correctly maps to 409 with `expect(emitInTxMock).not.toHaveBeenCalled()` order pin, and the `AssigneeFilter` discriminated union (R8 C3-1) makes typo-related runtime fall-through impossible at the type level.

**Pre-ship blockers found**: **2 🔴**
- **B1** Page metadata title doubles "SweCham" (1-line fix in `page.tsx:58`)
- **W1-elevated** `aria-live="polite"` on character counters fires per-keystroke (Constitution Principle VI WCAG noise)

**Should-fix before flipping flag**: **9 🟡** — 3 contract-test gaps (Constitution Principle III), 2 UX a11y issues, 1 retention assertion missing (PDPA §24), 1 OTel observability gap (Principle VII), 1 PII redaction defence-in-depth (REDACT_PATHS), 1 overdue-banner threshold mismatch (FR-045 vs UI).

**Suggestions**: 12 🟢 — Phase 9 carry-forward polish.

Constitution v1.4.0 NON-NEGOTIABLE Principles I/II/III all hold; Principle IV n/a; V (i18n 2241 keys × 3) PASS; VI (a11y) PASS with 2 warnings; VII (perf) DEVIATION (no OTel metrics for Phase 8); VIII (audit atomicity) PASS; IX (typecheck/lint clean) PASS; X (simplicity) PASS.

---

## Findings Table

| ID | Severity | File | Line | Description | Recommendation |
|----|----------|------|------|-------------|----------------|
| **B1** | 🔴 | `src/app/(staff)/admin/renewals/tasks/page.tsx` | 58 | Page metadata title doubles "SweCham" — `${t('title')} · SweCham` interpolated through layout template `'%s · SweCham Membership'` produces "Escalation tasks · SweCham · SweCham Membership" | Drop the suffix: `return { title: t('title'), description: t('subtitle') }` (mirrors tier-upgrades/page.tsx) |
| **W1** | 🟡 | `done-task-dialog.tsx` `skip-task-dialog.tsx` | 79, 122 | `aria-live="polite"` on chars-remaining counter fires per-keystroke — disruptive AT noise | Remove `aria-live`. The existing `aria-describedby` already wires the counter to the textarea for SR readouts on focus |
| **W2** | 🟡 | `tests/contract/renewals/` (missing) | — | 3 new task action routes (`done`, `skip`, `reassign`) have ZERO contract tests. F8 pattern requires one file per API endpoint per Constitution III + sibling `cancel`/`pipeline` precedents | Add 3 contract tests covering: kill-switch 503, no-session 401, manager 403 + `f8_role_violation_blocked` audit, invalid body 400, `task_not_found` 404, `task_not_open` 409, happy 200 |
| **W3** | 🟡 | `tests/contract/users/staff-active.test.ts` (missing) | — | New `GET /api/admin/users/staff-active` route has zero contract test (response shape, RBAC, empty-staff edge case) | Add contract test |
| **W4** | 🟡 | `_components/escalation-task-queue.tsx` + adapter | repo:567 + queue:132 | Overdue **banner count** uses `dueAt < NOW()` (any overdue); UI **highlight** uses `NOW() - 3d` — banner count > highlighted rows. Spec FR-045/AS4 says ">3 days" for both | Pass `overdueThresholdDays: 3` to `countMatching`, OR define `OVERDUE_BANNER_DAYS = 3` constant shared between repo + UI |
| **W5** | 🟡 | `src/lib/logger.ts` | REDACT_PATHS | `outcomeNote`/`skippedReason` (free-text PII up to 1000/500 chars) NOT in REDACT_PATHS. Currently never reach pino, but a future debug-log accident would leak. Inconsistent with F4 `payment_reference` precedent (defence-in-depth) | Add 8 lines to REDACT_PATHS: `outcomeNote`, `*.outcomeNote`, `outcome_note`, `*.outcome_note`, `skippedReason`, `*.skippedReason`, `skipped_reason`, `*.skipped_reason` |
| **W6** | 🟡 | `tests/integration/renewals/escalation-task-lifecycle.test.ts` | audits[0] | Lifecycle test reads `audits[0]?.payload` but never asserts `audits[0]?.retentionYears === 5`. F4 trigger covers 9 tax-doc events only — F8 escalation events rely on column DEFAULT 5 with no test-level pin | Add `expect(audits[0]?.retentionYears).toBe(5)` for each lifecycle event type |
| **W7** | 🟡 | `tests/e2e/manager-read-only.spec.ts` (missing) | — | E2E does not verify manager sees `manager_read_only_notice` banner + Done/Skip/Reassign buttons absent at `/admin/renewals/tasks` | Add E2E test signing in as manager + asserting (a) action buttons absent, (b) notice banner visible |
| **W8** | 🟡 | Test gap: AS1 member-detail link | spec.md AS1 | spec.md § US6 AS1 mandates "links to the member detail page" — E2E checks columns not the `<a href="/admin/members/{memberId}">` resolution | Add E2E assertion that member name cell is a working link |
| **W9** | 🟡 | `src/lib/metrics.ts` (missing F8) | — | Phase 8 introduces 3 new admin actions + queue endpoint with ZERO OTel metrics/spans. F5/F7 each have 18 metrics. Constitution Principle VII deviation | Add at minimum: `renewals.task_complete.count`, `renewals.task_skip.count`, `renewals.task_reassign.count` counters + `renewals.task_queue.list.duration` p95 SLO in `docs/observability.md` |
| **B-arch-1** | 🟡 | `_lib/log-unexpected-error.ts` | 39 | Application-layer 100% branch coverage threshold: the `e instanceof Error ? e : new Error(String(e))` non-Error path is never tested across 4 use-cases | Add `throw 'string'` or `throw 42` test in one `reverse-direction atomicity` case to cover the fallback |
| **W10** | 🟡 | `_components/year-in-cycle-pill.tsx` | 1 | Component uses `useTranslations` (client hook) but missing `'use client'` directive. Works today via parent's transitive boundary; future Phase 9 server-component caller will throw | Add `'use client';` first line |
| **W11** | 🟡 | `_components/status-tablist.tsx` | 125 | SF-A focused-but-not-selected ring `ring-primary/40` ≈ 1.43:1 contrast on light bg (below WCAG SC 1.4.11 ≥3:1 for non-text). Primary focus-visible ring is still WCAG-compliant; ring/40 is supplemental | Bump to `ring-primary/60` (min) or `ring-primary/70` (recommended) |
| **W12** | 🟡 | `0122_f8_phase8_escalation_year_in_cycle.sql` | 24, 27 | Migration lacks `IF NOT EXISTS` guard on ADD COLUMN + `DO $$ ... constraint` block. Drizzle journal protects normal runs; partial-failure retry on Neon would error | Add idempotent guards. Already-applied migrations don't need backfill |
| **S1** | 🟢 | `_components/escalation-task-queue.tsx` | 563 | Table lacks `<TableCaption className="sr-only">` for richer AT context | Add caption + i18n key |
| **S2** | 🟢 | `done-task-dialog.tsx` | 63 | No explicit `autoFocus` on outcome textarea — relies on base-ui DOM-order focus | Add `autoFocus` for resilience |
| **S3** | 🟢 | `_components/escalation-task-queue.tsx` | 402 | Manager read-only `<div>` has no semantic landmark | Consider `role="note"` |
| **S4** | 🟢 | `route.ts` (api admin renewals tasks) | 129-136 | `task_type` filter post-pagination — `next_cursor` returned even when filtered page is empty (incorrect cursor flow under task_type filter) | Document in plan.md § Complexity Tracking OR push filter to repo |
| **S5** | 🟢 | `domain/renewal-escalation-task.ts` | — | `yearInCycle` not in domain entity; only in `EscalationTaskWithMember` (port) and adapter row mapping. Future `findById` consumers can't access it | Either add to `RenewalEscalationTaskBase` OR document in plan.md as presentation-only field |
| **S6** | 🟢 | `route.ts` (staff-active) | 71-84 | 2 separate `listWithFilter` calls (admin then manager) merged in-memory — race on rapid creates between calls + 200-cap not documented | Combine into single query with `IN ('admin','manager')` |
| **S7** | 🟢 | `reassign-escalation-task.ts` | 22 | Use-case doesn't validate `toUserId` is same-tenant — defers to UI combobox. Documented but missing from plan.md § Complexity Tracking | Add Complexity Tracking entry |
| **S8** | 🟢 | `0122_year_in_cycle.sql` | — | No `statement-breakpoint` markers between ADD COLUMN + ADD CONSTRAINT (cosmetic — single-tx is correct here) | Add markers for convention parity with 0121 |
| **S9** | 🟢 | i18n | n/a | `triggerReason` is `z.string().min(1).max(100)` — controlled vocabulary in practice, but free-text at zod boundary | Constrain to `z.enum([...])` for privacy-by-design + match producer call sites |
| **S10** | 🟢 | `escalation-task-queue.tsx` | 132 | TaskActionDialog `wasOpenRef` mount-guard untested. Refactor risk — would silently double-fire | Add unit test: render `open=false` → mount → no fire; flip true→false → fires once |
| **S11** | 🟢 | `escalation-task-queue.tsx` | describeError | `WIRE_ERROR_CODES` map untested at unit level (transitively via E2E only) | Add unit test for known code → localised key + unknown → fallback |
| **S12** | 🟢 | `_task-action-dialog.tsx` | filename | Underscore-prefixed filename non-standard (Next.js underscore is for route segments; `_components/` already private) | Rename to `task-action-dialog.tsx` for sibling consistency |

---

## Spec Coverage Matrix (`specs/011-renewal-reminders/spec.md` § US6)

| FR / AS | Description | Status |
|---------|-------------|--------|
| FR-040 | Auto-upgrade NEVER auto-applied | ✅ PASS (Phase 7) |
| FR-041 | Tenant disable auto-upgrade | ✅ PASS (Phase 7) |
| FR-042 | No auto-downgrade in MVP | ✅ PASS (OOS documented) |
| FR-043 | `year_in_cycle` pill for multi-year cycles | ⚠️ PARTIAL — column + UI shipped (R9); 5 inline producers still default to 1 (Phase 9 carry-forward) |
| FR-044 | Done/Skip/Reassign + audit events | ✅ PASS — 4 use-cases, 4 routes, 4 events, migration 0121 |
| FR-045 | Overdue >3d highlight + banner | ⚠️ PARTIAL — banner threshold mismatch (W4) |
| FR-046 | List p95 < 500ms @ 5k members | ✅ PASS (SC-003 = 293ms) |
| FR-046a | Loading + empty-state | ✅ PASS — shimmer skeleton + split state copy |
| FR-052a | Manager read-only | ✅ PASS — 3-layer (zod literal + requireRenewalAdminContext + middleware); 4 manager-rejection unit tests; E2E missing (W7) |
| AS1 | Queue with member name + tier + expiry + member link | ⚠️ PARTIAL — link assertion missing in E2E (W8) |
| AS2 | Done → done state + outcome note + audit | ✅ PASS — integration + unit + E2E |
| AS3 | Reassign → updated assignment + audit + Mine filter | ✅ PASS (filter URL state); reassigned-user POV not tested |
| AS4 | Overdue >3d red highlight + banner | ⚠️ PARTIAL — threshold mismatch (W4); 3-day boundary not unit-tested |

**Independent Test (line 169d skip-requires-reason)**: ✅ PASS — covered by `skip-escalation-task.test.ts` zod gate + integration test + E2E dialog spec.

---

## Test Coverage Assessment

**Volumes:**
- Unit: 4 use-case suites (~50 tests/file) + 9 StatusTablist + 7 YearInCyclePill + 2 ReassignTaskDropdown smoke + 24 layout/helpers = **~250+ Phase 8 unit tests**
- Integration (live Neon SG): 6 (lifecycle 4 + idempotency 2)
- Cross-tenant: 4 lifecycle probes + 1 standalone create probe (Constitution Principle I clause 3+4)
- E2E: 7 (Playwright + axe-core wcag2a/2aa/21a/21aa)

**Gaps (numbered in Findings Table):**
- W2: 3 contract tests missing (Constitution III)
- W3: staff-active contract test missing
- B-arch-1: non-Error throw path uncovered in 4 outer catches
- W6: retention_years assertion missing
- W7-W8: E2E gaps for manager + member-link
- S10-S11: TaskActionDialog mount-guard + describeError unit tests

**Strengths:**
- Cross-tenant audit-leak dual-probe (R8 IMP-E `payload::text LIKE`) — strongest forensic-chain test pattern in codebase
- TOCTOU `emitInTxMock.not.toHaveBeenCalled()` order invariant pin
- StatusTablist 100% branch coverage on keyboard handler
- YearInCyclePill defensive 0/NaN/-1 + aria_label_no_company

---

## Constitution v1.4.0 Check (10 Principles)

| Principle | Status | Notes |
|-----------|--------|-------|
| I — Data Privacy & Security | ✅ PASS | All 4 routes use `requireRenewalAdminContext`+`runInTenant`; cross-tenant 4-probe matrix + dual audit-leak (R8 IMP-13/E); `users` LEFT JOIN documented as future MTA work |
| II — Test-First (TDD) | ✅ PASS | 4 use-cases ~50 assertions; 4 manager-rejection; 3 TOCTOU; 2 idempotency; 4 lifecycle; 4 cross-tenant probes; AS1-AS4 mapped |
| III — Clean Architecture | ⚠️ MINOR — W2/W3 contract gaps | Domain pure; Application uses ports only; Infrastructure-deep-imports allowed via eslint config; `auth-deps.ts` re-export pattern preserves boundary |
| IV — PCI DSS | ➖ N/A | No payment surface in F8 |
| V — i18n | ✅ PASS | 2241 keys × EN/TH/SV; R9 IMP-I TH yearInCycle naturalised; R7 HV-4 collapsed 18 dup keys |
| VI — Inclusive UX | ⚠️ MINOR — W1 + W11 | APG tablist with manual activation + roving tabIndex; axe wcag2a/2aa/21a/21aa scan; reduced-motion DOM assertion; W1 char-counter aria-live noise; W11 SF-A ring contrast |
| VII — Perf & Observability | ⚠️ DEVIATION — W9 | SC-003 pipeline SLO covers underlying repo (293ms p95). NO OTel metrics/spans for Phase 8 admin actions; no SLO budget for queue list endpoint |
| VIII — Reliability | ✅ PASS | Reverse-direction atomicity in 4 use-cases (inner `logger.warn` + rethrow → outer rollback); TOCTOU `WHERE status='open'` + `EscalationTaskNotFoundError`→409 pattern |
| IX — Code Quality | ✅ PASS | typecheck + lint clean (0 errors, 0 warnings); 9 review rounds with 0 outstanding ship-blockers as of HEAD; coverage thresholds nominal (W6 retention test gap minor) |
| X — Simplicity | ✅ PASS | `AssigneeFilter` DU replaces magic-string sentinel; helper extraction (HV-1 dialog shell, S-3 logUnexpectedError); no new npm deps |

---

## PDPA / GDPR Compliance Audit

**Lawful basis**: GDPR Art. 6(1)(b) contract performance + PDPA §19(3) — documented in plan.md.

**Cross-border (PDPA §28 + GDPR SCCs)**: Vercel `sin1` + Neon `ap-southeast-1` — covered by F1 baseline; no new processors introduced.

**PII handling verified clean (no blockers found)**:
- `outcomeNote`/`skippedReason` never reach pino logs (verified across all 4 inner audit-emit catches + outer `logUnexpectedError`)
- `audit_log.payload` PII (forensic trail) is intentional per Constitution Principle VIII + Art. 17(3)(b) legal obligation
- Cross-tenant audit-leak: zero rows verified by dual `payload->>'task_id'` + `payload::text LIKE` probes

**Retention**: 5 years (correct for member-data norm; no F4 tax-doc 10y overlap). W6 flags missing test-level pin.

**Data Subject Rights (Art. 15/17/20/21)**:
- Access (Art. 15): Audit entries scoped by tenant_id; member DSR requires admin query (no auto-export endpoint — pre-F9 gap)
- Erasure (Art. 17): `renewal_escalation_tasks` cascade-deletes via FK; `audit_log` retained per Art. 17(3)(b) legal obligation
- Portability (Art. 20): pre-F9 gap (not Phase 8 introduced)
- Objection (Art. 21): N/A (basis is contract, not consent/legitimate interest)

---

## Migration Audit (0121 + 0122)

**0121 (audit enum)**: ✅ APPROVED — `ADD VALUE IF NOT EXISTS` idempotent; `_journal.json` monotonic; emit sites verified at `skip-escalation-task.ts:104` + `reassign-escalation-task.ts:108`.

**0122 (year_in_cycle)**: ⚠️ APPROVED with W12 — `ADD COLUMN ... DEFAULT 1` is metadata-only on Postgres 11+ (no rewrite, no lock); CHECK [1, 50] sane upper bound; schema↔migration parity verified. Lacks `IF NOT EXISTS` guard on partial-retry path (W12).

**Tenant isolation**: `renewal_escalation_tasks` has `ENABLE/FORCE ROW LEVEL SECURITY` (migration 0092); ALTER TABLE ADD COLUMN does NOT displace policy in Postgres — verified clean.

---

## Recommended Actions (Prioritised)

### 🔴 Stop-the-line (must fix before flag-flip)

1. **B1**: 1-line fix in `page.tsx:58` — drop the `· SweCham` suffix
2. **W1**: Remove `aria-live="polite"` from chars-remaining counters in done + skip dialogs (2 files, 1 attribute each)

### 🟡 Should-fix before production

3. **W2**: Add 3 contract tests for done/skip/reassign routes (Constitution Principle III mandate)
4. **W3**: Add contract test for `/api/admin/users/staff-active`
5. **W4**: Align overdue banner threshold (`countMatching`) with UI highlight (3-day) per FR-045/AS4
6. **W5**: Add 8 entries to `REDACT_PATHS` in `src/lib/logger.ts` for `outcomeNote`/`skippedReason` defence-in-depth
7. **W6**: Add `retention_years === 5` assertion to lifecycle integration tests
8. **W7**: Add E2E manager read-only test at `/admin/renewals/tasks`
9. **W8**: Add E2E assertion for AS1 member-detail link
10. **W9**: Add minimum 4 OTel counters + 1 SLO budget entry in `docs/observability.md` for Phase 8 surfaces
11. **W10**: Add `'use client';` to `year-in-cycle-pill.tsx`
12. **W11**: Bump SF-A focus ring to `ring-primary/60` for WCAG SC 1.4.11 contrast
13. **W12**: Document migration 0122 `IF NOT EXISTS` guard pattern (or accept current-state since already applied)
14. **B-arch-1**: Add non-Error thrown path test for `logUnexpectedError`

### 🟢 Suggestions (Phase 9 carry-forward)

S1–S12: documented in Findings Table — table caption, autofocus, role="note", task_type filter pagination, domain entity yearInCycle, staff-active query merge, reassign tenant-scope plan.md entry, statement-breakpoint markers, triggerReason enum, mount-guard test, describeError test, filename rename.

---

## Verdict & Conditions

⚠️ **APPROVED WITH CONDITIONS**

Phase 8 is structurally ship-ready. The Round 1-9 review cycle has driven the implementation to a strong baseline: tenant isolation is thorough, atomic state↔audit invariants hold, ARIA APG patterns are correctly applied, and the i18n consolidation is byte-clean. **Zero existing ship-blockers from Round 9** at HEAD; this final staff review found 2 NEW critical-tier items (B1 page-title typo + W1 aria-live counter noise) that emerged from cross-cutting audit perspectives the per-round agents didn't probe.

**Conditions for ship-flag-flip (`FEATURE_F8_RENEWALS=true`)**:

1. **Required**: B1 (1-line `page.tsx`) + W1 (2 files, drop `aria-live`) — these are user-visible bugs, not deferrable
2. **Required**: W5 REDACT_PATHS defence-in-depth (8 lines in `src/lib/logger.ts` + 1 redaction test)
3. **Required**: W2/W3 contract tests for 4 new routes (Constitution Principle III blocker for ship per Gate 9)
4. **Required**: W6 retention_years assertion (PDPA §24 compliance test pin)
5. **Required**: W4 banner threshold alignment OR `plan.md` Complexity Tracking entry documenting the deviation
6. **Required**: W9 minimum OTel counters (Constitution Principle VII deviation — at least document in plan.md)
7. **Recommended (not strict-blocker)**: W7/W8/W10/W11/W12 — UX a11y polish + migration retry-safety

After conditions 1-6 closed: re-run `/speckit-review` for spot-check verification, then `/speckit-ship`.

**Ship-Day Manual SR (per CLAUDE.md F7 precedent)**:
- 4 surfaces: queue page, 3 dialogs, retry button, command palette nav entries
- WCAG 2.1 AA + WCAG 2.2 SC 2.4.11/2.5.8 axe-core full-page scan
- 3 locales (EN/TH/SV) tone + register check

**Phase 9 carry-forward** (12 SUG items + Phase 9-deferred):
- SF-2 bulk action bar (T277e)
- Year_in_cycle wiring for 5 inline producers (FR-043 partial)
- F8 OTel metrics suite + SLO budgets
- F8 audit DSR export endpoint
- Round-tag squash (HV-2 deferred to genuinely-final ship commit)

---

## Metrics

- **Total findings**: 27 (2 🔴 + 13 🟡 + 12 🟢)
- **Files reviewed**: 69 (across 8 commits)
- **Spec coverage**: 9/12 PASS · 3/12 PARTIAL · 0/12 FAIL
- **Constitution principles**: 7/10 PASS · 3/10 MINOR · 0/10 FAIL · 1/10 N/A
- **PDPA/GDPR**: APPROVE WITH CONDITIONS (W5 REDACT_PATHS defence-in-depth)
- **Test count**: ~250+ unit/contract + 6 integration + 4 cross-tenant + 7 E2E

---

**Next step**: Address 🔴 + required 🟡 conditions, then `/speckit-fixit-run แก้ไขทั้งหมด` (Round 10 close), then `/speckit-ship`.
