# Research — F2 Membership Plans

**Feature**: F2 Membership Plans
**Branch**: `002-membership-plans`
**Date**: 2026-04-11
**Resolves**: all `NEEDS CLARIFICATION` markers and open implementation decisions from `plan.md` Phase 0

---

## 1. Tenant-context resolver + Clean-Architecture integration

**Decision**: Introduce `TenantContext` as a **Domain-layer branded type** (Clean Architecture Principle III compliant) that every plans Application use case takes as an **explicit dependency parameter**, not an implicit middleware magic. **Per critique E1/X2 (2026-04-11), the type lives in a new `src/modules/tenants/` cross-cutting Domain-only module — NOT inside `src/modules/plans/domain/`** — because `TenantContext` is a platform-level concept that F3 members, F4 invoices, F7 broadcasts, etc. will each need to import without reaching across sibling bounded-context boundaries. The concrete resolver lives in `src/lib/tenant-context.ts` and, for the SweCham single-tenant deployment, returns a constant slug read from `process.env.TENANT_SLUG` (zod-validated in `src/lib/env.ts`).

**Rationale**:

- Constitution v1.4.0 Principle I clause 1 explicitly forbids string-typed tenant IDs passed as implicit parameters: *"A use case that forgets to pass `tenantId` is a bug and MUST fail at compile time via the Domain-layer `TenantContext` type."* A branded type is the only way to satisfy this at compile time.
- Principle III (Clean Architecture) forbids Application-layer code from reading middleware-injected globals (those are Infrastructure concerns). Passing `TenantContext` as an explicit parameter preserves the dependency rule: Presentation → Application ← Domain ← Infrastructure (via ports).
- Placing `TenantContext` in a **separate cross-cutting module** (not inside `plans/domain`) is required because F3+ features must be able to import it without the `no-restricted-imports` ESLint rule blocking `@/modules/plans/domain/*` deep imports. Siblings exporting a cross-cutting type through their own barrel would be an anti-pattern (plans does not own the concept of "tenant").
- A constant-returning resolver is the simplest implementation of a real interface and survives the F10 retrofit: F10 will replace the constant with subdomain / custom-domain / signed-header parsing without touching a single plans use case. The use cases already take `TenantContext`; they don't care how it was resolved.

**Implementation sketch**:

```typescript
// src/modules/tenants/domain/tenant-context.ts  (NEW cross-cutting Domain module)
declare const tenantContextBrand: unique symbol;
export type TenantContext = {
  readonly slug: string;
  readonly [tenantContextBrand]: true;
};
export function asTenantContext(slug: string): TenantContext {
  // validation: non-empty, lowercase, [a-z0-9-], max 63 chars
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) {
    throw new Error(`Invalid tenant slug: ${slug}`);
  }
  return { slug, [tenantContextBrand]: true } as TenantContext;
}

// src/modules/tenants/index.ts — public barrel
export { asTenantContext, type TenantContext } from './domain/tenant-context';

// src/lib/tenant-context.ts  (Infrastructure — converts request → TenantContext)
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
export function resolveTenantFromRequest(_req: Request): TenantContext {
  // F2: constant tenant from env. F10: parse subdomain / custom domain / header.
  return asTenantContext(env.TENANT_SLUG);
}

// src/modules/plans/application/list-plans.ts
import type { TenantContext } from '@/modules/tenants';
export async function listPlans(
  input: ListPlansInput,
  deps: { planRepo: PlanRepo; tenant: TenantContext; clock: Clock; audit: AuditPort },
): Promise<Result<PlanSummary[], ListPlansError>> {
  // deps.tenant cannot be forgotten — TypeScript refuses to compile
}
```

**Alternatives considered**:

- **Middleware-injected AsyncLocalStorage** (global context, read by use cases via a helper). Rejected — violates Principle III (Application layer reads a global) and is hard to test without a running request. Domain cannot detect misuse at compile time.
- **String `tenantId: string` parameter on every use case**. Rejected — typos or "just for now" missing arguments compile fine. The branded type is strictly better for the same cost.
- **A `TenantService` domain service that ambient-resolves from context**. Rejected — adds indirection for zero benefit in a single-tenant deployment and still requires compile-time detection work elsewhere.
- **`TenantContext` type inside `plans/domain`** (earlier plan design, superseded by critique E1/X2). Rejected — `TenantContext` is cross-cutting, not plans-owned; placing it there would force F3+ features to either deep-import into `plans/domain` (blocked by ESLint) or export it via the plans barrel (wrong ownership).

### 1.1 F10 migration path (critique E2, 2026-04-11)

When multi-tenant onboarding ships in F10, the resolver swap is the **only** code change required — every use case already takes `TenantContext` as an explicit dependency:

1. F10 adds an optional `active_tenant_id` claim to the F1 session cookie via an additive schema change (F1's session table gains a nullable column; no breaking change).
2. F10 creates the real `tenants` + `user_tenants` join tables and a `/switch-tenant` UI that updates the claim and re-issues the session cookie.
3. F10 rewrites `src/lib/tenant-context.ts` to parse subdomain / custom domain / `active_tenant_id` claim and return the resolved `TenantContext`.
4. F10 updates `TENANT_SLUG` env var handling — if unset AND the session has no `active_tenant_id`, the resolver throws `NoActiveTenant` → routes return a "pick a tenant" page.
5. **Zero changes** to `src/modules/plans/**`, `src/modules/tenants/domain/**`, or any other F2+ module's use cases. The compile-time contract stays identical.

This migration path is the reason `TenantContext` is a Domain branded type rather than a raw string: the swap is localised to one file (`src/lib/tenant-context.ts`), not distributed across every use case.

---

## 2. Postgres Row-Level Security — implementation pattern

**Decision**: **Enable RLS on every F2-introduced table** (`membership_plans`, `tenant_fee_config`) and add a `tenant_isolation` policy that reads from `current_setting('app.current_tenant', TRUE)`. Every tenant-scoped transaction is wrapped by a `runInTenant(tenantId, fn)` helper in `src/lib/db.ts` that issues `SET LOCAL app.current_tenant = $1` before the callback runs. Migration `0006_plans_and_fee_config.sql` includes the `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` statements as part of the same atomic migration as the table creation — no "table created without RLS even for a moment" window exists.

**Rationale**:

- Constitution v1.4.0 Principle I clause 2 mandates database-layer enforcement with exactly this pattern: *"enforces `tenant_id = current_setting('app.current_tenant')`. The application layer MUST `SET LOCAL app.current_tenant` per connection before running queries."* There is no interpretive room.
- `SET LOCAL` scopes the setting to the current transaction; on commit / rollback it is reset. This matches how Drizzle + `drizzle-orm/node-postgres` already opens transactions, so the existing `db.transaction(fn)` call site becomes `runInTenant(tenantCtx, (tx) => db.transaction(tx, fn))` — minimal code churn.
- `TRUE` as the second argument to `current_setting` returns `NULL` if unset (rather than raising). Combined with a policy like `USING (tenant_id = current_setting('app.current_tenant', TRUE))`, an unset session variable results in **zero visible rows** — a hard-fail default that is safer than a soft-fail or exception.
- Placing RLS migration in the same file as table creation means a rollback + redeploy is atomic. There is never a deployed state where the table exists without the policy.

**pgBouncer / connection-pooling consideration**:

Neon uses pgBouncer in transaction mode by default. `SET LOCAL` works correctly with transaction-mode pooling because it is scoped to a transaction (pgBouncer returns the backend to the pool only after `COMMIT` / `ROLLBACK`, so the setting cleans up naturally). **A session-level `SET` (without `LOCAL`) would be a bug** — the next request using that pooled connection would inherit the setting and could read the wrong tenant's data. The `runInTenant` helper will **only** use `SET LOCAL` and will assert in code review that no session-scoped variant exists.

**Alternatives considered**:

- **Application-layer filter only** (every query has `WHERE tenant_id = ?`). Rejected — violates Principle I clause 2 (database-layer enforcement is NON-NEGOTIABLE when multi-tenant). One forgotten `WHERE` clause is an existential-risk leak. Not a live option.
- **Schema-per-tenant**. Rejected by `docs/saas-architecture.md` § 3 — migration complexity, operational cost, no benefit for <100 tenants.
- **Database-per-tenant**. Rejected by `docs/saas-architecture.md` § 3 — $25/mo/DB, unit economics fail.
- **A wrapper view + `SECURITY BARRIER`** instead of RLS. Rejected — RLS is the Postgres-native mechanism and is explicitly referenced by the Constitution; views add a layer without a security benefit.

### 2.3 Every tenant-scoped read opens its own explicit transaction

A subtle but critical rule (verification plan in § 2.4): **every tenant-scoped query path MUST go through `runInTenant(ctx, fn)` which opens an explicit `db.transaction()` and issues `SET LOCAL app.current_tenant` as its first statement inside that transaction.** Running a query "outside" an explicit transaction on Neon's serverless driver can land on a pooled connection whose prior `SET LOCAL` value has been cleared (correct per transaction-scoping) but whose implicit transaction does not carry forward any setting from a prior `runInTenant` call. Result: silent zero rows.

Enforcement:
1. `src/lib/db.ts` exports `runInTenant(ctx, fn)` — no alternative `query()` helper that bypasses the wrapper exists.
2. ESLint rule (lint plugin we already own): forbid direct use of `db.select / db.insert / db.update / db.delete` outside `src/modules/*/infrastructure/**`, which forces all queries through repo functions that in turn require a `TenantContext`.
3. Contract tests assert that any call site missing the `TenantContext` parameter fails to compile.

### 2.4 Neon verification plan (critique E3, 2026-04-11)

**Before `/speckit.tasks` commits implementation tasks, verify empirically that the `SET LOCAL` pattern behaves as expected on Neon Singapore + Vercel serverless.** A throwaway smoke test runs manually (or as a one-time CI job) against the dev Neon database:

```typescript
// scripts/verify-rls-set-local.ts — one-time verification, delete after committing the research receipt
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

async function main() {
  // Step 1: Insert a tagged row via runInTenant
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant = 'verify-a'`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS _rls_probe (tenant_id text not null, val text)`);
    await tx.execute(sql`ALTER TABLE _rls_probe ENABLE ROW LEVEL SECURITY`);
    await tx.execute(sql`DROP POLICY IF EXISTS p ON _rls_probe`);
    await tx.execute(sql`CREATE POLICY p ON _rls_probe USING (tenant_id = current_setting('app.current_tenant', true))`);
    await tx.execute(sql`INSERT INTO _rls_probe (tenant_id, val) VALUES ('verify-a', 'a-row')`);
  });

  // Step 2: Read WITHOUT setting app.current_tenant — expect zero rows
  const noTenant = await db.execute(sql`SELECT * FROM _rls_probe`);
  console.log('[test] no-tenant select returned:', noTenant.rows.length, 'rows (expect 0)');

  // Step 3: Read WITH correct tenant in a new transaction — expect 1 row
  const withTenant = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant = 'verify-a'`);
    return tx.execute(sql`SELECT * FROM _rls_probe`);
  });
  console.log('[test] with-tenant select returned:', withTenant.rows.length, 'rows (expect 1)');

  // Step 4: Read WITH wrong tenant — expect zero rows
  const wrongTenant = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant = 'verify-b'`);
    return tx.execute(sql`SELECT * FROM _rls_probe`);
  });
  console.log('[test] wrong-tenant select returned:', wrongTenant.rows.length, 'rows (expect 0)');

  // Cleanup
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant = 'verify-a'`);
    await tx.execute(sql`DROP TABLE _rls_probe`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
```

**Expected outputs**:
- Step 2: `0 rows` — confirms that a query outside `runInTenant` gets NULL `app.current_tenant` and RLS returns zero rows (the "secure by default" path).
- Step 3: `1 row` — confirms that `SET LOCAL` inside a transaction makes the row visible.
- Step 4: `0 rows` — confirms that cross-tenant reads return zero rows, not an error.

**What to do with the results**:
- If the script matches the expected outputs → proceed with `runInTenant` pattern as designed. Commit a short note in research.md § 2.4 — "Verified on Neon Singapore 2026-04-12, expected outputs produced" — and delete the script.
- If Step 2 returns 1 row → the Neon serverless driver is NOT clearing `app.current_tenant` between request-level queries. Pivot to **hard-wire** `runInTenant` around every query path (no exceptions) + add an integration test that asserts the "no-tenant query returns zero rows" invariant.
- If Step 3 returns 0 rows → `SET LOCAL` is not effective inside Drizzle's transaction wrapper. Diagnose + fall back to raw SQL `BEGIN; SET LOCAL …; SELECT …; COMMIT;` patterns. Update research.md.

This verification is not optional — it is a 30-minute empirical check that unblocks a load-bearing architectural decision. `/speckit.tasks` can proceed before the script runs, but the first implementation task is "run verify-rls-set-local.ts and commit the research.md receipt".

### 2.5 Dev-mode RLS-state assertion (critique E5, 2026-04-11)

The "NULL tenant → zero rows" Postgres behaviour is correct-by-default but creates a **silent debugging trap**: a developer who forgets to wrap a query in `runInTenant()` sees an empty result set and debugs it as a data issue rather than a security-policy issue. Time-to-diagnose can be 20+ minutes per incident across the team.

**Solution**: Add a `DEBUG_RLS_STATE=1` environment flag. When set (dev only — never in production), `src/lib/db.ts` wraps every tenant-scoped query in a pre-check that reads `current_setting('app.current_tenant', TRUE)` and throws a loud developer-facing error with a stack trace if the result is NULL:

```typescript
// src/lib/db.ts (extension)
const DEBUG_RLS_STATE = env.DEBUG_RLS_STATE === 'true';

export async function runInTenant<T>(
  ctx: TenantContext,
  fn: (tx: PgTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant = ${ctx.slug}`);
    return fn(tx);
  });
}

// Optional dev guard for direct queries NOT going through runInTenant
export async function assertTenantContextSet(tx: PgTransaction): Promise<void> {
  if (!DEBUG_RLS_STATE) return;
  const result = await tx.execute(sql`SELECT current_setting('app.current_tenant', TRUE) AS t`);
  const current = result.rows[0]?.t;
  if (!current) {
    throw new Error(
      '[DEBUG_RLS_STATE] Query ran without app.current_tenant set. ' +
      'Wrap the query in runInTenant(ctx, ...) from @/lib/db. ' +
      'See specs/002-membership-plans/research.md § 2.5.'
    );
  }
}
```

Integration test `tests/integration/plans/rls-debug-state.test.ts` asserts that the assertion fires when expected (set `DEBUG_RLS_STATE=true`, issue a query outside `runInTenant`, expect the error). Production never enables the flag — the silent-zero-rows behaviour is the correct production default (no error leak).

Troubleshooting guidance for this is added to `quickstart.md § 8.1`.

---

## 3. RBAC extension for plans

**Decision**: Extend F1's `src/modules/auth/domain/policies.ts` with a new `Resource` union member `'plan'` and map it to the existing action set (`read`, `create`, `update`, `delete`). Add a new `Action` value `clone` for the clone-year operation. The policy table becomes:

| Role     | plan:read | plan:create | plan:update | plan:delete | plan:clone | fee_config:read | fee_config:update |
|---------|-----------|-------------|-------------|-------------|------------|-----------------|-------------------|
| admin    | ✓         | ✓           | ✓           | ✓           | ✓          | ✓               | ✓                 |
| manager  | ✓         | —           | —           | —           | —          | ✓               | —                 |
| member   | —         | —           | —           | —           | —          | —               | —                 |

**Rationale**:

- The F1 policy table is designed for extension — adding a new resource is a single-file change. No new role is introduced (manager / admin / member stay as F1 established).
- Keeping `clone` as a distinct action preserves audit-log clarity (`plan_cloned` is a distinct event type, not an overloaded `plan_created`).
- Manager read-only access to fee config is explicitly required by spec US5 AS3 + FR-017.

**Alternatives considered**:

- **Introduce a separate plans RBAC module**. Rejected — unnecessary duplication; F1's policy system is centralised and works.
- **Merge `clone` into `create`**. Rejected — loses audit-event granularity and makes permission tuning (e.g., "managers can clone but not create from scratch") impossible without code changes.

---

## 4. Command palette library decision

**Decision**: **`cmdk` v1.x** (Paco Coursey / shadcn). Integrated via `shadcn add command`. Result grouping via `<CommandGroup heading="...">`. Global shortcut `⌘K` / `Ctrl+K` registered once at the app shell in `src/components/shell/command-palette-root.tsx`. In-memory filter over the plans result set (<50 rows per tenant) — no search backend.

**Rationale**:

- `cmdk` is the library of record in the shadcn ecosystem we already ship. No new mental model; adds exactly one component family.
- Headless + accessible by default (WAI-ARIA combobox pattern, keyboard-first, focus trap). Reduces a11y work per `docs/ux-standards.md` § 7.3.
- In-memory filter is sub-millisecond on 9 rows; the 100 ms SC-008 budget is consumed almost entirely by React render + portal mount, not by search. Measured in `docs/smart-chamber-features.md` § 5 implementation note.
- `cmdk`'s API shape (`<Command>`, `<CommandInput>`, `<CommandList>`, `<CommandGroup>`, `<CommandItem>`) is exactly the shape F3+ need to extend (members, invoices, events). No re-architecture later.

**Performance plan** (revised per critique E7 2026-04-11, refined per critique P8 2026-04-11):

- **Lazy-load palette data on first `⌘K` press**, not on admin shell mount. This avoids firing a `/api/plans/search` request on every admin page load regardless of whether the user opens the palette.
- **Cold-start mitigation**: the admin shell root (`src/components/shell/admin-shell.tsx`) injects `<link rel="preconnect" href="${origin}" crossOrigin="anonymous" />` so DNS + TLS are warm by the time the user presses `⌘K`. Zero data fetched on mount, but the socket is primed. Costs nothing and drops first-open cold latency by ~50–150 ms on typical broadband.
- **Split SC-008 budget** (critique P8, 2026-04-11): first-open per session p95 < 300 ms (cold path, allows DNS + TLS + first fetch even on the slowest realistic connection), every subsequent open p95 < 100 ms (warm socket + `unstable_cache` 30 s TTL hit). This is more honest than a flat 100 ms budget that would be violated on fresh tabs.
- `unstable_cache` on the server-side search endpoint with a 30 s TTL + tenant-scoped cache tag — subsequent opens within the same 30 s reuse the cached result.
- Debounce input at 50 ms (slightly under one React frame) to avoid per-keystroke re-render thrash on lower-end laptops.
- Use `React.useDeferredValue` on the filter term so render prioritises palette open animation.

**Alternatives considered**:

- **Build custom** (headless + our own keyboard handling). Rejected — reinventing WAI-ARIA combobox is expensive and error-prone, and accessibility is a Principle VI gate.
- **Raycast SDK web variant**. Rejected — desktop-focused, over-sized dependency.
- **Linear-style search UX with fuzzy matching + server round-trip**. Rejected for F2 — 9 rows don't need fuzzy / server. Revisit when entity cardinality crosses ~1000.

---

## 5. Editable table library — **DEFERRED to F3** (critique X1c, 2026-04-11)

**Decision**: **Defer `@tanstack/react-table` integration to F3 Members & Contacts.** For F2, the Plans list uses a plain shadcn `<Table>` HTML wrapper (no headless state library) with server-side sorting / filtering and confirmation-dialog-based actions. US7 (Inline Edit + Bulk Actions) is explicitly out of F2 scope.

**Rationale**:

- At F2 scale (9 plan rows per tenant), inline edit and bulk actions deliver marginal user value — the editable-table primitive is a load-bearing abstraction whose cost (30–40% of F2 implementation budget + a new cross-cutting component that deserves careful API design) outweighs the benefit.
- F3 Members & Contacts is the natural home for the primitive: a chamber with hundreds of member rows immediately stress-tests every feature (inline edit performance, bulk select ergonomics, optimistic update semantics, undo race conditions). Designing the primitive against real cardinality produces a better API than designing it against 9 rows.
- Deferring F2 → F3 does not block any user outcome. Standard edit-form flow (US3) handles every single-row mutation F2 needs. The Plans list remains sortable, filterable, and keyboard-navigable via the plain shadcn `<Table>`.
- When F3 introduces the primitive, F2's Plans list can be retro-upgraded with a single PR (same endpoints, same entity, new presentation component).

**What stays in F2**:

- The Plans list is a plain HTML `<table>` (shadcn `<Table>` / `<TableHeader>` / `<TableBody>` / `<TableRow>` / `<TableCell>`) with server-side sorting + filtering via query parameters.
- Row-level actions (activate / deactivate / edit / clone / delete) remain accessible via a row-level dropdown menu (shadcn `<DropdownMenu>`) triggered by a `⋯` button per row — keyboard-accessible.
- Command palette (US6, shipped in F2) provides a faster alternative path to open any plan or trigger any action.

**Alternatives considered (for the record, in case a future decision revisits)**:

- **ag-Grid Community**. Rejected — heavyweight, BSD license, different styling system. Would be heavy even if we decided to ship US7 in F2.
- **MUI DataGrid**. Rejected — brings Material-UI, conflicts with shadcn + Tailwind v4.
- **Custom table with CSS Grid**. Rejected when we were considering an editable table — but acceptable for F2's plain list because there's no inline-edit complexity.

**When F3 revives this section**: add back the TanStack Table decision with optimistic-update + 10 s undo pattern as originally specced. Transaction-handling-for-bulk text below is preserved for future reference.

**(Preserved for F3)** Transaction handling for bulk:

- Bulk activate / deactivate / clone is a single API call with a batch payload. The server uses a single DB transaction with a per-row validation pass first (reject the whole batch if any row fails the locked-field rule), then a commit. All-or-nothing model.
- Undo on bulk is implemented as a reverse-action API call that runs under a stale-state guard — if any target's current state differs from the expected-pre-state, the undo refuses with `422 undo_state_drift` (critique E4, 2026-04-11).
- Simpler than two-phase commit and good enough at F2 scale. F3 will re-adopt this design.

---

## 6. Money representation — integer minor units + single tenant currency

**Decision (revised per critique P3, 2026-04-11)**: Every monetary amount in F2 is stored as a **non-negative integer in the currency's smallest unit**, in a column like `annual_fee_minor_units`. The **ISO 4217 currency code is stored once per tenant** on `tenant_fee_config.currency_code` and is implicit for every plan field in the tenant. The Domain holds a `Money` helper type used **only at the Application-layer boundary** to hydrate values for presentation:

```typescript
// Domain — src/modules/plans/domain/money.ts (Application/presentation helper only)
export type Money = { amount_minor_units: number; currency_code: string };

// Application layer hydrates Money at the repo boundary:
// - reads tenant_fee_config.currency_code once per runInTenant transaction
// - wraps each integer column into a Money { minor_units, currency_code } for presentation
// - strips back to raw integer on write

export const formatMoney = (m: Money, locale: Locale): string => { /* Intl.NumberFormat */ };
export const addVat = (m: Money, vatRate: number): Money => { /* integer math */ };
```

**Rationale**:

- **Clarifications Q5** — integer minor units are mandatory. **Critique P3** — per-plan currency is unnecessary complexity at F2 scale; a single tenant currency (on `tenant_fee_config`) serves every SweCham plan. Re-introducing per-plan currency is an additive migration if a future mixed-currency tenant actually onboards.
- Integer minor units eliminate floating-point rounding on VAT multiplication. Example: `36000.00 * 0.07 = 2520.0` looks fine but `36000.00 * 0.075 = 2700.0000000000005` in IEEE 754. Integer math `3600000 * 75 / 1000 = 270000` returns exactly `270000` (the minor units, i.e. 2,700.00).
- ISO 4217 3-letter codes are the industry standard and encode decimal places via a lookup table we keep internally: THB = 2, JPY = 0, SEK = 2, EUR = 2, USD = 2. Formatting uses `Intl.NumberFormat(locale, { style: 'currency', currency })` which knows the decimals for us.
- A future Singapore or Japan chamber requires **zero schema migration** — only a different `tenant_fee_config.currency_code` value. The existing `*_minor_units` columns are re-interpreted in the new currency's smallest unit.
- Stripe, Xero, Shopify, Square all use integer-minor-units — any engineer joining the project in future will recognise it instantly. What they won't see (and won't miss) is a per-row currency column on a single-currency-per-tenant catalogue.

**VAT math worked example** (SweCham Premium 2026):

```
stored: (3_600_000, 'THB')           # = 36,000.00 THB
VAT rate: 0.07 (stored as 0.0700 in tenant_fee_config.vat_rate numeric(5,4))
VAT amount in minor units: 3_600_000 * 7 / 100 = 252_000  # = 2,520.00 THB
total:  3_600_000 + 252_000 = 3_852_000                   # = 38,520.00 THB
display (en/th): ฿38,520.00   display (sv): 38 520,00 ฿
```

All operations are integer → integer, no floats.

**Alternatives considered** (same as Clarifications Q5): integer THB only — rejected; decimal / numeric — rejected (audit-diff readability + JS floating point); opaque JSON money value — rejected (queryability).

---

## 7. Plan display-name i18n storage validation

**Decision**: Plan display name is a **structured record** stored as `jsonb` in Postgres with shape `{ en: string; th?: string; sv?: string }`. Validation via a shared zod schema in `src/modules/plans/domain/locale-text.ts`:

```typescript
export const localeTextSchema = z.object({
  en: z.string().trim().min(1, 'English name is required').max(120),
  th: z.string().trim().min(1).max(120).optional(),
  sv: z.string().trim().min(1).max(120).optional(),
});
export type LocaleText = z.infer<typeof localeTextSchema>;

export const hasMissingTranslations = (t: LocaleText): ('th' | 'sv')[] => {
  const missing: ('th' | 'sv')[] = [];
  if (!t.th) missing.push('th');
  if (!t.sv) missing.push('sv');
  return missing;
};
```

**Rationale**:

- **Clarifications Q3 decision** — structured map, EN required, TH/SV optional with missing-translation indicator.
- `jsonb` in Postgres allows indexing and queries via JSON path expressions if we ever need "find plans with missing Thai translations". No dedicated translations table required at this scale.
- Zod is already the project's runtime-validation layer at every system boundary (from F1). Reusing it here keeps the pattern uniform.
- The Application layer passes `LocaleText` values to the repo; the repo persists them as `jsonb`. Drizzle's `jsonb<LocaleText>()` column type preserves the TypeScript shape.
- Presentation uses a small helper `pickLocaleText(text, activeLocale)` that returns `text[activeLocale] ?? text.en` with a `missingLocales` flag for admin views.

**Alternatives considered** (same as Clarifications Q3): three flat columns — rejected (migration cost for new locales); separate translations table — rejected (overkill at 9 rows); message-key reference — rejected (not build-time content).

---

## 8. Prior-year partial-lock enforcement strategy

**Decision**: Locked-field rule lives in **Domain** as a pure function, is enforced at **Application-layer** write paths (create, update, bulk-update, inline-edit), and has a **secondary repo-level guard** that re-validates on commit. The Domain rule:

```typescript
// src/modules/plans/domain/locked-field-rule.ts
export const LOCKED_FIELDS_ON_PRIOR_YEAR = [
  'annual_fee',           // Money
  'registration_fee_override',
  'min_turnover',
  'max_turnover',
  'max_duration_years',
  'max_member_age',
  'member_type_scope',
  'includes_corporate_plan_id',
  'benefit_matrix',        // entire object — the whole benefit grid is locked
] as const;
export type LockedField = typeof LOCKED_FIELDS_ON_PRIOR_YEAR[number];

export function detectLockedFieldChanges(
  oldPlan: Plan,
  patch: Partial<Plan>,
  currentYear: PlanYear,
): LockedField[] {
  if (oldPlan.plan_year >= currentYear) return []; // current or future year — no lock
  const locked: LockedField[] = [];
  for (const field of LOCKED_FIELDS_ON_PRIOR_YEAR) {
    if (field in patch && !deepEqual(patch[field], oldPlan[field])) {
      locked.push(field);
    }
  }
  return locked;
}
```

**Rationale**:

- Domain holds the **rule itself** (pure, testable, framework-free). Unit tests in `tests/unit/plans/domain/locked-field-rule.test.ts` cover every field × old/new year combination (including the `plan_year === currentYear` boundary).
- Application enforces the rule on every write path via a shared guard `enforceNoLockedFieldChanges(oldPlan, patch, deps.clock)` that returns a typed error if any locked field was touched. That error bubbles up to the API layer as a 422 with the offending field list.
- Repo-level secondary guard catches the "use case forgot to call the guard" class of bug — if a write arrives with a locked-field change on a prior-year plan, the repo refuses and logs a high-severity "defence-in-depth triggered" event. This is belt-and-braces.
- Inline edit and bulk edit reuse the same guard — the rule is enforced on the *patch*, not on the UI mode.

**Alternatives considered**:

- **Database check constraint / trigger that looks up the year**. Considered — database-enforcement appeals for defence-in-depth, but the rule depends on "current year" which is runtime state not stored in the DB. A trigger would have to hard-code a year, which drifts. Rejected.
- **UI-only disable of locked fields**. Rejected — admin can still manipulate the API payload. Must be a server-side rule.
- **Lock the entire plan row** (no edits at all). Rejected by Clarifications Q4 (Option A explicitly rejected) — chamber needs to fix typos and backfill translations on historical plans.

---

## 9. Idempotency keys — reuse from F1

**Decision**: Reuse F1's idempotency-key pattern. POST / PATCH / DELETE endpoints under `/api/plans/**` and `/api/fee-config` require an `Idempotency-Key` header (a client-supplied UUID). The server stores `(key, request_hash, response_body, created_at)` in an existing `idempotency_keys` table (shared with F1). Retention 24 h. Repeat `key + same hash` returns the original response verbatim; repeat `key + different hash` returns 409.

**Rationale**:

- The pattern works for F1. Reusing it means zero new storage, zero new docs, one test file to port.
- Bulk and clone endpoints are especially sensitive to double-submit (admin taps "Clone 2026 → 2027" twice on a slow connection). The 409 prevents silent duplication and matches FR-008 ("refuse if target year already populated") as a second line of defence.
- GET endpoints do NOT require idempotency keys (they are naturally idempotent).

**Alternatives considered**:

- **Per-row dedup via database unique constraint only**. Rejected — surfaces as a Drizzle error, not a clean 409, and only catches some classes of duplicate (not e.g. a cloned-bulk that partly succeeded server-side before the client retried).
- **No idempotency**. Rejected — violates Principle VIII for state-changing endpoints.

---

## 10. Enterprise UX pattern inventory for F2

**Decision**: Every F2 screen is designed to the `docs/ux-standards.md` § 15 checklist. Specific decisions:

### 10.1 Shimmer skeleton — shape matching for CLS 0

Every list-view loading state renders a `<PlansTableSkeleton />` that mirrors the final table row count + column widths exactly, so there is **zero layout shift** when the real data arrives. This satisfies `docs/ux-standards.md` § 2.1 + Constitution Principle VI (CLS < 0.1 → actually 0 on F2 screens). Implemented by inspecting the resolved plans query shape (max rows, column widths from the column-def) and rendering placeholder rows with the same height + padding.

Reduced-motion fallback: shimmer gradient animation is disabled under `prefers-reduced-motion: reduce`, leaving a static skeleton with subtle pulse opacity (not animated translate). Tested in `tests/e2e/plans-reduced-motion.spec.ts`.

### 10.2 Toast patterns — sonner

- **Success**: `toast.success('Plan deactivated')` — auto-dismiss 4 s, no action.
- **Success with undo**: `toast.success('Plan deactivated', { action: { label: 'Undo', onClick: () => ... }, duration: 10_000 })` — 10 s dismiss, undo wires to the inverse mutation.
- **Error**: `toast.error('Could not save plan')` with a short reason + a "Retry" action where applicable. Auto-dismiss 8 s. Screen-reader announced via sonner's built-in aria-live region.
- **Info** (locked-field warning, cross-tenant probe note): `toast.info(...)`, 6 s.

Exactly-one-toast-per-feedback-path is enforced by a lint-style test (`tests/e2e/plans-toast-coverage.spec.ts`) that counts toast DOM nodes after each mutation. Two toasts for one action = failure.

### 10.3 Confirmation dialogs

All destructive actions (deactivate, soft-delete, bulk deactivate, bulk delete, clone when target has existing rows) trigger a confirmation dialog via shadcn `<AlertDialog>`. Copy requirement per `docs/ux-standards.md` § 4.1:

- Title uses the explicit verb ("Deactivate plan?", "Soft-delete plan?", "Clone 2026 plans to 2027?")
- Body names the concrete object ("You're about to deactivate *Premium Corporate 2026*. Existing members keep their plan; new signups cannot choose it.")
- Primary button repeats the verb ("Deactivate", "Soft-delete", "Clone")
- Secondary button is always "Cancel", focused on open

### 10.4 aria-live announcements for inline edit

Every inline-edit success dispatches an `aria-live="polite"` message via a dedicated `<LiveRegion>` component in the app shell (introduced in F1 for auth, reused here). Example: *"Premium Corporate 2026 annual fee set to 38,000 THB."* Announcements are localised. Reduced-motion users get identical announcements.

### 10.5 Keyboard-first contract

Every interactive element has a keyboard path:
- `⌘K` / `Ctrl+K` opens palette anywhere in admin
- `/` focuses the list search bar (Gmail / GitHub pattern)
- `Tab` / `Shift+Tab` navigate focusable elements
- `Enter` opens the focused plan in the edit view; `Space` toggles inline edit
- `Esc` closes dialogs / palette / inline-edit state
- Bulk select: `Space` toggles the selection checkbox on the focused row; `Shift+Space` range-selects
- Arrow keys navigate palette results and table row focus (when table has focus)

Tested in `tests/e2e/plans-keyboard-only.spec.ts` using Playwright's `page.keyboard.press` only — no mouse calls at all in that file.

### 10.6 Light + dark parity

`next-themes` is already wired in F1. F2 reuses it unchanged. Every new F2 component is built with `bg-background`, `text-foreground`, `border-border` Tailwind tokens so dark mode requires zero per-component styling. Visual regression check in E2E: render each screen in both modes and diff screenshots (stored in `tests/e2e/screenshots/`).

### 10.7 Empty states

- Zero plans for the current year: *"No plans for 2026 yet. Create the first plan to get started — or clone last year's catalogue if one exists."* + two CTA buttons.
- Zero matches in the palette: *"No plans match 'fog'. Try a different search or create a new plan."*
- Zero selected in bulk mode: bulk action bar hidden entirely.
- Zero soft-deleted in "Show deleted" mode: *"No deleted plans."*

All empty states are localised (EN/TH/SV) and respect reduced motion.

---

## 11. Seed script design (revised per critique P4, 2026-04-11)

**Decision**: `scripts/seed-swecham-2026-plans.ts` is a standalone `tsx` script with **two independent idempotent stages**, each in its own transaction:

**Stage A — tenant fee config (idempotent upsert)**:
1. Validate `TENANT_SLUG === 'swecham'` (hard-coded guard for F2)
2. Open transaction, `SET LOCAL app.current_tenant = 'swecham'`
3. `INSERT … ON CONFLICT (tenant_id) DO UPDATE` the `tenant_fee_config` row (`currency_code='THB'`, `vat_rate=0.0700`, `registration_fee_amount_minor=100000`)
4. Commit — safe to re-run at any time

**Stage B — membership plans (refuses if populated)**:
1. Open transaction, `SET LOCAL app.current_tenant = 'swecham'`
2. Check if **any** plan exists for `(tenant='swecham', year=2026)` → if yes, rollback + exit non-zero with a clear message
3. Insert the 9 plans from `docs/membership-benefits-analysis.md` §2 + §3 with money fields in minor units (36,000 THB → `3_600_000` minor units; currency comes from the just-upserted `tenant_fee_config`)
4. Writes an `audit_log` entry `plan_created` per plan (event_type snake_case per F1 convention)
5. Commit

**Partial-seeded state handling**: Stage A runs first and is idempotent — so a re-run on a state where `tenant_fee_config` exists but plans don't will **skip** Stage A's work quietly (or update the row to match the seed values) and proceed to Stage B. A re-run on a state where both exist refuses at Stage B. A re-run on a state where `tenant_fee_config` is missing (manual DB meddling) completes Stage A then attempts Stage B. No state leaves the DB in an inconsistent shape.

On any error within a stage, that stage's transaction rolls back — partial stage state never persists. The script uses `runInTenant()` so RLS policies apply even at seed time (no `BYPASS RLS`).

**Test** (`tests/integration/plans/seed-idempotency.test.ts`):
1. Fresh DB → run seed → assert fee_config row + 9 plan rows + 10 audit entries (9 × `plan_created` + 1 × `fee_config_updated`)
2. Re-run seed → assert Stage A upsert succeeds quietly, Stage B refuses with non-zero exit, DB still has exactly 9 plans
3. Delete the 9 plans (keep fee_config) → re-run → assert Stage A is quiet, Stage B inserts 9 plans
4. Delete only fee_config (keep plans) → re-run → assert Stage A re-inserts fee_config, Stage B refuses at the plan check

---

## 12. Migration ordering & forward compatibility (revised per critique E10 verification, 2026-04-11)

**Finding from verifying F1's audit schema**: F1 uses a Postgres `audit_event_type` **pgEnum** with 17 snake_case values (see `src/modules/auth/infrastructure/db/schema.ts`). The `audit_log` table has columns `(id, timestamp, event_type, actor_user_id, target_user_id, source_ip, summary, request_id)` — **no `payload` column, no `tenant_id` column, no `severity` column**. F1's audit_log is also cross-tenant by design (identity layer — see `docs/saas-architecture.md` § 4). F2 must extend this schema.

**Decision**: Two new migration files:

- `drizzle/migrations/0006_plans_and_fee_config.sql` — creates `membership_plans`, `tenant_fee_config`, enables RLS (`ENABLE` + `FORCE`), creates the tenant isolation policies, creates indexes. Applied in a single transaction.

- `drizzle/migrations/0007_audit_log_f2_extension.sql` — **does three things in one migration file, but the statements cannot all sit inside a single `BEGIN…COMMIT` block** because Postgres forbids `ALTER TYPE … ADD VALUE` inside a transaction block (it fails with `ERROR: ALTER TYPE ... ADD cannot run inside a transaction block`). Structure:

  ```sql
  -- Part A — extend audit_event_type enum with 9 F2 values.
  -- Each ALTER TYPE ADD VALUE must be its own top-level statement.
  ALTER TYPE audit_event_type ADD VALUE 'plan_created';
  ALTER TYPE audit_event_type ADD VALUE 'plan_updated';
  ALTER TYPE audit_event_type ADD VALUE 'plan_cloned';
  ALTER TYPE audit_event_type ADD VALUE 'plan_activated';
  ALTER TYPE audit_event_type ADD VALUE 'plan_deactivated';
  ALTER TYPE audit_event_type ADD VALUE 'plan_soft_deleted';
  ALTER TYPE audit_event_type ADD VALUE 'plan_undeleted';
  ALTER TYPE audit_event_type ADD VALUE 'plan_not_found';          -- logged by request path
  ALTER TYPE audit_event_type ADD VALUE 'plan_cross_tenant_probe'; -- escalated by periodic scan (F13)
  ALTER TYPE audit_event_type ADD VALUE 'fee_config_updated';

  -- Part B — add columns + RLS policy (wrapped in an anonymous DO block OR statement batch).
  -- These CAN run after the ADD VALUE statements since they target the TABLE, not the TYPE.
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS payload jsonb;
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id text;

  -- Part C — RLS policy on audit_log: permissive NULL (F1 cross-tenant events) + tenant-scoped (F2 events).
  ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
  ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
  CREATE POLICY audit_log_tenant_isolation
    ON audit_log
    FOR ALL
    USING (
      tenant_id IS NULL
      OR tenant_id = current_setting('app.current_tenant', TRUE)
    )
    WITH CHECK (
      tenant_id IS NULL
      OR tenant_id = current_setting('app.current_tenant', TRUE)
    );
  ```

  **Critical notes on this migration**:

  1. **ALTER TYPE ADD VALUE statements are committed immediately on execution** and cannot be rolled back by a subsequent error — Postgres considers them metadata changes. If Part C fails for any reason, Parts A + B persist and the migration is "partially applied". `drizzle-kit migrate` treats the migration as failed and will not mark it applied in the migration history, meaning on re-run the `IF NOT EXISTS` column guards will no-op correctly but the `ADD VALUE` statements will fail because the values now exist. **Solution**: make Part A idempotent by prefixing each with `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'plan_created' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_event_type')) THEN ALTER TYPE audit_event_type ADD VALUE 'plan_created'; END IF; END $$;` — for each value. More verbose but survives partial-apply scenarios.

  2. **F1 audit entries stay visible everywhere.** Existing F1 rows have NULL `tenant_id` and NULL `payload` after the migration. The RLS policy explicitly allows NULL tenant_id rows to pass through — so F1's cross-tenant identity events (`sign_in_success`, `invitation_redemption_failed`, etc.) remain globally visible to any query path, regardless of the active tenant. F2 plan-event entries carry a non-null `tenant_id` and are strictly tenant-scoped.

  3. **F1's `audit_log_immutable` trigger** (migration `0001_audit_log_append_only.sql`) continues to apply to F2 events — the append-only guarantee is preserved automatically.

  4. **F2 event-type naming** is snake_case (`plan_created`) to match F1 convention (`sign_in_success`), not dot-case (`plan.created`) — updated consistently across `spec.md`, `data-model.md`, `contracts/plans-api.md`, and this document.

**Drizzle schema file** `src/modules/plans/infrastructure/db/schema.ts` defines both new F2 tables via `pgTable` + `pgEnum`. `audit_log` schema in `src/modules/auth/infrastructure/db/schema.ts` is extended to reflect the new columns + the widened `auditEventTypeEnum` tuple (add the 9 values; TypeScript autocomplete and zod validation pick them up). Drizzle-kit generates the table + index DDL; **Part A + Part B + Part C raw SQL are appended manually to the generated migration file** because Drizzle does not emit `ALTER TYPE ADD VALUE` or RLS policies.

---

## 13. Performance budget sanity check

| Target | Value | Source | Plan to measure |
|---|---|---|---|
| Plans list first paint p95 | < 2 s | SC-001 | Vercel Speed Insights + Lighthouse CI on PR |
| Plans list LCP | < 2.5 s | Principle VI | Same |
| Plans API `GET /api/plans` p95 | < 400 ms | Principle VII | OTel trace + `@vercel/otel` duration histogram |
| Command palette open p95 | < 100 ms | SC-008 | Client-side performance mark from `⌘K` press to first paint of the palette content — emitted as a `perf.palette_open` metric |
| ~~Bulk action (10 rows) p95~~ | *deferred to F3* | ~~SC-009~~ | US7 deferred per critique X1c |
| ~~Inline-edit mutation p95~~ | *deferred to F3* | — | US7 deferred per critique X1c |
| Cross-tenant probe integration test | 100% pass | SC-003 | Required for Review Gate |
| Seed script | deterministic 9 rows + idempotent partial-state recovery | SC-005 | Required for Review Gate |

At F2 scale (9 rows per tenant × 1 tenant = 9 rows total) every budget has a **5–10× safety margin**. Performance risk is effectively zero in F2; the budgets exist to catch regressions as entity count grows in F3+.

---

## 14. Open questions routed to downstream features

These are documented for traceability but **do not block F2 plan**:

| Question | Downstream feature | Rationale |
|---|---|---|
| Q1 (membership-benefits-analysis.md §5) — Start-up 2-year clock origin | F3 Members | Requires `membership_start_date` semantics — F3 introduces the members table. F2 plan record already carries `max_duration_years` correctly. |
| Q3 (ibid.) — Pro-rate on mid-year join | F4 Invoicing | F4 computes invoice amounts; F2 stores the full annual fee. |
| Q4 (ibid.) — Upgrade / downgrade accounting | F3 + F4 | Requires member record state + billing logic. |
| Q5 (ibid.) — Registration fee trigger | F3 + F4 | F2 stores the `registration_fee` default on `tenant_fee_config`; the trigger is decided by F3/F4. |

---

## 15. Post-Design Constitution Re-Check

*Required by `/speckit.plan` step 3. Executed AFTER Phase 1 artefacts are generated, and re-executed after critique remediation (2026-04-11).*

After drafting `data-model.md`, `contracts/plans-api.md`, `quickstart.md`, and applying all critique remediation, re-run the 10 Constitution gates:

- [x] **I. Data Privacy & Security** — tenant isolation enforced at app + DB layers; cross-tenant test is Review-Gate blocker; no new PII; existing audit log extended with typed events. **PASS** (same as pre-design).
- [x] **II. Test-First Development** — contracts + integration + unit + E2E tests listed per user story; coverage thresholds stated; idempotency + clone + RLS tests called out. **PASS**.
- [x] **III. Clean Architecture** — `plans` module has four layers with barrel + ESLint rule; `TenantContext` is a Domain branded type; no ORM leaks; no framework imports in Domain. **PASS**.
- [x] **IV. Payment Security** — N/A in F2 (no payment); money stored in integer minor units specifically to make F5 PCI-compliant integer math trivial. **PASS**.
- [x] **V. i18n** — EN/TH/SV static keys + `LocaleText` for plan names; zod validation; missing-translation indicator; locale-aware formatting. **PASS**.
- [x] **VI. Inclusive UX** — UX standards § 15 checklist; shimmer in final-table shape for CLS 0; keyboard-first; reduced-motion fallback; axe-core gate. **PASS**.
- [x] **VII. Perf & Observability** — budgets stated with 5–10× margin; OTel spans with tenant/plan/user attributes; palette perf mark; pino child logger with tenant stamp. **PASS**.
- [x] **VIII. Reliability** — transactional clone + seed + bulk; all-or-nothing with typed errors; idempotency keys; new audit event types; last-write-wins concurrent handling. **PASS**.
- [x] **IX. Code Quality** — TS strict, ESLint, Prettier, Conventional Commits; solo-maintainer substitute acknowledged + reversible. **PASS**.
- [x] **X. Simplicity** — no `tenants` table yet; no search backend; no hard-delete; no realtime; no CMS. Explicit YAGNI list in plan.md. **PASS**.

**Re-check result: all 10 gates pass post-design AND post-critique-remediation** (2026-04-11). Complexity Tracking carries F1's two inherited deviations unchanged; no new F2 deviations surface from the design artefacts. All four Must-Address critique items (X1c, E1/X2, E3, E5) and all 11 Recommendations are applied to spec.md + plan.md + data-model.md + contracts/plans-api.md + research.md + quickstart.md. Critique report at `specs/002-membership-plans/critiques/critique-2026-04-11T091021Z.md`.

**Ready for `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement`.**
