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
| s6 | `3d78be87c` | `contact-change-request-repos-tenant-sql-shape.test.ts`: 22 violations in the contact repo (every contacts read/update outside `findByEmail` and the opt-out batch), 21 in the change-request repo (the request reads/updates, and the list join's `members` + `contacts` with an unfenced root), 1 hand-written block (the tombstone `contacts c` / `peer`), 22 unfenced `.where(` in the contact source |
| s7 | `e7a9b6c4f` | 10 cases across 5 gate files: tier-upgrade (9 violations: every read but `findPendingForCycle` and the CAS pair, incl. both orphan-detection joins), plan lookup (5 `membership_plans` reads), the scorer's `members` read, attendances (`event_registrations` + `events`), both buyer-PII tombstone UPDATEs, `processor_events` `markProcessed`/`updateOutcome`, plus 7 tier-upgrade and 1 attendances unfenced `.where(` |

Mutation proof for s1: from the committed GREEN, deleting `eq(contacts.tenantId, tenant.slug)` in `drizzle-bounce-event-query.ts` turned the gate red (`contacts: 1 reference(s), 0 tenant predicate(s)`); restoring it turned the gate green again.

Mutation proof for s2: from the committed GREEN, deleting `eq(renewalCycles.tenantId, tenantSlug)` in `countSettledCyclesForMember` turned the gate red (`renewal_cycles` + `linked_invoice` unfenced); restoring it turned the gate green again.

s2 checker change: correlations now resolve to a fixpoint, so a chain (`credit_notes` → `linked_invoice` → `renewal_cycles` = $tenant) passes while a ring with no bound tenant still fails. Advisory-lock statements (`select pg_advisory…`) name no table and are not reads.

Known gate limit (s2): `recordingDb` answers no rows, so a statement that runs only after an earlier one returns rows is never recorded. s2 closed it by scanning every `.where(` and raw `FROM ${table}` in the file by hand; two such reads on `renewal_reminder_events` were fenced that way.

s2 review (#657): the call-map now pins every optional filter OFF (the default page path) with a separate filter-ON case; the advisory-lock skip matches the exact lock statement only; and a source scan asserts every `.where(` in the cycle repo names `tenant_id` or is one of the composed filter lists the call-map proves — this closes the row-dependent blind spot for this file (mutation-proved on the `reanchorPeriodInTx` DELETE). Not changed: 11 pre-existing sites bind `tenant_id` to the method's `tenantId` argument rather than `tenant.slug`; financial-integrity-reviewer traced every caller and both values are always the same tenant.

s3 notes: the at-risk factor SQL's invoices LATERAL named `tenant_id` bare (`WHERE tenant_id = m.tenant_id`); it is now qualified (`invoices.tenant_id`) — same meaning, visible to the checker. `listActiveMemberIdsForAtRiskRecompute`'s EXISTS over `renewal_cycles` correlated by `member_id` only and now also by `tenant_id`. The escalation `list` had a branch that issued no WHERE when no filter was set; both branches are now one query that always carries the tenant.

Mutation proof for s6: from the committed GREEN (`7dc314342`), deleting `eq(contacts.tenantId, tenantSlugOf(tx))` in `scrubPiiForMemberInTx` and `f.tenant_id = ${tenant} AND` in `decideInTx`'s raw UPDATE turned three gate cases red (the contacts call map, the raw-SQL scan, the `.where(` scan); restoring both with `git checkout --` turned the gate green again (6/6).

s6 notes: both repos are module singletons whose `*InTx` methods receive only `tx`, so a tx-only method binds `tenantSlugOf(tx)` (D-030) and keeps its port signature; `updateEmailInTx`'s unused `_ctx` is now the predicate's source. The change-request list join correlates `members` and `contacts` by `tenant_id` to the fenced request root. `loadFields` (row-dependent, never recorded) is covered by the `.where(` scan. The fail-loud contact unit test binds its fake tx, since an unbound tx now throws `TenantTxNotBoundError` before the SELECT.

s6 review (#664): code-review, security-engineer and pdpa-gdpr-compliance-officer found no blocker. Fixed with RED `414ae67f7` → GREEN `7a43ce583`: tx-only methods resolve `tenantSlugOf(tx)` before the try (an unbound tx now throws `TenantTxNotBoundError`, not `repo.unexpected`); `updateEmailInTx` and `addInTx`'s carried opt-out read take the tx's tenant, not the caller's ctx / `draft.tenantId`; the change-request helpers read the slug from the tx; the gate pins exact statement counts and adds a tx-tenant-vs-argument case and an unbound-tx case. Mutation proof: moving `updateInTx`'s `tenantSlugOf` back inside the try turned the unbound-tx case red; restoring it turned the gate green (8/8). The members adapters (`change-request-scrub-adapter`, `outbox-cancel-adapter`) are still RLS-only — handed to s5.

Mutation proof for s7: from the committed GREEN (`e2d24c42f`), each of these turned its gate red and restoring it turned the gate green again:
- deleting the tenant predicate in tier-upgrade `findById`;
- deleting it in the per-member scorer's `membership_plans` read (source scan);
- deleting it in the invoices tombstone UPDATE (call and source scan);
- deleting it in the attendances read;
- deleting `eq(broadcasts.tenantId, tenantId)` from `adminQueueListQuery`;
- deleting the first `eq(invoices.tenantId, tenantIdArg)` from an invoice-repo `filters` list.
- deleting the `tenantSlugOf(tx)` predicate from `markProcessed` (from the committed `e61f003c4`).
- deleting `b2.tenant_id = …` from the broadcasts custom-recipient redaction UPDATE (new runtime case).

The broadcasts and invoice-repo gates had no RED, because neither repo needed a change; these mutations are their evidence.

s7 notes:
- **Checker.** The checker read `IS DISTINCT FROM "t"."col"` (the tier-upgrade orphan query) as a table reference; `TABLE_REF` now skips it, and `checker.test.ts` has a case for it.
- **Static scans.** `unfencedRawSql` stops at a nested backtick, so the broadcasts redaction UPDATE (`sql.join` of `sql` fragments) is pinned by its truncated prefix; both of its refs bind `tenant_id`.
- **Exemptions.** The cross-tenant reads are listed in spec § Not changed, and each gate pins them as the file's only unfenced statements.
- **`processor_events` writes.** `markProcessed` and `updateOutcome` receive only a tx, so they bind the tenant through `tenantSlugOf(tx)` (D-030) rather than a widened port. Every caller reaches them through `paymentsRepo.withTx`, which is `runInTenant`. A tx that `runInTenant` did not open is refused before any SQL.
- **Review round (#663).**
  - **A miss caught by review.** The review's completeness check found one statement the slice inventory missed: `drizzle-tier-upgrade-eval-candidate-repo.ts` `list` roots on `members` with no bound tenant predicate (its subqueries correlate to `members.tenant_id`). RED is `b8e902c56`, with 8 violations across the first page and the cursor page, and the root predicate is now added.
  - **Comments.** The remaining RLS-only comments in the s1–s3 renewals files now cite D-029.
  - **Single tenant source.** The scorer binds every predicate to the same `tenantId`. This uses the method argument rather than the factory slug (§ Approach) because its three existing predicates already did; every caller passes the adapter's own tenant.
  - **Broadcasts.** The broadcasts redaction UPDATE now has a runtime gate case.
- **Completeness scan.** Outside `members/` and `plans/`, every `.from/.update/.delete` on a tenant table whose `.where(` lacks the root's own `tenantId` was checked by hand. Each is either a composed list led by the tenant predicate or one of the § Not changed exemptions. One limit remains: a statement whose subqueries mention `tenantId` while the root does not passes a text scan; only the recording-db gates catch that. Checked by hand: every `exists(` / `notExists(` subquery in infrastructure outside `members/` and `plans/` sits in a file with a call-map gate, or is on tables with no `tenant_id` (`user-repo`); none other was found.
