# 130 — An explicit `tenant_id` predicate on every tenant-scoped statement (issue #653)

**Size**: L, sliced per D-020 into `130-tenant-predicate-sweep-s1` … `s4`. No migration, no flag, no new dependency.
**Status**: s1 built 25 Oct 2026.
**Decision**: D-029 (the maintainer chose the explicit-predicate reading, 2026-10-25).

## Done when
1. **D-029 is recorded**, and `.claude/rules/architecture.md` names the gate.
2. **A shared gate (`tests/helpers/tenant-sql-shape.ts`) checks the SQL a repo actually sends.**
   - It covers both builder and hand-written statements.
   - Every reference to a table with a `tenant_id` column carries its own predicate, either bound or correlated to a fenced table.
   - The checker has its own positive and negative controls.
3. **Each swept repo has a gate test.** That test proves every listed method reached the database and that the parse found a table, and it has been mutation-proved.
4. **Slices:**
   - **s1:** reminder events, dispatch candidates, schedule policy, at-risk outreach read, the bounce query's `contacts` read.
   - **s2:** `drizzle-renewal-cycle-repo.ts`.
   - **s3:** `drizzle-member-renewal-flags-repo.ts` and `drizzle-renewal-escalation-task-repo.ts`.
   - **s4:** plans (`plan-repo.ts`, `drizzle-scheduled-plan-change-repo.ts`) and the member-plan adapters' members-repo calls.
   - **s7:** the renewals leftovers (tier-upgrade suggestions, plan lookup for renewal, the per-member at-risk scorer), `processor_events` (`markProcessed` / `updateOutcome` gain a `tenantId` argument), the attendances read, and the buyer-PII redaction UPDATEs. The csv-import, broadcasts and invoice repos needed no change; source-scan gates pin their exemptions.
5. **Every RLS-only comment is removed.** That is every "do NOT add a tenant_id predicate" note: S-R5-6 and plans research § 7.1. #653 closes after the last slice (s7) merges.

## Not changed
- **Inserts.** They set `tenant_id` in VALUES.
- **`email_delivery_events`.** It has no `tenant_id` column; the bounce query matches on `to_email`.
- **Query-less stubs.**
- **Cross-tenant by design (s7).** These run before the tenant is known, or as the owner role across tenants, and stay global:
  - `renewals/infrastructure/lookup-member-by-email.ts`: both reads. The Resend webhook resolves an email to its tenant.
  - `drizzle-processor-events-repo.ts`: `insertIfNew`'s duplicate read and `findById`. These are the webhook's pre-resolution idempotency probes, and the row may have a NULL tenant.
  - `drizzle-tenant-payment-settings-repo.ts`: `findByProcessorAccountId`. The Stripe account id is the lookup key.
  - `drizzle-csv-import-records-repo.ts`: the admin repo (`findByIdAcrossTenants`, `listExpiredErrorCsvBlobsAllTenants`). These are the blob-expiry cron and the cross-tenant id lookup.
  - `drizzle-broadcasts-repo.ts`: `findByResendBroadcastIdBypassRls` and `findBroadcastByResendAudienceIdsBypassRls`. These are Resend webhook pre-resolution reads.
  - `auth/infrastructure/db/user-repo.ts`: `deleteInviteOutboxByEmailAllTenantsInTx`. It is its only `notifications_outbox` statement; `users` and `invitations` have no `tenant_id` (D-026).
