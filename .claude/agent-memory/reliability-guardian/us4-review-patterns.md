---
name: US4 Bulk+InlineEdit Review Patterns
description: Error-leak, tx-atomicity, and audit patterns found during F3 US4 round-2 re-review of bulk-action and inline-edit use cases
type: project
---

Reviewed commit a17c8a1 on branch 005-members-contacts (2026-04-16).

**Confirmed fixed (round-2)**
- Rate-limit single-enforcement: use case has no RateLimitPort; route handler only. Clean.
- archive/change_plan now use updateStatusInTx(tx) / updateFieldsInTx(tx) — inside runInTenant ambient tx. Atomic.
- send_portal_invite does NOT increment updatedCount. Audit-only branch confirmed.
- change_plan pre-txn plan lookup uses PlanLookupPort before entering runInTenant. Cross-tenant probe guarded.
- Rate-limit audit write wrapped in try/catch in route handler — failure logs warning, does not mask 429.
- Bulk server_error catch block sanitizes to 'bulk operation failed'. Clean.

**Remaining issues (post round-2)**
1. CRITICAL: inline-edit `findById` outside runInTenant — line 91 of inline-edit.ts calls `deps.memberRepo.findById(deps.tenant, memberId)` which opens its own runInTenant. The subsequent `runInTenant` for the persist+audit is a DIFFERENT connection/tx. Between the two calls another actor can mutate the row (TOCTOU / lost-update race). Fix: fetch-and-mutate must be inside a single runInTenant with `SELECT FOR UPDATE`.
2. IMPORTANT: inline-edit country/notes catch blocks (lines 203-205, 248-250) forward raw `e.message` to `InlineEditError.server_error.message` — this can include Postgres FK violation text, column names, etc. Fix: sanitize to a static string identical to the status case.
3. IMPORTANT: inline-edit `findById` error path (line 96-98) leaks `lookup: repo.unexpected` (or similar repo code) to caller as `server_error.message`. Fix: sanitize.
4. SUGGESTION: send_portal_invite audit event type reuses generic `member_updated` — should use a dedicated type e.g. `member_portal_invite_queued` for monitoring clarity.

**Known patterns in this codebase**
- runInTenant(ctx, fn) sets SET LOCAL app.current_tenant + SET LOCAL ROLE chamber_app for RLS.
- updateStatusInTx / updateFieldsInTx accept raw Drizzle tx parameter (not TenantContext) — correct pattern for in-tx writes.
- AuditPort.recordInTx(tx, tenant, event) is the canonical in-transaction audit write.
- BulkNotFoundError / BulkStateError are internal Error subclasses thrown inside runInTenant and caught in the outer try/catch to convert to Result errors — acceptable pattern (throw scoped to infrastructure boundary inside a single async fn).
- drizzle-member-repo.ts: updateStatus (standalone) vs updateStatusInTx (in ambient tx) — two variants exist correctly.
