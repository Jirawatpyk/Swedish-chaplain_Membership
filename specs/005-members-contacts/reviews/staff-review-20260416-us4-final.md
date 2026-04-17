# Staff-Engineer Review Round 6 (Final Gate) — F3 US4 (Inline Edit + Bulk Actions)

**Branch**: `005-members-contacts`
**Date**: 2026-04-16
**Scope**: Full review of 6 US4 commits (`12885d8`..`75ce881`), 47 files
**Reviewer**: Claude Opus 4.6 (3-agent parallel + triage)
**Prior rounds**: 5 (13 blockers found and resolved, latest = SB-1 TOCTOU fix)

---

## Executive Summary

**Verdict: ⚠️ APPROVED WITH CONDITIONS**

Round 6 found **0 blockers**, **4 warnings** (1 policy question, 2 perf polish, 1 spec tracking),
and **6 suggestions**. The critical TOCTOU fix (SB-1) from round 5 is verified correct. All prior
blockers remain resolved. The codebase is ship-ready pending the 4 conditions below.

---

## Agent Triage — False Positive Analysis

Several findings from the 3-agent parallel review were **downgraded or dismissed** after manual
verification:

| Agent Finding | Original | After Triage | Reason |
|---|---|---|---|
| P4-ARCH-1/2 | 🔴 Blocker | ❌ Dismissed | `src/components/**` IS the Presentation layer — Next.js framework imports (useRouter, Link) are expected here per the planned source layout. Constitution Principle III restricts Domain + Application only. |
| F1 (dead mocks) | 🔴 Blocker | ❌ Dismissed | `requireAdminContextMock` and `rateLimitCheckMock` ARE used — the contract test imports and calls the POST route handler directly. Mocks are active. |
| F7 (no positive path) | 🔴 Blocker | ❌ Dismissed | Tests at lines 126-153 (no-op country/notes unchanged) DO exercise positive path through validation + no-op logic. |
| F11 (conflated test) | 🔴 Blocker | ❌ Dismissed | Test correctly asserts member_id presence AND numeric-index absence — this is the exact regression scenario it guards against. |
| F4 (duplicate-ids) | 🔴 Blocker | 🟢 Suggestion | Asserting `invalid_body` type IS sufficient — inspecting the specific zod issue message would couple the test to implementation detail. |
| SS-4 (archived inline) | 🔴 Blocker | 🟡 Warning | Policy question, not a bug — see W-1 below. |
| F9 (save-error test) | 🔴 Blocker | 🟡 Warning | Test file acknowledges jsdom/React-19 timing limitation; still validates state preservation. |
| SE-5 (branded cast) | 🟡 Warning | 🟢 Suggestion | Standard adapter-layer pattern; brand is reconstructed by rowToMember(). |

---

## Findings

| ID | Severity | File | Description |
|---|---|---|---|
| **W-1** | 🟡 Warning | `inline-edit.ts:187,232` | **Policy question**: inline-edit allows country/notes changes on archived members, while bulk `change_plan` rejects them. If archived members should be fully immutable (except undelete), add an archived guard in the country + notes cases. If notes/country corrections on archived records are legitimate, current code is correct. **Decision needed from PO.** |
| **W-2** | 🟡 Warning | `members-table.tsx:466-608` | Columns array rebuilt on every render. TanStack Table v8 compares `columnDef` by reference — rebuilt columns trigger full table reconciliation. Wrap in `useMemo(columns, [enableSelection, onInlineEdit, t])`. Low severity with < 100 rows; matters at scale. |
| **W-3** | 🟡 Warning | `members-table.tsx:638-658` | Ctrl+A `useEffect` has `[enableSelection, table]` deps. `table` is a new object every render (from `useReactTable`), so the listener detaches/re-attaches per render. Cleanup is correct (no leak), but unnecessary work. Fix: extract handler to a stable ref, or remove `table` from deps and call `table.toggleAllPageRowsSelected` via a ref. |
| **W-4** | 🟡 Warning | `bulk-progress-indicator.tsx` | FR-041 deviation (indeterminate vs determinate) is documented in code comments but not tracked in an issue tracker or `plan.md § Complexity Tracking`. Should be added as a debt item so it doesn't get lost. |
| **S-1** | 🟢 Suggestion | `bulk-action.ts:194` | `throw new Error('lookup_failed')` after `logger.error` — consider preserving error code in the thrown error for more informative catch-block handling (currently all non-typed errors become generic `server_error`). |
| **S-2** | 🟢 Suggestion | `route.ts:56-77 (bulk)` | Pre-validation cap check (lines 56-77) duplicates zod's `.max(BULK_CAP)`. Intentional for early rejection before idempotency key parsing — add a one-line comment noting this is defense-in-depth, not redundancy. |
| **S-3** | 🟢 Suggestion | `route.ts:190 (bulk)` | `rememberIdempotentResponse` runs after `result.ok` check but before the NextResponse is returned. If it throws, client gets 200 but replay cache is broken. Wrap in try/catch with logger.warn for resilience. |
| **S-4** | 🟢 Suggestion | `inline-edit-cells.test.tsx:196-228` | R4-T1 save-error test validates input value preservation but doesn't trigger the actual save-error flow (Enter/blur). Acknowledged jsdom limitation — add a code comment citing the integration test that covers the behavioral proof. |
| **S-5** | 🟢 Suggestion | `members-bulk-constants.ts` | `BULK_CAP` is exported from both `bulk-action.ts:36` and `members-bulk-constants.ts:4`. Risk: value drift. Consider single source of truth — either only the use case exports it (Application), or only the constants module. |
| **S-6** | 🟢 Suggestion | `e2e/members-bulk-actions.spec.ts:55-59` | axe-core `.include()` covers `[data-slot="table"]` + `[role="toolbar"]` but inline-edit cells (country input, notes textarea) only render when the table is in edit mode. Consider adding a test that enters edit mode before the axe scan. |

---

## Spec Coverage Matrix

| FR | Description | Status | Notes |
|---|---|---|---|
| FR-018 | Inline-edit status/country/notes | ✅ | Optimistic update + rollback + savingRef + cancellingRef |
| FR-019 | All-or-nothing bulk txn | ✅ | `runInTenant` + `findManyByIdsInTx` FOR UPDATE |
| FR-019a | 100-row cap (UI + server) | ✅ | Dual layer: zod `.max(100)` + route pre-check |
| FR-019b | Rate limit 10/10min + audit | ✅ | Upstash token bucket at route layer |
| FR-040 | Sticky bar + keyboard shortcuts | ✅ | Shift+Click, Ctrl+A, Space, "Select all N matching" |
| FR-041 | Progress indicator | ⚠️ W-4 | Indeterminate + elapsed-time (deviation documented in code, not plan.md) |

---

## Test Coverage Assessment

| Category | Tests | Status |
|---|---|---|
| Contract: bulk endpoint | 6 | ✅ All HTTP codes covered |
| Contract: inline-edit endpoint | 9 | ✅ |
| Integration: bulk cap | 7 | ✅ |
| Integration: bulk rate limit | 3 | ✅ |
| Integration: bulk branches + SW-2 + SW-5 | 8 | ✅ |
| Integration: TOCTOU row lock | 2 | ✅ Live-Neon concurrent archive serialization |
| Integration: inline-edit use case | 13 | ✅ |
| Integration: updateStatusInTx live | 5 | ✅ |
| Unit: inline-edit cells | 11 | ✅ (jsdom caveat on blur) |
| Unit: table selection | 5 | ✅ |
| Unit: member-form notes | 5+ | ✅ |
| E2E: bulk actions + axe + i18n | 7 | ✅ |
| **Total US4 tests** | **81** | |

**Gaps** (non-blocking):
- No explicit positive test that country/notes inline-edit on an active member saves correctly
  through the full flow (covered implicitly by integration tests with stubbed deps)
- E2E axe scan doesn't cover inline-edit cells in edit mode (S-6)

---

## Metrics

| Category | Value |
|---|---|
| US4 commits | 6 |
| US4 files touched | 47 |
| US4 lines added | +5,798 |
| Total review rounds | 6 |
| Total blockers found (all rounds) | 14 |
| Total blockers resolved | 14 |
| Remaining blockers | **0** |
| Warnings | 4 |
| Suggestions | 6 |
| Unit+contract tests | 837/837 green |
| Integration tests (US4) | 40/40 green |
| i18n keys | 611 × 3 |
| Typecheck | Clean |
| Lint | Clean |

---

## Conditions for Ship

1. **W-1**: Get PO decision on archived-member inline-edit policy. If immutable → add guard; if
   corrections allowed → document as intended.
2. **W-2 + W-3**: `useMemo(columns)` + stable Ctrl+A effect deps — perf polish before F3 ships
   to production.
3. **W-4**: Add FR-041 indeterminate-progress deviation to `plan.md § Complexity Tracking` with
   rationale (SSE incompatible with all-or-nothing semantics).

---

## Verdict

⚠️ **APPROVED WITH CONDITIONS**

0 blockers. 4 warnings are policy/polish items — none affect data integrity, security, or audit
correctness. The TOCTOU fix (SB-1) is verified solid with live-Neon concurrency proof. US4 is
production-ready once the 3 conditions above are resolved.

**Next step**: Address conditions → run `/speckit.ship` to prepare the release.
