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
5. **Every RLS-only comment is removed.** That is every "do NOT add a tenant_id predicate" note: S-R5-6 and plans research § 7.1. #653 closes after s4.

## Not changed
- **Inserts.** They set `tenant_id` in VALUES.
- **`email_delivery_events`.** It has no `tenant_id` column; the bounce query matches on `to_email`.
- **Query-less stubs.**
