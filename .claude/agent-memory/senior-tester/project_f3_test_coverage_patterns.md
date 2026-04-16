---
name: F3 Members & Contacts Test Coverage Patterns
description: Key test coverage gaps and patterns discovered during Review Pass 5 (QA) for F3 branch 005-members-contacts
type: project
---

F3 test suite is comprehensive for the security-critical email-change flow (FR-012a/b/c) and tenant isolation (FR-021/022 — Review-Gate blocker).

**Why:** This was the first F-stream feature handling PII at scale. The team correctly prioritized the dual-channel email-change, rollback atomicity, and cross-tenant probe tests.

**How to apply:** For future features touching contact PII or email flows, mirror the chaos-test pattern in `contact-email-change-atomic.test.ts` (three rollback sub-scenarios: outbox throw, session revocation throw, email conflict). Pattern: seed with `seedMemberWithLinkedContact`, call `countTenantRows` before, assert zero delta after chaos.

**Known gaps discovered in Review Pass 5 (2026-04-16):**
1. No contract test for `GET /api/members/[memberId]` (single-member fetch) — 404 on cross-tenant probe not contract-tested
2. No contract test for `DELETE /api/members/[memberId]/contacts/[contactId]` (contact removal)
3. `PORTAL_SELF_UPDATE_FIELDS` compile-time tuple unit test (FR-014a) only covers `isPortalSelfUpdateContactField`/`isPortalSelfUpdateMemberField` — missing assertion that the zod schema key-set equals the tuple exactly
4. No integration test for member self-service PATCH (`/portal`): `member_self_update_forbidden` audit event on forged payload not integration-tested
5. No contract test for bulk action endpoint (FR-019/FR-019a/FR-019b) — rate limiting (429), batch >100 rejection (400), all-or-nothing rollback not exercised at contract layer
6. US7 archive/undelete: no integration test asserting `member_archived` + `member_undeleted` audit events written; no test for portal sign-in rejection of archived member (US7 AS4)
7. US6 timeline endpoint: no contract test at all (no `/api/members/[id]/timeline` contract file found)
8. E2E: no test for `/portal` (member self-service), `/admin/members/:id/timeline`, or `/portal/contacts/invite` pages — FR-024 lists these as required axe-core scan targets
9. `checkTurnoverBand` unit test: turnover=0 (pre-revenue) path not explicitly tested against Corporate plan requirement (edge case from spec)
10. Sign-in integration test: `afterAll` restore order risk — if test 1 fails mid-flight without restore, test 3 "allows sign-in after flags cleared" may pass spuriously because flags were already restored in test 1's inline restore

**Flakiness risk observed:**
- `sign-in-f3-guards.test.ts`: inline mid-test restores (`await db.update(...).set({ emailVerified: true })`). If the assertion fails before the restore executes, the flag leaks into the next test. Use `afterEach` for flag cleanup, not inline.
- `verify-contact-email.test.ts`: `beforeAll` + module-level `let verificationTokenHash` — if `beforeAll` fails, all tests in the describe block run against an undefined hash and produce misleading failures. Consider a guard.

**Reusable patterns:**
- `seedMemberWithLinkedContact()` in `contact-email-change-atomic.test.ts` — gold standard for email-change integration setup
- `countTenantRows()` helper — use for before/after delta assertions on outbox+tokens+audit
- `vi.hoisted()` pattern used correctly in `email-verification-route.test.ts` and `email-change-revert-route.test.ts`
- `it.skipIf(!RUN_PERF)` gating pattern for perf tests (bundle-change-warning + search-perf) — correct approach
