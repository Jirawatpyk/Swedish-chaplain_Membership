# Code Review Report: F3 US7 — Archive + Undelete Member

**Reviewer**: AI Agent (Staff Engineer Perspective)
**Date**: 2026-04-17
**Feature**: [specs/005-members-contacts/spec.md — US7](../spec.md)
**Branch**: `005-members-contacts`
**Scope**: T134–T143 (US7 Archive + Undelete, Phase 9) + verify-round LOW remediation
**Verdict**: ⚠️ **APPROVED WITH CONDITIONS**

---

## Executive Summary

US7 ships a clean, well-tested archive/undelete flow that honours the spec
US7 AS1–AS4 end-to-end — atomic state flip + session revocation cascade +
90-day undelete window + localized banner UX. The implementation composes
cleanly against the existing F3 ports (`MemberRepo.findByIdInTx`,
`MemberRepo.updateStatusInTx`, `SessionRevocationPort.revokeAllForInTx`,
`AuditPort.recordInTx`) with no framework leaks into Domain/Application. All
13 contract + 9 integration tests are green on live Neon Singapore.

The verify-round fix for C1 (invitation soft-consume cascade) is correct and
well-motivated defense-in-depth, but the companion migration `0016` grants
`SELECT` on the full `invitations` table to `chamber_app`, which includes
the `id` column that IS the invitation token (F1 design). That widens the
SQL-injection blast radius from zero to "enumerate live 7-day invite
tokens" if a chamber_app-scoped query is ever compromised. **SEC-1 is the
one item gating a clean ship.** Remediation is a column-level grant
tightening — small scope, low risk.

No data-corruption, auth-bypass, or RLS-leak issues found. All spec
requirements for US7 are covered with implementation evidence.

---

## Review Findings

| ID | Severity | File | Line(s) | Category | Finding | Recommendation |
|----|----------|------|---------|----------|---------|----------------|
| R001 | 🟡 Warning | `drizzle/migrations/0016_invitations_revoke_grant.sql` | 20 | Security | `GRANT SELECT ON TABLE invitations TO chamber_app` exposes `invitations.id` which is the raw 7-day invite token (F1 design — tokens are stored as PKs, not hashed). If any chamber_app-scoped query is ever compromised via SQLi, an attacker can enumerate live tokens and hijack any pending invitation. Drizzle-orm's parametrized queries make this a low-probability path, but the blast radius should still be minimized. | Change to column-level grants: `GRANT SELECT (user_id, consumed_at, expires_at) ON invitations TO chamber_app; GRANT UPDATE (consumed_at) ON invitations TO chamber_app;` Then change `archive-member.ts` `.returning({ id: invitations.id })` → return no rows and use the Drizzle update result count (`result.count` or `result.length` depending on driver) — OR do a `SELECT COUNT(*)` pre-UPDATE with the same WHERE clause. |
| R002 | 🟡 Warning | `src/modules/members/application/use-cases/archive-member.ts` | 105–130 | Performance / Correctness | Session-revocation loop runs N serial `revokeAllForInTx` calls for N linked users (each emits its own `user_sessions_revoked` audit). If a member has contacts that all link to the SAME F1 user (rare but possible — same person holding 2 role titles), the same user's sessions get revoked twice (first call removes all, second returns `revokedCount=0`) and duplicate audit events pollute the timeline. | Dedupe `linkedUserIds` via `new Set(...)` before the loop, OR skip audit emission when `revokedCount === 0`. Lean toward the Set dedupe — cleaner and matches intent (we want one audit per user, not per contact). |
| R003 | 🟡 Warning | `src/app/api/members/[memberId]/archive/route.ts` | 56–70 | Correctness | Body-parsing gates on `content-length` header. A malformed request that omits `content-length` but sends a JSON body would skip `request.json()` and pass `rawBody={}` — losing the admin's `reason` silently. Converse: `content-length: 0` but body present → JSON never parsed. HTTP spec compliance means both are edge cases, but fetch()/curl POSTs occasionally omit the header. | Always attempt `await request.json().catch(() => ({}))` regardless of content-length header, since a missing body is indistinguishable from `{}` and the zod schema handles the empty-object case correctly. |
| R004 | 🟡 Warning | `src/modules/members/application/use-cases/archive-member.ts` | 156 | Audit / PII | The `reason` text (up to 500 chars free-form) is stored verbatim in the `member_archived` audit payload. Spec § Security considerations carves out the `notes` field for similar risk ("admins are expected to avoid pasting PII"). Reason field inherits the same concern without an equivalent spec acknowledgment. | Add an i18n helper text to the UI reason textarea (`archive.reasonHelper` already exists at EN "Up to 500 characters. Visible to other admins in the audit log." — good, already implemented). Consider also excluding `reason` from future GDPR self-service export (F9 scope — flag here). |
| R005 | 🟢 Suggestion | `src/modules/members/application/use-cases/undelete-member.ts` | — | Spec Compliance | File comment notes sessions are NOT reactivated on undelete (correct behaviour per spec: revoked sessions stay dead, user signs in fresh). But there's no explicit note about pending invitations: my archive cascade soft-consumed them; undelete does NOT re-issue. Admin must manually re-invite the primary contact post-undelete. This is correct but surprising. | Add a doc comment in `undelete-member.ts` mirroring the session note: "Does NOT re-issue soft-consumed invitations — admin must re-invite manually post-undelete." Consider a toast copy hint in the Undelete success handler. |
| R006 | 🟢 Suggestion | `src/components/members/archive-member-button.tsx` | 41–46 | UX | When the admin cancels the AlertDialog and reopens, the stale `reason` value persists from the previous attempt (state not reset in `onOpenChange`). Not a bug but a small UX papercut (e.g. admin types "testing", cancels, opens later for a real archive, sees leftover "testing"). | Reset `reason` + `loading` in the `onOpenChange` callback when `next === false`. Pattern used by `_components/archive-confirm-dialog.tsx:50–58` (bulk archive). |
| R007 | 🟢 Suggestion | `src/components/members/archived-banner.tsx` | 89 | i18n | `const isoDate = new Date(archivedAtIso).toISOString().slice(0, 10);` passes a YYYY-MM-DD ISO date to the i18n template. For `th-TH` users, Thai Buddhist Era display is expected per CLAUDE.md ("Thai Buddhist Era (BE = CE + 543) is display-only for th-TH user-facing surfaces"). Current impl renders 2026 for Thai, not 2569 BE. | Pre-existing pattern across F3 (detail page also renders ISO for archivedAt). Out of US7 scope — either defer to Phase 10 T159 i18n polish OR a dedicated BE-display helper landed feature-wide. |
| R008 | 🟢 Suggestion | `tests/integration/members/archive-cascade.test.ts` | 195–240 | Test Quality | No test covers the edge case "member has TWO contacts both linked to the SAME F1 user". Together with R002, this would verify the dedupe fix. | After applying R002 fix, add a test: seed member with 2 contacts → both `linkedUserId = linkedUser.userId` → archive → assert `user_sessions_revoked` audit appears exactly once, not twice. |
| R009 | 🟢 Suggestion | `src/modules/members/application/use-cases/archive-member.ts` + undelete | — | Test Quality | No unit tests with stubbed deps for archive-member / undelete-member use cases. Integration tests on live Neon cover correctness but are slower (~5s vs ~50ms). Similar to `tests/unit/members/application/directory-search-with-count.test.ts` pattern. | Add `tests/unit/members/application/archive-member.test.ts` + `undelete-member.test.ts` with port stubs for fast feedback on logic changes. Not blocking — integration tests already prove correctness. |

**Categories**: Correctness, Security, Performance, Spec Compliance, Error Handling, Test Quality, Architecture, UX, i18n

---

## Spec Coverage Matrix

| Requirement | Status | Implementation Notes |
|-------------|--------|---------------------|
| FR-005: soft-delete + undelete within 90 days, no hard delete in UI | ✅ Implemented | `archive-member.ts` + `undelete-member.ts` + 90-day policy in `domain/policies/archive-window-policy.ts`. No hard-delete surface exposed. |
| FR-022: cross-tenant probe returns 404 + audit | ✅ Implemented | `findByIdInTx` returns `repo.not_found` under RLS; route maps to 404. Cross-tenant test in `archive-cascade.test.ts` + `undelete-window.test.ts`. |
| FR-023: audit `member_archived`, `member_undeleted`, `user_sessions_revoked` | ✅ Implemented | All 3 event types emitted; audit payloads verified by integration tests. `member_archived` payload carries `invitations_revoked_count` (verify-round C1). |
| FR-026: destructive action confirmation | ✅ Implemented | `ArchiveMemberButton` uses shadcn AlertDialog with cancel/confirm + optional reason. Esc cancels. |
| FR-027: archived retention ≥ 5 years | ✅ Inherited | Audit append-only trigger (migration 0001); archive never deletes member row. |
| FR-034: "Show archived" as third directory state | ✅ Implemented | Status filter Select (`active` / `inactive` / `archived`) documented in spec amendment. Default filter excludes archived. |
| FR-037: unique `<title>` per page | ✅ Inherited | Archive/undelete don't add new routes; existing detail `generateMetadata` covers the archived-member detail view. |
| US7 AS1: Archive → status=archived + archived_at + audit + leaves directory | ✅ Verified | Integration test `archives a member: flips status + sets archived_at + audit row` + default status filter `[active, inactive]`. |
| US7 AS2: Undelete within 90 days → status=active + audit | ✅ Verified | Integration test `undeletes a member within 90-day window`. |
| US7 AS3: > 90 days → Undelete disabled with tooltip | ✅ Verified | `ArchivedBanner` `window_expired` branch + tooltip; domain policy rejects at use-case layer. |
| US7 AS4: Archive → linked user sessions invalidated | ✅ Verified | Integration test `cascade: revokes sessions of linked F1 user on archive`. |
| Spec Edge Case: Contact tied to pending F1 invitation | ✅ Implemented (verify-round C1) | Invitation soft-consume cascade in `archive-member.ts` + integration test `cascade: soft-consumes pending unredeemed invitations`. |

**Coverage**: 12/12 US7-scoped requirements implemented (100%)

---

## Test Coverage Assessment

| Area | Tests Exist? | Coverage | Gaps |
|------|-------------|----------|------|
| `archive-member` use case | ✅ Integration (5 tests on live Neon) | Happy path + cascade sessions + cascade invitations + re-archive + cross-tenant | No unit tests with stubs (R009). No same-user-multi-contact edge case (R008). |
| `undelete-member` use case | ✅ Integration (4 tests on live Neon) | Within-window + expired-window + non-archived + cross-tenant | No unit tests with stubs (R009). |
| POST `/archive` route | ✅ Contract (7 tests) | 200 happy / 200 no-body / 400 missing key / 400 invalid body / 404 / 409 state / 500 | Idempotency replay path not explicitly tested (covered by route-level shared pattern). |
| POST `/undelete` route | ✅ Contract (6 tests) | 200 / 400 missing key / 403 window expired / 404 / 409 state / 500 | Same as above. |
| `ArchiveMemberButton` component | ⚠️ E2E only | Dialog render + cancel (gated on E2E env) | No unit test for the Client Component interaction (state reset on close). |
| `ArchivedBanner` component | ⚠️ E2E only | Banner renders when archived | No unit test for `windowStatus` branch switching. |
| E2E spec | ✅ 4 tests authored | CTA render + dialog open + axe a11y + TH/SV i18n | Test gated on E2E env vars; not run in CI standard pass. |
| Domain `archive()` + `undelete()` transitions | ✅ Unit (from Phase 2 T032) | `tests/unit/members/domain/member-state.test.ts` | Pre-existing, stable. |

**Overall Test Coverage**: Strong integration + contract coverage (22 tests across 3 files, 100% branch on live Neon). Unit + E2E gaps are minor and tracked in R008/R009.

---

## Metrics Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 13 (use cases 2, API routes 2, components 2, page 1, barrel 1, migration 1, contract test 1, integration tests 2, E2E spec 1, i18n 3) |
| 🔴 Blockers | 0 |
| 🟡 Warnings | 4 (R001 SEC, R002 CORR/PERF, R003 CORR, R004 AUDIT/PII) |
| 🟢 Suggestions | 5 (R005 docs, R006 UX, R007 i18n, R008 test, R009 test) |
| Spec coverage (US7) | 12/12 = 100% |
| Unit + contract tests | 889/889 green |
| US7 integration tests | 9/9 green on live Neon |
| Migration applied | 0016 applied ✓ |
| Typecheck | Clean |
| Lint | Clean |
| i18n parity | 722 keys × EN/TH/SV |

---

## Recommended Actions

### Must Fix (Blockers)

*None.*

### Should Fix (Warnings) — condition for ship

1. **R001 (SEC-1)**: Tighten migration 0016 to column-level grant. New migration `0017_invitations_revoke_grant_tighten.sql`:
   ```sql
   REVOKE SELECT ON TABLE invitations FROM chamber_app;
   GRANT SELECT (user_id, consumed_at, expires_at) ON invitations TO chamber_app;
   -- UPDATE (consumed_at) from 0016 remains sufficient.
   ```
   Then change `archive-member.ts` `.returning({ id: invitations.id })` → drop the `.returning()` and use a pre-SELECT count or rely on a raw SQL UPDATE result count.

2. **R002**: Dedupe `linkedUserIds` with `new Set()` before the session-revocation loop in `archive-member.ts`. Add integration test per R008.

3. **R003**: Remove the `content-length` gate in `archive/route.ts` — always attempt `await request.json().catch(() => ({}))`.

4. **R004**: Document the `reason` field's audit exposure in the spec § Security considerations and flag for F9 GDPR export carve-out. No code change needed; UI helper text already warns.

### Nice to Fix (Suggestions)

5. **R005**: Add doc comment to `undelete-member.ts` about invitation non-re-issuance.
6. **R006**: Reset `reason` + `loading` on AlertDialog close in `archive-member-button.tsx`.
7. **R007**: Thai BE date display for `archivedAt` — track as part of Phase 10 i18n polish.
8. **R008** + **R009**: Add unit tests for archive-member/undelete-member with stubbed deps + same-user-multi-contact edge case.

---

## Verdict

⚠️ **APPROVED WITH CONDITIONS**

Ship-readiness gated on addressing **R001 (tighten invitation grant)** before `/speckit.ship`. R002–R004 should land in the same fix commit for a clean ship. R005–R009 may slide into Phase 10 polish without blocking the US7 close-out.

**Strengths worth calling out**:
- Clean Clean-Architecture compliance: zero framework leaks, ports composed via members-deps root.
- TDD discipline: tests authored alongside implementation; typed `Result<T,E>` error surfaces; 22 US7-scoped tests all green.
- Defense-in-depth cascade: sessions + invitations + audit in single tx; cross-tenant probes return 404 not 403 (FR-022).
- i18n completeness: 24 archive/undelete keys × 3 locales on day one.
- Spec amendments (contract endpoint 5 + 6, FR-034 clarification) captured during verify-round are accurate and forward-compatible.

**Next step**: Apply R001–R004 remediation, then re-run `/speckit.staff-review.run` for a clean APPROVED verdict before `/speckit.ship`.

---

*Generated by `/speckit.staff-review.run` — Staff-level code review for spec-driven development.*
