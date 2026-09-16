---
name: chamber-defect-recipes
description: Use when reviewing Chamber-OS TypeScript for defects — tenant isolation (runInTenant/RLS), audit-log truth, money/tax, Buddhist Era dates, exhaustive switches, Result refusals inside transactions. Carries the repo's recurring defect classes so a review checks them before anything else.
---

# Chamber-OS defect recipes (institutional knowledge)

Chamber-OS is a multi-tenant SaaS on Next.js 16 + Drizzle + Neon Postgres with Row-Level Security. These are defect classes that reached or nearly reached production here. Check each one explicitly when reviewing code; report every hit with `file:line`, a severity, and a concrete failure scenario (input / state → wrong outcome).

## Tenancy and transactions
- Every query inside `runInTenant(ctx, async (tx) => …)` must use that `tx`. A repository method on a `tenant_id`-scoped table that reaches for the pool-global `db` singleton gets a fresh connection without `SET LOCAL app.current_tenant`, so RLS + FORCE policies do not apply — it can read and write across tenants silently. Severity: BLOCKER (tenant leak).
- A refusal returned with `err()` from inside `runInTenant` after a write has already happened COMMITS the partial write, because `err()` is a normal return value, not a throw. Guards belong above the first write; a refusal after a write must `throw` so the transaction rolls back. Severity: BLOCKER (data integrity).
- An audit emit on a null/global tx writes nothing: no GUC + RLS + swallowed error.

## Fail-open guards
- `default: { const _exhaustive: never = x; return _exhaustive }` returns the VALUE at runtime. `never` only convinces the compiler; when an unknown variant arrives anyway (a DB enum widened without the union, a parsed string) that arm hands back the variant itself, which is truthy, so an unknown case is silently ACCEPTED rather than refused. Write `void _exhaustive; return <safe value>` or throw. Severity: HIGH.
- A guard whose test never went red has never been exercised; a port method with no test double throws inside the use case's own `catch` and the guard silently takes its fallback.

## Audit truth
- No `audit_log` row may state a role its actor did not hold. `actorRole: x ?? 'admin'` (or any hardcoded staff role in an `actorRole:` position) fabricates attribution in an append-only table. Record `?? null` — an honest null says "unknown"; a default asserts a role nobody held. Severity: HIGH.
- Audit payloads must carry the snake_case key `member_id`: the `members.last_activity_at` trigger fires only on `payload ? 'member_id'`. A camelCase `memberId` in the payload means the trigger never fires and member recency is never refreshed (two features shipped this way and it went unnoticed for months). Severity: HIGH.
- Adding an `audit_event_type` touches 5 places: domain const, pgEnum, two test counts, i18n ×3.

## Dates, money, tax
- Timestamps are stored as ISO 8601 UTC Gregorian only. Thai Buddhist Era (CE + 543) is display-only for `th-TH` surfaces; any BE value reaching a stored timestamp, a WHERE clause, or a document number is an off-by-543-years ship blocker. Severity: BLOCKER.
- Amounts are integer satang or `numeric`, never float; VAT is 7 %; §87 invoice numbering is gap-free under an advisory lock namespaced `invoicing:`; `payments:` and `broadcasts:` namespaces are disjoint and mean different things.
- Money emails address the LIVE primary contact, never the frozen `member_identity_snapshot`.

## Migrations
- Hand-written SQL only (`db:generate` abandoned at 0018). A duplicate `when` in `meta/_journal.json` makes `db:migrate` a silent no-op that still prints "✓ applied". `CREATE TRIGGER` has no `OR REPLACE` — needs `DROP TRIGGER IF EXISTS`.

## Discipline
- Verify every finding against the code before reporting it; drop what you cannot show. Prefer "X is unproven for case Y" over "X is broken". Do not report style.
