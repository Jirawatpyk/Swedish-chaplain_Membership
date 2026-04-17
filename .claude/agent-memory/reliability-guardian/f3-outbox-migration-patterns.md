---
name: F3 Outbox Migration Patterns (T049, updated 2026-04-17 commit 8e47e92)
description: Reliability patterns and gaps discovered during F3 outbox migration review — create-user atomicity, enqueue failure tolerance, dispatcher permanent-failure audit gap, change-plan atomicity
type: project
---

## CLOSED in commit 8e47e92

**C1 (outbox FOR UPDATE SKIP LOCKED outside tx):** FIXED. `dispatchOne()` in `route.ts` now wraps the entire SELECT-FOR-UPDATE + UPDATE + optional audit-insert inside `db.transaction(async tx => {...})`. All operations use `tx.` prefixed calls. Lock scope is correct.

**C2 (create-user steps 3+4 not atomic):** FIXED with compensating delete. `create-user.ts` catch on `tokens.createInvitation` failure calls `deps.users.deletePending(user.id)`. The `deletePending` implementation in `user-repo.ts` executes `DELETE ... WHERE id=? AND status='pending'` — atomic at DB level; race with `redeemInvite` (which flips status to active) is correctly handled by the WHERE guard. Compensating delete failure is also caught and logged, not swallowed.

**C3 (change-plan non-atomic update + 2 audit writes):** FIXED. `change-plan.ts` wraps all writes in `runInTenant(deps.tenant, async tx => {...})` using `updateFieldsInTx` + `audit.recordInTx`. `TxAbort` sentinel is caught outside the `runInTenant` call and mapped to `server_error`. Non-TxAbort exceptions re-throw (infra failures bubble up as expected). `audit_failed` returns `server_error` — no silent swallow.

**H1+H4 (enqueue suppressed cause + raw DB exception leak):** FIXED. `create-user.ts` logs `errCause: enqueueResult.error.cause`. `auth-deps.ts` `enqueueInvitation` catch sanitises: `cause: e instanceof Error ? e.message : String(e)` — no raw DB exception object propagates.

**H2 (tenant_id=null audit drift):** FIXED. `emitDispatchFailedAudit()` helper checks `row.tenantId`; null falls back to `logger.error` with `cron.outbox_dispatch.permanent_failure_no_tenant` tag. Inline permanent-failure path in `dispatchOne` has same null-guard pattern.

**H3 (no_template_handler permanent had no audit):** FIXED. `dispatchOne` on `isPermanent` for the no-payload path inserts `email_dispatch_failed` audit INSIDE the tx when `row.tenantId` is present; null falls back to error log. Fully in-transaction with status flip.

**H5 (invite-colleague audit.record non-tx silent-swallow):** FIXED. `invite-colleague.ts` checks `auditResult.ok`; on failure logs the error and returns `err({ type: 'server_error', message: ... })`. No silent swallow.

## STILL OPEN / RESIDUAL

**invite-portal.ts linkUser failure → returns ok():** `invite-portal.ts` line 127-140: when `contactRepo.linkUser` fails, it logs the orphan but still returns `ok(...)`. This is a documented design decision (invitation email already in-flight, redemption path sets link separately). Not a new gap introduced by this patch — pre-existing accepted risk. Monitor for orphan reconciliation tool in backlog.

**invite-colleague.ts audit is not in-transaction with add+linkUser:** `invite-colleague.ts` calls `deps.contactRepo.add()` (own tx), `deps.contactRepo.linkUser()` (own tx), then `deps.audit.record()` (separate write). If audit fails, state is committed without `contact_created` event. The code catches this and returns `server_error`, so the caller surfaces the issue — but the state change is already committed and unrecoverable from the audit perspective. Partially mitigated (not silently swallowed), but not fully atomic. Pre-existing pattern; not introduced by 8e47e92.

## NEW (introduced by 8e47e92)

**dispatchOne tx holds row lock during Resend HTTP call:** Intentional and documented in comments (line 280-284). Acceptable at <50 emails/day; if throughput grows, switch to claim+release pattern. No action needed now.

**`plan_bundle_changed` audit event type:** `change-plan.ts` emits `plan_bundle_changed` as a secondary event (line 213) inside the tx. This event type is not listed in the 23 F3 audit event types in CLAUDE.md. May be an unregistered type — should confirm it is in the audit_events allowed-types enum/check constraint in the schema.
