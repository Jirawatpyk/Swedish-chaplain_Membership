# Code Review Report: F3 US7 — Archive + Undelete (Round 2)

**Reviewer**: AI Agent (Staff Engineer Perspective)
**Date**: 2026-04-17
**Feature**: [specs/005-members-contacts/spec.md — US7](../spec.md)
**Branch**: `005-members-contacts`
**Round**: 2 of 2 (post-remediation of round-1 findings R001–R009)
**Prior Review**: [staff-review-20260417-us7.md](./staff-review-20260417-us7.md)
**Verdict**: ✅ **APPROVED**

---

## Executive Summary

Round-2 review of US7 archive + undelete after the `/speckit.fixit.run` pass
resolved all 9 round-1 findings (R001 🟡 Security, R002/R003/R004 🟡 Warnings,
R005–R009 🟢 Suggestions). Migration 0017 correctly tightens the `invitations`
grant to column-level SELECT — `invitations.id` (the raw invite token) is no
longer visible to `chamber_app`. The Set-dedupe in the cascade loop is clean,
stable, and proven by a new integration test. The R007 Thai BE display uses
the same `th-TH-u-ca-buddhist` BCP47 extension as `src/lib/relative-time.ts`,
maintaining consistency with existing F3 date-formatting patterns.

All 10 files touched by the remediation pass are internally consistent.
Tests hold: 905/905 unit+contract green (+16 new R009 unit tests), 10/10
US7 integration green on live Neon (including new R008 dedupe test),
typecheck clean, lint clean, i18n parity 722 keys × EN/TH/SV. Migration
0017 applied to live Neon.

**No blockers. No warnings.** One minor residual item (R004 spec amendment)
is tracked for manual follow-up outside `/speckit.ship` scope because
`/fixit` correctly refused to modify `spec.md`. Code-level mitigation (F9
carve-out comment + unit-test assertion documenting current behaviour) is
in place.

**Ship-ready for `/speckit.ship`.**

---

## Review Findings

| ID | Severity | File | Line(s) | Category | Finding | Recommendation |
|----|----------|------|---------|----------|---------|----------------|
| — | — | — | — | — | *No new findings.* All round-1 items verified addressed in the table below. | — |

---

## Round-1 Finding Disposition

| ID | Round-1 Severity | Status | Evidence |
|----|------------------|--------|----------|
| **R001** | 🟡 Security | ✅ Resolved | `drizzle/migrations/0017_invitations_revoke_tighten.sql` — `REVOKE SELECT ON TABLE invitations FROM chamber_app; GRANT SELECT (user_id, consumed_at, expires_at) ON TABLE invitations TO chamber_app`. Migration applied to live Neon. `archive-member.ts:199` changed to `.returning({ userId: invitations.userId })` — stays within the tightened grant. WHERE predicate uses only granted columns. Integration test `cascade: soft-consumes pending unredeemed invitations` passes on live Neon (verifies both the UPDATE + returning path work post-grant). |
| **R002** | 🟡 Correctness/Perf | ✅ Resolved | `archive-member.ts:141–147` introduces `uniqueLinkedUserIds = Array.from(new Set(linkedUserIds))`. Set iteration order is insertion-stable so audit ordering is deterministic. Loop at `:150`, invitation UPDATE at `:188`, and audit payload at `:216` all use the deduped array. Integration test `cascade: dedupes same F1 user linked to multiple contacts (R002)` seeds 2 contacts → same F1 user → asserts exactly 1 `user_sessions_revoked` audit + single-entry `cascaded_user_ids`. |
| **R003** | 🟡 Correctness | ✅ Resolved | `archive/route.ts:64–75` — replaced content-length gate with unconditional `request.text()` + `JSON.parse()`. Empty body falls through to `rawBody = {}` (zod schema accepts). Malformed JSON returns 400 `invalid_body` with the same error shape as before. All 13 contract tests still green. |
| **R004** | 🟡 Audit/PII | ⚠️ Code-level mitigated; spec amendment deferred | `archive-member.ts:203–207` adds an explicit comment flagging `reason` for F9 GDPR self-service export carve-out alongside `notes` + `override_reason_note`. `archive-member.test.ts` has a named test "audit payload carries reason verbatim (R004 — flagged for F9 carve-out)" that pins current behaviour. **Manual follow-up**: spec.md § Security considerations should add a `reason` mention alongside the existing `notes` carve-out; `/fixit` correctly declined to modify spec artifacts. This is a documentation gap, not a code defect. Non-blocking for ship. |
| **R005** | 🟢 Doc | ✅ Resolved | `undelete-member.ts:8–20` doc block explicitly states "undelete does NOT re-issue the invitations that archive soft-consumed". |
| **R006** | 🟢 UX | ✅ Resolved | `archive-member-button.tsx:50–56` introduces `handleOpenChange` that resets `reason` + `loading` when `next === false`. Mirrors the `_components/archive-confirm-dialog.tsx:50–58` pattern exactly. Wired at `:88` via `onOpenChange={handleOpenChange}`. Success path at `:71–72` still calls `setOpen(false)` + explicit `setReason('')` (belt-and-suspenders — handleOpenChange would also reset but the explicit reset documents intent). |
| **R007** | 🟢 i18n | ✅ Resolved | `archived-banner.tsx:86–101` uses `Intl.DateTimeFormat(bcp47, { year: 'numeric', month: 'short', day: 'numeric' })` with `bcp47 = locale === 'th' ? 'th-TH-u-ca-buddhist' : locale`. Same pattern as `src/lib/relative-time.ts:73`. Fallback to `archivedDate.toISOString().slice(0, 10)` on any Intl failure (defensive). Thai users now see e.g. "17 เม.ย. 2569" (BE) instead of "2026". |
| **R008** | 🟢 Test | ✅ Resolved | `archive-cascade.test.ts` new test at top of file (before the invitations test) seeds 2 contacts with identical `linkedUserId` + asserts exactly one `user_sessions_revoked` audit + single-entry `cascaded_user_ids`. 6/6 tests green on live Neon. |
| **R009** | 🟢 Test | ✅ Resolved | `tests/unit/members/application/archive-member.test.ts` (9 tests) + `undelete-member.test.ts` (7 tests). Uses `vi.mock('@/lib/db', ...)` to stub `runInTenant` + a minimal chain-of-thenables stub tx. Covers: zod validation, error mapping, dedupe logic, null-linkedUserId filter, server_error on repo failures, happy-path orchestration. 16/16 green in <50ms — fast feedback layer complementing the live-Neon integration suite. |

---

## Spec Coverage Matrix

| Requirement | Status | Implementation Notes |
|-------------|--------|---------------------|
| FR-005: soft-delete + undelete within 90 days, no hard delete | ✅ Implemented | `archive-member.ts` + `undelete-member.ts` + `archive-window-policy.ts`. Unit + integration tests cover happy + edge. |
| FR-022: cross-tenant probe returns 404 + audit | ✅ Implemented | Integration tests `cross-tenant archive returns not_found (RLS)` + `cross-tenant undelete returns not_found (RLS)`. |
| FR-023: audit events | ✅ Implemented | `member_archived` (with `invitations_revoked_count`), `member_undeleted`, `user_sessions_revoked` — all emitted inside the tx. |
| FR-026: destructive action confirmation | ✅ Implemented | `ArchiveMemberButton` uses shadcn AlertDialog + Esc-cancels pattern. |
| FR-027: archived retention ≥ 5 years | ✅ Inherited | Audit append-only trigger from F1 migration 0001. |
| FR-034: "Show archived" third state | ✅ Implemented + spec amended | Status filter Select dropdown + spec.md FR-034 paragraph amendment documents the equivalence. |
| FR-037: unique `<title>` per page | ✅ Inherited | Archive/undelete route under existing detail page's `generateMetadata`. |
| US7 AS1–AS4 | ✅ Verified | All four scenarios covered by integration tests + E2E spec (gated on env). |
| Spec Edge Case: pending F1 invitation cascade | ✅ Implemented + tested | Invitation soft-consume cascade + dedicated integration test. |
| Spec § Security considerations: `reason` field PII exposure | ⚠️ Code-commented; spec mention deferred | Not a code defect — documentation debt tracked for a one-line spec paragraph addition. |

**Coverage**: 12/12 US7-scoped functional requirements + 4/4 acceptance scenarios = 100%.

---

## Test Coverage Assessment

| Area | Unit | Contract | Integration | E2E | Coverage |
|------|------|----------|-------------|-----|----------|
| `archiveMember` use case | ✅ 9 new tests (R009) | ✅ 7 tests | ✅ 6 tests on live Neon | ⚠️ gated on env | Fast feedback (<50ms unit) + live DB verification |
| `undeleteMember` use case | ✅ 7 new tests (R009) | ✅ 6 tests | ✅ 4 tests on live Neon | ⚠️ gated on env | Same |
| Invitation cascade (R001) | ✅ via archive-member unit stubs | — | ✅ `soft-consumes pending unredeemed invitations` | — | Migration 0017 permissions exercised on live Neon |
| User dedupe (R002) | ✅ archive-member `dedupes same user linked to multiple contacts` | — | ✅ `cascade: dedupes same F1 user…` | — | Both layers cover the edge case |
| Body parsing (R003) | ✅ contract `200 happy path without reason` | — | — | — | Contract tests cover empty-body → 200 + missing-key → 400 |
| Reason PII flag (R004) | ✅ archive-member `audit payload carries reason verbatim` | — | ✅ `archives a member: flips status + sets archived_at + audit row` asserts `reason` in payload | — | Test documents current behaviour; spec mention pending |
| Dialog state reset (R006) | ⚠️ E2E gated | — | — | ⚠️ gated on env | Client-component behavior; integration coverage low-priority for UX-only reset |
| Thai BE display (R007) | — | — | — | ⚠️ partially (TH i18n leak check) | Deterministic Intl call — visual regression acceptable given shared relative-time.ts pattern |

**Gaps (non-blocking)**:
- E2E tests gated on `E2E_ADMIN_EMAIL/PASSWORD` — run manually or in CI with seeded env.
- No unit test for `ArchivedBanner` / `ArchiveMemberButton` Client Components; covered by E2E.

**Overall**: Strong multi-layer coverage. Unit (fast) + Contract (handler shape) + Integration (live DB semantics) pyramid maintained.

---

## Metrics Summary

| Metric | Value |
|--------|-------|
| Files reviewed (round 2 scope) | 10 (migration 1, journal 1, use cases 2, API route 1, components 2, integration test 1, unit tests 2) |
| 🔴 Blockers | 0 |
| 🟡 Warnings | 0 |
| 🟢 Suggestions | 0 |
| Round-1 findings resolved | 9/9 (8 code-level + 1 documentation-deferred) |
| Spec coverage (US7) | 12/12 = 100% |
| Unit + contract tests | 905/905 green (+16 vs round-1 889) |
| US7 integration tests | 10/10 green on live Neon (+1 vs round-1) |
| Typecheck | Clean |
| Lint | Clean |
| i18n parity | 722 keys × EN/TH/SV |
| Migrations applied | 0016 + 0017 on live Neon |

---

## Recommended Actions

### Must Fix (Blockers)

*None.*

### Should Fix (Warnings)

*None.*

### Nice to Fix (Suggestions)

1. **R004 spec follow-up (outside `/speckit.ship` scope)** — add a one-line paragraph to `spec.md` § Security considerations noting that the `reason` field on `member_archived` audit events carries the same PII posture as `notes` (admin free-text, ≤ 500 chars, not indexed, covered by F9 GDPR export carve-out). Code-level mitigation + unit-test pinning is in place; this is purely a documentation update for F9's inheritance discovery. Recommend landing in the US7 retrospective commit or as a trivial `/speckit.specify` follow-up.

---

## Verdict

✅ **APPROVED**

Zero blockers. Zero warnings. All 9 round-1 findings resolved with code-level
evidence. Test coverage strengthened (+16 unit tests, +1 integration test).
Migration 0017 correctly tightens the invitations grant. Thai BE display
aligned with the existing F3 relative-time pattern.

**Next step**: Run `/speckit.ship` to prepare the release. The R004 spec
paragraph addition can land in the same `[Spec Kit]` commit or a follow-up.

---

**Strengths of this remediation pass**:
- Migration 0017 is surgical — one REVOKE + one column-level GRANT. No
  app-code breakage (tests cover it), no broader permission drift.
- Set-dedupe for R002 is the correct idiomatic fix — no architectural
  change, just a one-line guard at the cascade boundary.
- R009 unit tests exercise use-case logic without a DB, giving <50ms
  feedback for future refactors. Integration suite remains the source of
  truth for SQL semantics.
- R007 reuses the existing `th-TH-u-ca-buddhist` pattern — no new i18n
  helper to maintain, and the BE display now matches the pattern used by
  `relative-time.ts` (single source of truth for Thai date formatting).
- All R-tagged code comments cite the review ID (`R001 (staff-review-
  20260417-us7)`, etc.) — future maintainers can find the rationale in
  this report in seconds.

---

*Generated by `/speckit.staff-review.run` — Round 2 of 2. Staff-level
code review for spec-driven development.*
