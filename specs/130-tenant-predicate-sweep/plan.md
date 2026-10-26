# 130 — Plan

## Approach
- **The predicate value.** Use the repo factory's `TenantContext` slug, the same value `runInTenant` sets for RLS, so the two walls cannot disagree. Do not use the unused `_tenantId` port argument.
- **The gate.** `recordingDb()` is a `drizzle-orm/pg-proxy` db that records each statement and answers with no rows. It has no transactions, so the test passes the db in as the `tx`.
  - `tenantScopedTables()` reads every `/src/modules/**/schema*.ts` table that has a `tenant_id` column.
  - `tenantPredicateViolations()` counts each FROM / JOIN / UPDATE reference against its `"ref"."tenant_id" = $n`, or a correlation to another ref's `tenant_id`.
- **The insights SQL-shape test stays as it is.** Its quoted-name parse is its positive control. The new checker generalises it to bare names and aliases.

## Evidence

| Slice | RED commit | Failing line |
|---|---|---|
| s1 | `63d1893fd` | `small-repos.test.ts`: `expected [ …(7) ] to deeply equal []` (reminder events), `[ …(3) ]` (dispatch), `[ …(2) ]` (schedule policy), and 1 each for the at-risk read and the bounce `contacts` read |
| s2 | `3b944ad36` | `cycle-repo.test.ts`: 51 violations (renewal_cycles reads/updates/locks; members, invoices and credit_notes joins whose root was unfenced) |
| s2 | `c1fe40629` | the month-filtered `loadPipelinePage` branch (6 refs) and `pruneOlderThan`'s DELETE on `consumed_link_tokens` — found by hand-scanning the branches the call map cannot reach |
| s3 | `28772a9e8` | `flags-escalation-repos.test.ts`: 24 violations in the member renewal-flags repo (members reads/updates, the at-risk factor CTE root `m`, the bulk risk UPDATE, the widget summary), 12 in the escalation-task repo (incl. `list`'s no-filter branch with no WHERE at all), 23 unfenced `.where(` in source |
| s5 | `d962bd715` | `member-repo-tenant-sql-shape.test.ts`: 36 violations in the member repo with every filter OFF and 27 with them ON (members reads/updates, the directory and broadcast roots, the stuck-erasure root `m`, uncorrelated `contacts` joins), 7 in the adapters (change-request scrub, token `…InTx`, plan lock, plan count), 31 unfenced `.where(`; 6 methods sent no statement (the old `tx`-only signatures) |
| s5 (D-030) | `036554e13` | the same gate with the recording db bound by `bindTenantTx` and the original `tx`-only call shapes: the 10 member-repo tx-only methods (`[ 'findByIdInTx', …(9) ]`) and the adapters' tx-only methods read a shifted argument as the tenant and sent no statement; a tx `runInTenant` did not open still sent a statement (`expected [ { …(2) } ] to deeply equal []`) |
| s5 (outbox) | `6df758488` | `outbox-cancel-adapter.ts` (flagged by s6's PDPA review): both erasure DELETEs on `notifications_outbox` and their `contacts` peer-ownership guards named no `tenant_id` (`unfencedRawSql` 2, plus the call-map violations) |

Mutation proof for s1: from the committed GREEN, deleting `eq(contacts.tenantId, tenant.slug)` in `drizzle-bounce-event-query.ts` turned the gate red (`contacts: 1 reference(s), 0 tenant predicate(s)`); restoring it turned the gate green again.

Mutation proof for s2: from the committed GREEN, deleting `eq(renewalCycles.tenantId, tenantSlug)` in `countSettledCyclesForMember` turned the gate red (`renewal_cycles` + `linked_invoice` unfenced); restoring it turned the gate green again.

s2 checker change: correlations now resolve to a fixpoint, so a chain (`credit_notes` → `linked_invoice` → `renewal_cycles` = $tenant) passes while a ring with no bound tenant still fails. Advisory-lock statements (`select pg_advisory…`) name no table and are not reads.

Known gate limit (s2): `recordingDb` answers no rows, so a statement that runs only after an earlier one returns rows is never recorded. s2 closed it by scanning every `.where(` and raw `FROM ${table}` in the file by hand; two such reads on `renewal_reminder_events` were fenced that way.

s2 review (#657): the call-map now pins every optional filter OFF (the default page path) with a separate filter-ON case; the advisory-lock skip matches the exact lock statement only; and a source scan asserts every `.where(` in the cycle repo names `tenant_id` or is one of the composed filter lists the call-map proves — this closes the row-dependent blind spot for this file (mutation-proved on the `reanchorPeriodInTx` DELETE). Not changed: 11 pre-existing sites bind `tenant_id` to the method's `tenantId` argument rather than `tenant.slug`; financial-integrity-reviewer traced every caller and both values are always the same tenant.

s3 notes: the at-risk factor SQL's invoices LATERAL named `tenant_id` bare (`WHERE tenant_id = m.tenant_id`); it is now qualified (`invoices.tenant_id`) — same meaning, visible to the checker. `listActiveMemberIdsForAtRiskRecompute`'s EXISTS over `renewal_cycles` correlated by `member_id` only and now also by `tenant_id`. The escalation `list` had a branch that issued no WHERE when no filter was set; both branches are now one query that always carries the tenant.

Mutation proof for s5 (re-run from the committed D-030 GREEN `5bcf4a740`): deleting `eq(contacts.tenantId, ctx.slug)` from `searchDirectory`'s primary-contact follow-up (a read that only runs once a page has rows, so the recorder never sees it) turned the source scan red; deleting `eq(members.tenantId, tenantId)` from `findByIdInTx` turned the call-map red (`members: 1 reference(s), 0 tenant predicate(s)`); removing `bindTenantTx` from the test's db mock turned every tx-only method silent (`expected [ 'findByIdInTx', …(10) ] to deeply equal []`), so the gate guards the binding as well as the predicate. Restoring each turned the gate green again.

s5 notes: the member repo is a singleton, not a factory, so its ten `…InTx` methods that took only `tx` (and the change-request scrub, email-token, plan-lock `…InTx` methods, `countActiveMembersOnPlanInTx` and `buildBroadcastRecipientContactsQuery`) had no tenant to bind. The slice first widened them to `(tx, tenantId, …)` (`5fed103c8`); D-030 (#660) landed mid-slice, and that widening is withdrawn in `5bcf4a740`: each method reads `tenantSlugOf(tx)`, so no port signature or caller changed. No production path hands these methods a tx that `runInTenant` did not open (grepped every `db.transaction` / savepoint `tx.transaction` site), so failing closed changes no live behaviour. The gate wraps `callEach` so a method that sends no statement fails. Exempt by exact method, because they run before any tenant is known: `resolveBouncedInviteContacts` and the token adapter's `findActiveById` (spec § Not changed). `member_timeline_v` is a view, so the timeline case asserts its own bound `tenant_id = $n` instead of the checker. `getPlan` delegates to the plans repo (s4's gate), mocked here. `email_change_tokens` has had RLS + FORCE since migration 0097; the port comment that said it had none is corrected.

s5 outbox-cancel: each DELETE now states `o.tenant_id = tenantSlugOf(tx)` and the two `contacts` anti-joins correlate `c.tenant_id = o.tenant_id`. Mutation proof from the committed GREEN: dropping `c.tenant_id = o.tenant_id` turned the call-map red; restoring it turned it green. The other members adapters' unfenced `.where(` read only platform tables (`sessions`, `invitations`, `users`).
