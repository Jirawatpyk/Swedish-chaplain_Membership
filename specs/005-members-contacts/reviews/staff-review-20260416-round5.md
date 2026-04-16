# Staff-Engineer Review Round 5: F3 Members & Contacts (US1-US3) — Re-verification

**Branch**: `005-members-contacts`
**Date**: 2026-04-16
**Scope**: Re-verification of 10 blockers + 5 warnings fixed in commit `dfbb5b0`
**Reviewer**: Claude Opus 4.6 (5-agent parallel verification)
**Prior reviews**: Rounds 1-4 complete

---

## Executive Summary

**Verdict: APPROVED WITH CONDITIONS**

All 10 blockers and 5 warnings from Round 4 have been verified as correctly implemented with no regressions. Fresh scan found 0 new issues above confidence threshold (80%).

---

## Verification Results

### Security Fixes (4/4 VERIFIED)

| Fix | Status | Details |
|---|---|---|
| SEC-1: GET returns 405 on token routes | VERIFIED | Both routes export zero-arg `GET()` returning 405 + `Allow: POST` header. Contract tests updated. |
| SEC-2: FOR UPDATE + idempotent markConsumed | VERIFIED | `.for('update')` on line 99. `markConsumedInTx` has `isNull(consumedAt)` guard + `returning()` length check. |
| SEC-3: Contact-member ownership validation | VERIFIED | Both `updateContactFields` and `removeContact` accept `memberId`, check ownership, return `not_found` on mismatch. Callers pass `parsed.data.memberId`. |
| SPEC-1: FOR UPDATE SKIP LOCKED on outbox | VERIFIED | `.for('update', { skipLocked: true })` at line 170. Drizzle syntax correct. |

### Correctness Fixes (5/5 VERIFIED)

| Fix | Status | Details |
|---|---|---|
| COR-1: promotePrimary member_id constraint | VERIFIED | WHERE uses `and(eq(contactId), eq(memberId))` at lines 325-330. |
| COR-2: email_verified guard in resendVerification | VERIFIED | Port declares `isEmailVerified()`, adapter implements with `db.select()`, use case guards before tx. Route passes `userEmails`. |
| COR-3: Cursor NULL lastActivityAt | VERIFIED | Encoding uses `'NULL'` sentinel. Decoding checks `iso === 'NULL'` and generates `member_id > cursorId` (correct ASC direction for NULLS LAST tail). |
| COR-4: findSoftDuplicate excludes archived | VERIFIED | WHERE includes `or(eq('active'), eq('inactive'))!`. |
| COR-9: was_primary captured before UPDATE | VERIFIED | SELECT `isPrimary` before UPDATE, audit uses pre-captured `wasPrimary`. |

### Performance Fixes (3/3 VERIFIED)

| Fix | Status | Details |
|---|---|---|
| PERF-2: Outbox zombie attempts + permanent_failed | VERIFIED | `attempts: row.attempts + 1`, `>= MAX_ATTEMPTS` flips to `permanently_failed`. Counter incremented. |
| PERF-3: inArray() replaces or() chain | VERIFIED | `inArray` imported, `inArray(contacts.memberId, memberIds)` used. Empty array guard present. |
| PERF-4: Single runInTenant() in searchDirectory | VERIFIED | One `runInTenant()` block contains both member query and primary contacts query. Destructuring matches return shape. |

### Test Fixes (4/4 VERIFIED)

| Fix | Status | Details |
|---|---|---|
| TEST-1: get-member contract test | VERIFIED | 5 tests (200, 401, 404 UUID, 404 not_found, 500). Fixture complete, mocks correct. |
| TEST-2: sign-in guards afterEach | VERIFIED | `afterEach` import present, restore logic moved from inline to hook. No inline restore remains. |
| 405 contract test (verification) | VERIFIED | `GET()` with 0 args, asserts 405 + `method_not_allowed` + `Allow: POST` + mock not called. |
| 405 contract test (revert) | VERIFIED | Same pattern as verification route. |

### New Issues Scan

| Result | Details |
|---|---|
| **0 blockers** | No new issues found with confidence >= 80% |
| **0 warnings** | 3 low-confidence observations noted (all < 70%) — not actionable |

---

## Remaining Known Items (non-blocking for US1-US3 MVP)

These were identified in Round 4 and are tracked as future work (US4-US7 scope):

1. **COR-5**: `directorySearch` imports from Infrastructure (Principle III) — refactor to port
2. **COR-7**: `verify-contact-email` uses wrong audit `eventType` — needs migration
3. **COR-8**: `updateMember` persist+audit not in same transaction — wrap together
4. **SPEC-2**: `email_dispatch_failed` audit not emitted from outbox cron — wire system-actor
5. **US4-US7**: Phases 6-9 entirely unimplemented (inline edit, bulk, self-service, timeline, archive)

---

## Verdict

**APPROVED WITH CONDITIONS**

All 10 Round 4 blockers are verified as correctly fixed with no regressions. The US1-US3 MVP slice is ready for shipping with the following conditions:

1. Items COR-5 (Clean Architecture), COR-7 (audit eventType), COR-8 (transaction scope) should be addressed before full F3 completion but do NOT block US1-US3 MVP merge.
2. US4-US7 tasks remain open and are not in scope for this review gate.

**Next step**: Run `/speckit.ship` to prepare the US1-US3 MVP release.
