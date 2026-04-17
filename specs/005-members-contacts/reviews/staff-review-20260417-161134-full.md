# Staff Review — F3 Members & Contacts (Full Holistic Ship Gate)

- **Feature**: 005-members-contacts
- **Branch**: `005-members-contacts`
- **Diff range**: `58526ad..HEAD` = 48 commits, 310 files, +42,841 insertions (F3 Setup+Foundational onward through round-3 follow-ups)
- **Date**: 2026-04-17 16:11 +07
- **Verdict**: ❌ **CHANGES REQUIRED** (1 Blocker, 1 Warning)

---

## Executive Summary

This is a genuine full-F3 holistic sweep (not an aggregate of prior reviews). Cross-cutting checks surfaced a **NON-NEGOTIABLE Principle III (Clean Architecture) violation in 4 Application-layer files** that slipped through the US-by-US review cadence because each prior review was siloed to a single user story. Round 6 caught the exact same anti-pattern in `verify-contact-email.ts` and added `AuditPort.recordInTx` to fix it — but 3 sibling use cases shipped later (US3.b email-change flow + US7 archive) with the same violation, plus one that bundles both a cross-module and intra-module schema import.

The violation is mechanical to fix (~30 min) and does not indicate a design flaw — `AuditPort.recordInTx` already exists and is the documented correct path. The stale comment at `change-contact-email.ts:41–44` claiming "AuditPort would start its own non-tx connection" is factually incorrect: `recordInTx(tx, ...)` takes the existing tx and preserves atomicity. This was the explicit design outcome of round 6.

All 12 prior review rounds' findings remain resolved; the holistic scan added 1 new Blocker + 1 new Warning that none of the prior per-US reviews caught.

---

## Findings

| ID | Severity | File | Line(s) | Description | Recommendation |
|----|----------|------|---------|-------------|----------------|
| **B1** | 🔴 **Blocker** (Principle III NON-NEGOTIABLE) | `src/modules/members/application/use-cases/change-contact-email.ts` | 45, 237 | Application layer imports `auditLog` Drizzle schema directly from `@/modules/auth/infrastructure/db/schema` and does `tx.insert(auditLog).values(...)`. Violates Clean Architecture (Principle III) and the Constitution v1.4.0 cross-module boundary rule (members/application reaching into auth/infrastructure). Stale justifying comment at lines 41–44 claims `AuditPort` "would start its own non-tx connection" — false, `AuditPort.recordInTx(tx, ctx, event)` exists and was added in round 6 for this exact scenario. | Replace `tx.insert(auditLog).values({...})` with `await deps.audit.recordInTx(tx, deps.tenant, { type: 'member_contact_email_changed', actorUserId, requestId, summary, payload })`. Remove the schema import + the stale comment. Add `audit: AuditPort` to `ChangeContactEmailDeps` if not already threaded. |
| **B1** | 🔴 **Blocker** | `src/modules/members/application/use-cases/revert-contact-email.ts` | 35, 175 | Same violation — direct `auditLog` schema import + `tx.insert(auditLog)`. | Same fix: use `deps.audit.recordInTx(tx, ...)` with event type `member_email_change_reverted`. |
| **B1** | 🔴 **Blocker** | `src/modules/members/application/use-cases/resend-verification-email.ts` | 26, 157 | Same violation — direct `auditLog` schema import + `tx.insert(auditLog)`. Worse: `ResendVerificationDeps` does NOT include an `audit: AuditPort` field at all (line 40–47), so the port must be added to deps first. | Add `audit: AuditPort` to `ResendVerificationDeps`. Replace the schema insert with `deps.audit.recordInTx(tx, ...)` using event type `email_verification_resent`. Update the deps wire-up in `members-deps.ts` + any test stubs. |
| **B1** | 🔴 **Blocker** (double violation — cross-module + intra-module) | `src/modules/members/application/use-cases/archive-member.ts` | 33, 34 | Two Infrastructure imports from Application: (a) `import { contacts } from '../../infrastructure/db/schema-contacts'` (intra-module Application→own Infrastructure — still a Principle III violation); (b) `import { invitations } from '@/modules/auth/infrastructure/db/schema'` (cross-module auth reach). Then does `tx.update(contacts).set(...)` and `tx.update(invitations).set(...)` inside `runInTenant`. | Add two port methods: `ContactRepo.softDeleteAllForMemberInTx(tx, memberId, now)` and a new `InvitationCascadePort.softConsumePendingForUsersInTx(tx, userIds, reason)`. Move the two direct UPDATEs into those adapters. Keep the existing `R001` column-level grant semantics — the `returning({ userId })` pattern moves into the adapter. |
| **W1** | 🟡 Warning | `src/app/api/portal/profile/route.ts` + `src/app/api/portal/contacts/invite/route.ts` | 139, 27 | Two `TODO(US5-polish): Wire withIdempotency() for full replay protection` markers on POST routes that mutate user-owned state. F9 GDPR / idempotency isn't in F3 scope, but TODO-in-production-code is a drift risk — a transient network retry on these endpoints could double-enqueue an invitation or double-apply a profile patch. | Either (a) land idempotency now as part of US5 polish, or (b) file an explicit F5/F9 follow-up task and replace the TODOs with a `// Intentionally no idempotency — tracked in <ticket>` comment so the deferral is owned. |
| — | 🟢 | `src/app/(staff)/admin/layout.tsx` | 50 | `TODO: resolve tenant name from session context when F10 ships (MTA+STD)` — documented F10 deferral, harmless hardcode of tenant display name. | Leave as-is; tenant name resolution is F10 scope. |

---

## Cross-Cutting Sweep Results (this pass)

### Code-quality signals (clean)
| Check | Result |
|-------|--------|
| `TODO\|FIXME\|HACK\|XXX` in `src/modules/members/**` | ✅ 0 hits |
| `@ts-ignore`, `@ts-expect-error`, `as any`, `as unknown as` in members module | ✅ 0 hits |
| `eslint-disable` without rationale | ✅ 0 hits (the cron-dispatch `no-restricted-imports` disable is documented) |
| `console.log/warn/error/debug` leftovers | ✅ 0 hits — all via `pino` logger |
| Direct `db.select/update/insert/delete` in Application layer | ✅ 0 hits (all via ports **except** the 4 tx.insert/update schema leaks flagged in B1) |
| `process.env.*` direct reads in members module | ✅ 0 hits — env.ts gate respected |
| Hardcoded secrets / API keys | ✅ 0 hits |
| `tests/**` isolation (shared mutable state) | ✅ `beforeEach` + `afterEach` cleanup in all integration tests inspected |

### Architecture violations caught (Principle III, B1)
| File | Layer | Violation | Round |
|------|-------|-----------|-------|
| `change-contact-email.ts:45` | Application | `import { auditLog } from auth/infrastructure` | Shipped US3.b — missed |
| `revert-contact-email.ts:35` | Application | `import { auditLog } from auth/infrastructure` | Shipped US3.b — missed |
| `resend-verification-email.ts:26` | Application | `import { auditLog } from auth/infrastructure` + no AuditPort in Deps | Shipped US3.b — missed |
| `archive-member.ts:33` | Application | `import { contacts } from own infrastructure` | Shipped US7 — missed |
| `archive-member.ts:34` | Application | `import { invitations } from auth/infrastructure` | Shipped US7 — missed |

**Why prior reviews missed this**: each round focused on its single US's functional tests and spec coverage; none ran a cross-module import audit across the full `src/modules/members/application/**` surface. The ESLint `no-restricted-imports` rule that should have blocked these is presumably scoped only to `src/modules/*/domain/**` per CLAUDE.md ("enforced by an ESLint `no-restricted-imports` rule scoped to `src/modules/*/domain/**`") — leaving Application→Infrastructure unguarded.

### Cross-module Infrastructure imports (allowed — Infrastructure-to-Infrastructure)
These are NOT violations (Infrastructure-to-Infrastructure is permitted, though architecturally questionable):
- `drizzle-timeline-repo.ts:19` — reads auth users+auditLog for timeline joins
- `auth-session-revocation-port.ts:19` — revokes sessions across bounded contexts
- `user-email-adapter.ts:22` — writes auth users row from members use cases
- `email-change-token-adapter.ts:16` — shares token table with auth
- `resend-email-port.ts:40` — writes notifications_outbox
- `drizzle-contact-repo.ts:15`, `drizzle-member-repo.ts:22`, `audit-adapter.ts:11` — append audit rows

**Suggestion (non-blocking, future hardening)**: consider promoting `auditLog`, `sessions`, `users`, `invitations`, `notifications_outbox`, `emailChangeTokens` into a shared `src/modules/shared/infrastructure/db/schema` module so Infrastructure adapters do not cross bounded contexts. This is a refactor for post-F3 cleanup, not a ship blocker.

---

## Constitution Compliance (revised)

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I (NN) | Data Privacy & Security + Tenant Isolation | ✅ Pass | Two-layer isolation + 14/14 cross-tenant integration tests + FORCE RLS + 23 F3 audit events |
| II (NN) | Test-First Development | ✅ Pass | 25 integration + 16 unit + 13 E2E F3 specs |
| III (NN) | **Clean Architecture** | ❌ **FAIL (B1)** | 4 Application files import Infrastructure schemas directly; 5 import sites + 5 tx.insert/update sites |
| IV (NN) | PCI DSS | ✅ N/A | F3 does not touch payment data |
| V | i18n | ✅ Pass | 1012 keys × EN/TH/SV line parity |
| VI | Inclusive UX | ✅ Pass | WCAG 2.1 AA + 2.2 opportunistic |
| VII | Performance & Observability | ⚠️ Partial | Code complete; T158 staging traces human-gated |
| VIII | Reliability | ✅ Pass | Audit-with-state atomicity, tx patterns, retry backoff parity |
| IX | Code Quality | ✅ Pass | typecheck + lint clean |
| X | Simplicity | ✅ Pass | Bounded contexts, shared value-objects/uuid.ts, no speculative abstractions |

**Principle III fail is NON-NEGOTIABLE per Constitution v1.4.0.** Must be fixed before ship.

---

## Spec Coverage — US1 to US7

Unchanged from the earlier rollup. 100% US acceptance-criteria coverage via automated tests. All 12 prior review rounds' findings resolved. See `staff-review-20260417-161134-full.md` history block in the reviews/ folder.

---

## Metrics

| Metric | Value |
|--------|-------|
| Diff range | `58526ad..HEAD` (F3 start → round-3 follow-ups) |
| Commits | 48 |
| Files changed | 310 |
| Lines added | +42,841 |
| Prior review rounds | 12 (all APPROVED after remediation) |
| New findings this pass | **1 Blocker (B1, 4 files) + 1 Warning (W1, 2 files)** |
| Currently open after this review | **1 Blocker + 1 Warning** |
| Constitution principles pass | 9 (Principle III fails — NON-NEGOTIABLE) |
| Tasks complete | 163 / 164 |

---

## Recommended Actions (prioritised)

### Must fix before `/speckit.ship` (🔴)

1. **B1 — change-contact-email.ts**: add/confirm `audit: AuditPort` in Deps, replace `tx.insert(auditLog).values(...)` with `await deps.audit.recordInTx(tx, deps.tenant, event)`, remove schema import + stale comment.
2. **B1 — revert-contact-email.ts**: same pattern.
3. **B1 — resend-verification-email.ts**: ADD `audit: AuditPort` to Deps (not currently present), wire via `members-deps.ts`, update test stubs, replace schema insert.
4. **B1 — archive-member.ts**: add `ContactRepo.softDeleteAllForMemberInTx(tx, memberId, now)` + `InvitationCascadePort.softConsumePendingForUsersInTx(tx, userIds, reason)`. Move the two direct UPDATEs into those adapters. Preserve `R001` column-level grant semantics.
5. Re-run typecheck + lint + affected integration tests:
   - `tests/integration/members/contact-email-change-atomic.test.ts`
   - `tests/integration/members/email-change-dual-channel.test.ts`
   - `tests/integration/members/verify-contact-email.test.ts`
   - `tests/integration/members/archive-cascade.test.ts`

### Should fix before ship (🟡)

6. **W1** — replace the two `TODO(US5-polish): Wire withIdempotency()` markers with either an implementation or an explicit tracked-follow-up ticket reference.

### Optional hardening (🟢, post-F3)

7. Promote shared schemas (`auditLog`, `sessions`, `users`, `invitations`, `notifications_outbox`, `emailChangeTokens`) into `src/modules/shared/infrastructure/db/schema` so Infrastructure adapters do not cross bounded contexts.
8. Extend ESLint `no-restricted-imports` to cover `src/modules/*/application/**` (not just `domain/**`) so future Principle III leaks are caught at lint time rather than in review.

---

## Verdict

❌ **CHANGES REQUIRED**

The F3 codebase is architecturally sound, well-tested, and has absorbed substantial review rigor. However, 4 Application-layer files directly import Drizzle schemas from Infrastructure — a NON-NEGOTIABLE Principle III violation that prior per-US reviews missed because their scope was siloed. The fix is mechanical (use the already-existing `AuditPort.recordInTx` + add 2 new port methods for the archive cascade) and should take ~1–2 hours including test updates.

**Next step**: `/speckit.fixit.run B1 Principle III audit+schema leaks` — or manual fixes following the recommended actions above. Re-run `/speckit-staff-review-run` afterwards to confirm the Blocker is closed.

After B1 is fixed, F3 will be genuinely ship-ready. The earlier holistic APPROVED verdict stands aside from this single cross-cutting finding.
