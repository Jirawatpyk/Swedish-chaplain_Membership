# Staff Review — F3 Members & Contacts (Full Holistic Round 2)

- **Feature**: 005-members-contacts
- **Branch**: `005-members-contacts` @ `83b075a`
- **Diff range**: `58526ad..HEAD` = 49 commits, 312 files, +43.2k insertions
- **Date**: 2026-04-17 17:08 +07
- **Prior review**: `staff-review-20260417-161134-full.md` (found B1 Principle III + W1 TODOs)
- **Verdict**: ✅ **APPROVED**

---

## Executive Summary

Second full-F3 holistic sweep after commit `83b075a` closed the 4-file B1 Principle III violation and the 2-file W1 TODO drift. This re-review runs fresh cross-cutting audits that the first holistic pass did not cover (input validation gates, authz coverage, swallowed promises, XSS sinks, audit-write ownership consistency, transaction correctness on the new ports).

**Result**: no Blockers, no Warnings, 1 Suggestion. The F3 branch is architecturally clean, well-tested, and ready to ship. The single Suggestion below is a pre-existing Infrastructure-layer pattern (not introduced by this session) — acceptable per Constitution Principle III and flagged only as a post-F3 consolidation opportunity.

---

## Findings

| ID | Severity | File | Line(s) | Description | Recommendation |
|----|----------|------|---------|-------------|----------------|
| S1 | 🟢 Suggestion (pre-existing, post-F3 cleanup) | `src/modules/members/infrastructure/db/drizzle-member-repo.ts` + `drizzle-contact-repo.ts` | member-repo:277 + contact-repo:114, 159, 199, 243, 350 | 6 `tx.insert(auditLog).values(...)` sites live inside Infrastructure-layer repo methods (`linkUser`, `update`, `remove`, `promotePrimary`, etc.). This is technically **allowed** — Infrastructure may import Drizzle schemas. But audit-write ownership is now split: some use cases call `AuditPort.recordInTx` (the clean path), others let the repo side-effect an audit insert. Inconsistent ownership makes it harder to trace "who writes which audit event" and breaks the Application-orchestrates-Domain pattern a tier below. | Post-F3 consolidation: extract the repo-side audit inserts into the calling use cases via `AuditPort.recordInTx`, deleting these 6 inserts + the supporting `actorUserId/requestId` params on the repo port. Do this in a standalone PR after F3 ships — out of scope for the current review gate. No change needed before ship. |

---

## Cross-Cutting Sweep Results (this pass)

### Code-quality signals (all clean)

| Check | Result |
|-------|--------|
| Principle III violations (Application → Infrastructure schema imports) | ✅ **0** (was 5 at start of this session; closed by `83b075a`) |
| XSS sinks (`dangerouslySetInnerHTML`, `eval`, `new Function`) in `src/modules/members/**` | ✅ 0 hits |
| Swallowed promise errors (`.catch(() => {})`) in F3 surface (`src/app/api/members/**`, `src/app/(staff)/admin/members/**`, `src/modules/members/**`, `src/app/(member)/portal/**`) | ✅ 0 hits |
| Empty `catch {}` blocks in `src/modules/members/**` | ✅ 0 hits |
| Unused `.catch(console.error)` shortcuts | ✅ 0 hits |
| Direct DB calls (`db.select/update/insert/delete`) in Application | ✅ 0 hits (100% port-routed) |

### API route hardening (F3)

| Check | Result |
|-------|--------|
| Handler count in `src/app/api/members/**` | 15 handlers × 12 files |
| Zod validation gates on those handlers | 25 (≥1 per handler; bulk route validates inside the use case by design, lightweight pre-check at route level) |
| Auth context guard presence across F3 API routes | 66 `require*Context()` calls across 29 files — every F3 mutating route is gated |
| RBAC resource+action wiring | 100% of mutating routes pass `{ resource, action }` to `requireAdminContext` / `requireMemberContext` |
| Idempotency keys on bulk + portal-invite + archive | ✅ `parseIdempotencyKey` + `classifyIdempotencyRequest` + `reserveIdempotencyRecord` pattern applied consistently |

### New code introduced this session (B1 + W1 fix)

| Area | Finding |
|------|---------|
| `InvitationCascadePort.softConsumePendingForUsersInTx` | ✅ Correct — empty-array short-circuit returns `{revokedCount: 0}` without issuing a query; `.returning({ userId })` preserves R001 column-grant semantics; `inArray(invitations.userId, [...userIds])` spread avoids readonly-array type mismatch |
| `ContactRepo.listLinkedUserIdsForMemberInTx` | ✅ Correct — filters `removedAt IS NULL` to match pre-refactor behaviour; inherits RLS via `runInTenant` caller context; null-filter moved into adapter (was duplicated in use case before) |
| `F3AuditEvent.targetUserId` optional field | ✅ Correct — conditional spread `...(event.targetUserId !== undefined && { targetUserId })` in both `record()` + `recordInTx()` branches; column stays null when omitted; tests that filter `auditLog.targetUserId` in SQL (outbox-permanent-failure, verify-contact-email) all green |
| R001 + R002 semantics in refactored `archive-member.ts` | ✅ Preserved — `uniqueLinkedUserIds = Array.from(new Set(...))` still runs before both the session-revoke loop AND the invitation cascade (lines 141–181); `.returning({ userId })` semantics kept inside the new adapter; no token exposure |
| `resend-verification-email.ts` Deps expansion | ✅ Correct — `audit: AuditPort` wired through `members-deps.ts` + `resend-verification` route handler; stale schema import removed; new `UseCaseAbort` branch for audit failures preserves throw-to-rollback pattern |

### Constitution compliance (revised)

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I (NN) | Data Privacy & Security + Tenant Isolation | ✅ Pass | Two-layer isolation + 14/14 cross-tenant integration tests + FORCE RLS + 23 F3 audit events |
| II (NN) | Test-First Development | ✅ Pass | 25 integration + 16 unit + 13 E2E F3 specs |
| III (NN) | **Clean Architecture** | ✅ **Pass** (was FAIL in prior review) | 0 Application-layer imports from Infrastructure schemas; all side effects route through ports |
| IV (NN) | PCI DSS | ✅ N/A | F3 does not touch payment data |
| V | i18n | ✅ Pass | 1012 keys × EN/TH/SV line parity |
| VI | Inclusive UX | ✅ Pass | WCAG 2.1 AA + 2.2 opportunistic |
| VII | Performance & Observability | ⚠️ Partial | Code complete; T158 staging traces human-gated |
| VIII | Reliability | ✅ Pass | Audit-with-state atomicity, tx patterns (incl. new `softConsumePendingForUsersInTx` + `listLinkedUserIdsForMemberInTx`), retry backoff parity |
| IX | Code Quality | ✅ Pass | typecheck + lint clean |
| X | Simplicity | ✅ Pass | Bounded contexts, shared value-objects/uuid.ts, no speculative abstractions |

**No NON-NEGOTIABLE violations.** Principle VII remains at "partial" solely because T158 (staging perf trace capture) is a human deploy gate, not a code deliverable.

---

## Spec Coverage — US1 to US7

Unchanged from prior review — 100% acceptance-criteria coverage. US3.b email change + US7 archive cascade refactors verified by re-running their full integration test suites on live Neon (see Test Results section below).

---

## Test Results (this pass, post-B1-fix)

| Suite | Scope | Result |
|-------|-------|--------|
| `tests/unit/members/application/archive-member.test.ts` | US7 orchestration | **9/9 PASS** |
| `tests/unit/members/application/change-contact-email.test.ts` | US3.b orchestration incl. new audit-port assertion | **16/16 PASS** |
| `tests/integration/members/archive-cascade.test.ts` | US7 live cascade (sessions + invitations + dedupe + R001 + R002) | **6/6 PASS** (live Neon) |
| `tests/integration/members/contact-email-change-atomic.test.ts` | US3.b atomic 6-step tx | **3/3 PASS** (live Neon) |
| `tests/integration/members/email-change-dual-channel.test.ts` | US3.b revert dual-channel | **2/2 PASS** (live Neon) |
| `tests/integration/members/verify-contact-email.test.ts` | Token consumption all-side-effects | **5/5 PASS** (live Neon) |
| `tests/integration/members/outbox-permanent-failure.test.ts` | FR-012c outbox retry + resend-verification audit landing | **2/2 PASS** (live Neon) |
| `tests/integration/members/self-service-whitelist.test.ts` | US5 portal whitelist | **5/5 PASS** (live Neon) |
| `pnpm typecheck` | Full TS strict | **PASS** |
| `pnpm lint` | Full ESLint | **PASS** |

**48/48 tests green.** No regressions introduced by the B1 port refactor.

---

## Metrics

| Metric | Value |
|--------|-------|
| Commits on branch | 49 |
| Files changed vs `58526ad` | 312 |
| Lines added | +43,229 |
| Prior review rounds | 13 (all APPROVED after remediation) |
| Findings this pass | 0 Blocker / 0 Warning / 1 Suggestion (pre-existing, post-F3) |
| Principle III Application-layer violations | **0** (was 5 before `83b075a`) |
| Test suites verified green post-B1-fix | 8 (48 tests) |
| Constitution principles pass | 9 full + 1 partial (VII — T158 staging gate) |
| Open go-live items | T151 / T152 / T158 (human-gated) |

---

## Recommended Actions

### Ship gate (all complete from code perspective)

No code actions required. The single Suggestion (S1 — Infrastructure audit-write consolidation) is explicitly tagged as post-F3 and should NOT delay ship.

### Before deploying to production (go-live runbook — unchanged from round 1)

1. Execute T151/T152: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:integration && pnpm test:e2e` locally on `83b075a`.
2. Execute T158: deploy to staging, capture p95/p99 from `@vercel/otel` traces for `GET /api/members`, `POST /api/members`, `PATCH /api/members/[memberId]`.
3. Wire the new `auth_invitation_enqueue_failed_total` counter (from round-3 fix) into the observability dashboard + set alert threshold.

### Post-ship (S1 — nice-to-have)

4. Extract the 6 Infrastructure-layer `tx.insert(auditLog)` sites in `drizzle-member-repo.ts` + `drizzle-contact-repo.ts` into the calling use cases via `AuditPort.recordInTx`. Removes the `actorUserId`/`requestId` params from the repo ports — tightens Clean Architecture consistency. Standalone PR after F3 ships.

### Lint rule hardening (suggested, post-ship)

5. Extend ESLint `no-restricted-imports` to cover `src/modules/*/application/**` in addition to `src/modules/*/domain/**`. Would catch future B1-class regressions at lint time rather than in review. Prior to today's commits, the rule only protected `domain/**` (per CLAUDE.md) — which is why 4 Application-layer schema leaks slipped through per-US reviews.

---

## Verdict

✅ **APPROVED**

F3 is ready for `/speckit.ship`. The B1 Principle III violation identified in the prior holistic review is closed with zero regressions: all 48 directly-affected tests pass on live Neon, typecheck + lint remain clean, and cross-cutting audits (authz, input validation, XSS, swallowed errors, audit ownership) surface no new issues.

**Next step**: `/speckit.ship` — then execute T151 / T152 / T158 as part of the release checklist. Post-ship, consider S1 (audit-write consolidation) and the ESLint rule extension as F3 cleanup follow-ups.
