# Staff-Engineer Review: F3 Members & Contacts (US1-US3)

**Branch**: `005-members-contacts`
**Date**: 2026-04-16
**Scope**: 186 files changed, ~25,563 LOC (US1-US3 MVP slice)
**Reviewer**: Claude Opus 4.6 (5-pass automated review)
**Prior reviews**: 3 rounds completed (commits `331d2e4`, `6742b0e`, `7a30adc`)

---

## Executive Summary

**Verdict: CHANGES REQUIRED**

US1-US3 implementation is architecturally solid with strong tenant isolation (10/10 RLS tests), comprehensive email-change security flow (FR-012a/b), and good test coverage on critical paths. However, 10 blockers across security, correctness, performance, spec compliance, and test quality must be resolved before shipping.

US4-US7 (inline edit, bulk actions, self-service portal, timeline, archive/undelete) are entirely unimplemented — this review covers the US1-US3 MVP slice only.

---

## Metrics

| Category | Count |
|---|---|
| Files reviewed | 186 |
| Blockers | 10 |
| Warnings | 17 |
| Suggestions | 7 |
| Spec FRs implemented | 24/44 (55%) |
| Spec FRs partial | 10/44 (23%) |
| Spec FRs missing | 10/44 (22%) — all in US4-US7 scope |
| Tests (unit+contract) | ~796 |
| Tests (integration) | ~234 |
| Tenant isolation | 10/10 green |

---

## Findings

### BLOCKERS (must fix before merge)

#### SEC-1: GET handler consumes tokens — email prefetchers exhaust revert/verify links
- **File**: `src/app/api/auth/email-verification/[token]/route.ts:122-123`
- **File**: `src/app/api/auth/email-change/revert/[token]/route.ts:126-127`
- **Impact**: Both endpoints export `GET = handle` where `handle` performs state-mutating operations (consume token, revoke sessions, set DB flags). Email clients (Gmail Safe Browsing, Apple Mail Privacy Protection, Outlook Link Preview, corporate mail gateways) prefetch links via GET before user clicks. The revert link — the user's protection against account takeover — can be silently consumed by a prefetcher.
- **Fix**: Remove `export const GET = handle`. Either return 405 for GET, or make GET render a confirmation page that POSTs to the same endpoint. The client-side pages (`email-verification/[token]/page.tsx`, `email-change/revert/[token]/page.tsx`) already exist — wire them to POST instead of relying on GET.

#### SEC-2: Token double-consume race — no `SELECT FOR UPDATE`
- **File**: `src/modules/members/infrastructure/adapters/email-change-token-adapter.ts:84-96`
- **Impact**: `findActiveByIdInTx` uses a plain SELECT without row-level locking. Under Postgres READ COMMITTED, two concurrent requests can both pass the `consumedAt IS NULL` check before either commits. Additionally, `markConsumedInTx` (line 115-125) has no `AND consumed_at IS NULL` guard, so it unconditionally overwrites.
- **Fix**: Add `.for('update')` to the SELECT in `findActiveByIdInTx`. Add `isNull(emailChangeTokens.consumedAt)` to the WHERE clause in `markConsumedInTx` and check `returning()` length to detect lost-update.

#### COR-1: `promotePrimary` UPDATE has no `member_id` constraint — cross-member promotion possible
- **File**: `src/modules/members/infrastructure/db/drizzle-contact-repo.ts:313-317`
- **Impact**: The promote UPDATE uses only `WHERE contact_id = $newPrimaryContactId` without verifying `member_id = $memberId`. An admin request with a contactId belonging to a different member (same tenant) would succeed, corrupting the primary-contact invariant for both members.
- **Fix**: Add `eq(contacts.memberId, memberId)` to the WHERE clause. Also add an ownership check at the use-case level in `contact-crud.ts:241`.

#### COR-2: `resendVerificationEmail` missing `email_verified` guard
- **File**: `src/modules/members/application/use-cases/resend-verification-email.ts:67-92`
- **Impact**: The error type declares `not_eligible` with reason `'email_verified'` but the code never checks the flag. An admin can resend verification to an already-verified user, which invalidates all active tokens and issues a new one — forcing unnecessary re-verification.
- **Fix**: Add `UserEmailPort.getFlags(userId)` method. Check `emailVerified === true` before issuing a new token and return `err({ code: 'not_eligible', reason: 'email_verified' })`.

#### COR-3: Cursor pagination infinite loop on NULL `lastActivityAt`
- **File**: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:348-362, 480-484`
- **Impact**: When `lastActivityAt` is NULL, the cursor encodes as `"|<memberId>"`. On decode, `iso` is empty string `""` which is falsy, so the cursor condition is silently dropped — the next page returns results from the beginning, creating an infinite loop for any tenant with more than `limit` members having NULL activity.
- **Fix**: Use an explicit `"NULL"` sentinel in the cursor encoding. On decode, generate `(last_activity_at IS NULL AND member_id < cursorId)` SQL when the sentinel is detected.

#### PERF-1: `ilike` not using GIN trigram indexes — SLO SC-002 will fail
- **File**: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:370+`
- **Impact**: `searchDirectory` uses Drizzle's `ilike()` with leading wildcard (`%q%`). Postgres sequential-scans instead of using the `members_company_name_trgm_gin` / `contacts_name_trgm_gin` GIN indexes. SC-002 (p95 < 500ms on 5,000-row tenants) will fail beyond ~500 members.
- **Fix**: Use raw `sql` template with the `%` similarity operator (`sql\`${members.companyName} % ${filter.q}\``) which is supported by `gin_trgm_ops`. Alternatively, ensure `pg_trgm` `ILIKE` support is enabled (Postgres 9.1+ does support `ILIKE` with trigram GIN indexes if the extension is active — verify with `EXPLAIN ANALYZE`).

#### PERF-2: Outbox zombie rows — `member_invitation` retries forever without incrementing `attempts`
- **File**: `src/app/api/cron/outbox-dispatch/route.ts:182-200`
- **Impact**: When `buildPayload()` returns null (stub event types like `member_invitation`), the row is retried every 5 minutes but `attempts` is never incremented. These zombie rows fill the BATCH_SIZE=50 slot indefinitely, delaying real emails.
- **Fix**: Add `attempts: row.attempts + 1` to the SET clause. Add `if (row.attempts + 1 >= MAX_ATTEMPTS)` check to flip to `permanently_failed`.

#### SPEC-1: Outbox dispatcher lacks `FOR UPDATE SKIP LOCKED` — duplicate email delivery
- **File**: `src/app/api/cron/outbox-dispatch/route.ts:158-170`
- **Impact**: Code comments acknowledge this is a scaffold. Vercel Cron's "at least once" guarantee means two concurrent instances can process the same row, sending duplicate verification/revert emails.
- **Fix**: Add `FOR UPDATE SKIP LOCKED` to the outbox SELECT query. Create an explicit open task in tasks.md tracking this.

#### TEST-1: No contract test for `GET /api/members/[memberId]` (single-member fetch)
- **File**: Missing — `tests/contract/members/get-member.test.ts` does not exist
- **Impact**: FR-022 cross-tenant probe (returns 404) is only tested at integration layer. The route handler's error-code-to-HTTP-status mapping is untested at contract level.
- **Fix**: Create `tests/contract/members/get-member.test.ts` covering 200 success, 401 unauthenticated, 404 not_found (incl. cross-tenant probe), 500 server_error.

#### TEST-2: `sign-in-f3-guards.test.ts` inline state restore — flakiness risk
- **File**: `tests/integration/auth/sign-in-f3-guards.test.ts:60-63, 85-88`
- **Impact**: If an assertion fails, the inline DB restore (`db.update(...).set({ emailVerified: true })`) is never executed, leaking state to subsequent tests. Test 3 depends on flags being clear.
- **Fix**: Move restore logic to `afterEach` hook.

---

### WARNINGS (should fix before merge)

#### COR-4: `findSoftDuplicate` includes archived members — false positive warnings
- **File**: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:87-105`
- **Recommendation**: Add `status IN ('active', 'inactive')` filter.

#### COR-5: `directorySearch` use case imports directly from Infrastructure layer
- **File**: `src/modules/members/application/use-cases/directory-search.ts:15-16`
- **Impact**: Principle III (NON-NEGOTIABLE) violation. Application layer must not import from Infrastructure.
- **Recommendation**: Move `searchDirectory` behind `MemberRepo` port. Define `DirectoryRow`/`DirectoryFilter` in `application/ports/member-repo.ts`.

#### COR-6: `change-contact-email` TOCTOU — `linkedUserId` read outside transaction
- **File**: `src/modules/members/application/use-cases/change-contact-email.ts:110-123`
- **Recommendation**: Re-verify `linkedUserId` inside the transaction.

#### COR-7: `verify-contact-email` uses wrong audit `eventType`
- **File**: `src/modules/members/application/use-cases/verify-contact-email.ts:119`
- **Impact**: Uses `email_verification_sent` for token consumption. Append-only audit log makes this unfixable retroactively.
- **Recommendation**: Add `email_verification_consumed` event type in a migration.

#### COR-8: `updateMember` / `changePlan` — audit failure after successful persist = partial success
- **File**: `src/modules/members/application/use-cases/update-member.ts:159+173`
- **Recommendation**: Wrap persist + audit in a single `runInTenant` transaction.

#### COR-9: `remove` in contact-repo — `was_primary` audit field always FALSE
- **File**: `src/modules/members/infrastructure/db/drizzle-contact-repo.ts:196-201`
- **Impact**: `RETURNING` reflects post-SET values. Since SET forces `isPrimary: false`, the audit payload is always wrong.
- **Recommendation**: Capture `isPrimary` before the UPDATE or pass it from the use case.

#### SEC-3: IDOR — `contactId` not validated against URL `memberId`
- **File**: `src/modules/members/application/use-cases/contact-crud.ts:146-198`
- **Impact**: Admin can operate on contactB via memberA's URL. Not a privilege escalation (same tenant), but corrupts audit trail.
- **Recommendation**: Add `contact.memberId === memberId` check before mutation.

#### PERF-3: `or()` chain instead of `inArray()` for primary contacts batch fetch
- **File**: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:461`
- **Recommendation**: Use `inArray(contacts.memberId, memberIds)`.

#### PERF-4: Two `runInTenant()` calls in `searchDirectory` — double connection setup + consistency gap
- **File**: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:337, 452-463`
- **Recommendation**: Merge primary-contact query into the same `runInTenant()` block.

#### SPEC-2: `email_dispatch_failed` audit NOT emitted on outbox permanent failure
- **File**: `src/app/api/cron/outbox-dispatch/route.ts`
- **Impact**: FR-012c + FR-023 require this high-severity audit event.
- **Recommendation**: Add a `[ ]` task and implement using the system-actor pattern.

#### SPEC-3: ESLint Application layer rule does not forbid `resend`, `@upstash/*`, `pino`
- **File**: `eslint.config.mjs` (applicationForbiddenImports)
- **Recommendation**: Extend the rule to match Domain layer restrictions.

#### SPEC-4: `invitation_revoked` cascade missing from `removeContact`
- **Impact**: Spec edge case requires revoking pending invitations when a contact is removed.
- **Recommendation**: Check for pending invitation and revoke with audit event.

#### TEST-3: Missing contract tests for `401 unauthenticated` in list-members, affected-members, update-member
- **Files**: `tests/contract/members/list-members.test.ts`, `affected-members.test.ts`, `update-member.test.ts`
- **Recommendation**: Add 401 branch test to each.

#### TEST-4: FR-014a — no unit test asserting zod schema key-set equals PORTAL_SELF_UPDATE_FIELDS tuple
- **Impact**: Spec mandates this test. Schema/tuple drift won't be caught.
- **Recommendation**: Add key-set equality assertion.

#### TEST-5: E2E coverage gaps — `/portal`, timeline, colleague-invite pages
- **Impact**: FR-024 lists these as required axe-core scan targets.

---

### SUGGESTIONS (nice to fix)

| ID | File | Description |
|---|---|---|
| S-1 | `drizzle-member-repo.ts:88` | `findSoftDuplicate` uses `ilike` for exact match — use `lower()` functional index |
| S-2 | `drizzle-member-repo.ts:106` | `audit_log_member_id_idx` missing `tenant_id` — add composite for timeline perf |
| S-3 | `primary-contact-race.test.ts:188` | `void second` is not an assertion — assert ok or conflict explicitly |
| S-4 | `members-create.spec.ts:83` | `expect([200,201,422]).toContain(...)` too permissive for happy path |
| S-5 | `outbox-permanent-failure.test.ts:146` | Direct UPDATE bypasses dispatcher logic — test the dispatcher path instead |
| S-6 | `member-form-a11y.test.tsx` | Missing `autocomplete="bday"` test for Thai Alumni DOB (FR-036) |
| S-7 | `directory-search.test.ts` | No multi-filter combination test (plan_tier + status + country per US2 AS2) |

---

## Spec Coverage Matrix (US1-US3 only)

| FR | Description | Status |
|---|---|---|
| FR-001 | Directory with filters | Implemented |
| FR-002 | Create member + primary contact atomic | Implemented |
| FR-003 | One primary contact invariant | Implemented |
| FR-004 | Admin edit / manager read-only | Implemented |
| FR-006/6a | Turnover validation + override | Implemented |
| FR-007 | Start-up 2yr cap | Implemented |
| FR-008 | Thai Alumni age 35 | Implemented |
| FR-009 | No auto-plan-change | Implemented |
| FR-009a | Tax ID required + checksum | Implemented |
| FR-010 | Bundle-change dialog | Implemented |
| FR-011 | Contact CRUD | Implemented |
| FR-012 | Invite to portal | Implemented |
| FR-012a | 6-step email change | Implemented |
| FR-012b | 48h revert token | Implemented |
| FR-012c | Outbox retry + permanent failure | Partial (zombie rows, no audit, no SKIP LOCKED) |
| FR-016 | Substring search | Implemented (index not used) |
| FR-017 | Command palette | Implemented |
| FR-021 | Tenant isolation | Implemented (10/10) |
| FR-022 | Cross-tenant probe | Implemented |
| FR-023 | Audit events (23 types) | Partial (wrong eventType, missing dispatch_failed) |
| FR-030 | Copy-to-clipboard | Implemented |
| FR-031 | Soft-dedupe dialog | Implemented (includes archived — false positive) |
| FR-032 | Cross-tenant email collision | Implemented |
| FR-034 | Three empty states | Implemented |
| FR-035 | aria-required + asterisk | Implemented |
| FR-036 | Autocomplete attributes | Implemented |
| FR-043 | Palette result ordering | Implemented |

---

## Positive Observations

1. **Tenant isolation is exemplary** — 10/10 RLS tests, `runInTenant()` consistently used, `member_cross_tenant_probe` audit event on violation
2. **Email-change security flow is thorough** — dual-channel verify+revert, session revocation, `hashEmail()` in audit, activation delay, TTL enforcement
3. **Branded types eliminate stringly-typed bugs** — `MemberId`, `ContactId`, `PlanId`, `Email`, `Phone` with factory functions
4. **Result<T,E> used consistently** — no silent exception swallowing in application layer
5. **Integration tests hit live Neon** — catches real SQL/migration bugs that mocks would hide
6. **Contract test coverage is strong for most endpoints** — 8 branches on invite-portal, 11 on email-change-revert
7. **Domain policies well-tested** — turnover bands, age eligibility, startup duration, Thai tax ID checksum

---

## Recommended Actions (priority order)

### Must fix (Blockers)
1. **SEC-1**: Remove GET export from token-consumption routes
2. **SEC-2**: Add `FOR UPDATE` to token SELECT + idempotent guard on markConsumed
3. **COR-1**: Add `member_id` constraint to promotePrimary UPDATE
4. **COR-2**: Add `email_verified` guard to resendVerification
5. **COR-3**: Fix cursor encoding for NULL `lastActivityAt`
6. **PERF-1**: Verify/fix GIN trigram index usage with `EXPLAIN ANALYZE`
7. **PERF-2**: Increment `attempts` in outbox zombie-row path
8. **SPEC-1**: Add `FOR UPDATE SKIP LOCKED` to outbox dispatcher
9. **TEST-1**: Create contract test for GET single-member endpoint
10. **TEST-2**: Move sign-in guard test state restore to `afterEach`

### Should fix (Warnings)
11. COR-5: Move `directorySearch` behind MemberRepo port (Principle III)
12. SEC-3: Add contact-member ownership validation
13. COR-7: Add `email_verification_consumed` event type
14. COR-8: Wrap updateMember persist+audit in transaction
15. PERF-3+4: Use `inArray()` + merge `runInTenant()` calls
16. Remaining contract test 401 branches (TEST-3)

---

## Verdict

**CHANGES REQUIRED** — 10 blockers found across security (GET token consumption, double-consume race), correctness (cross-member promotion, infinite cursor loop), performance (GIN indexes unused, zombie outbox rows), and test quality (missing contract tests, flaky state restore).

Fix blocker issues, then run `/speckit.review` again.
