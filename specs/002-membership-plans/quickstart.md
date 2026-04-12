# Quickstart — F2 Membership Plans

**Feature**: F2 Membership Plans
**Branch**: `002-membership-plans`
**Date**: 2026-04-11
**Inputs**: [plan.md](./plan.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/plans-api.md](./contracts/plans-api.md)

This document onboards a developer (or the implementation pass of `/speckit.implement`) into building and verifying F2. It assumes F1 is already installed and green (480/480) on the main branch.

---

## 1. Prerequisites

Before starting, confirm the F1 baseline is in place:

```bash
# Confirm the branch is F2
git status
git branch --show-current         # → 002-membership-plans

# Confirm F1 dev env still works
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm dev                           # http://localhost:3100
```

Expected: 480/480 tests green, dev server runs, sign-in flow works.

**Environment variables** (confirm via `vercel env pull .env.local`):

| Var | Required | Source | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Neon Singapore | F1 |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash Singapore | F1 |
| `RESEND_API_KEY` | ✅ | Resend | F1 |
| `APP_BASE_URL` | ✅ | `https://swecham.zyncdata.app` | F1 |
| `APP_ALLOWED_ORIGINS` | ✅ | `https://swecham.zyncdata.app,http://localhost:3100` | F1 |
| **`TENANT_SLUG`** | ✅ **NEW** | `swecham` | F2 — constant for the single-tenant deploy |
| `READ_ONLY_MODE` | optional | `false` | F1 emergency freeze |

Add `TENANT_SLUG=swecham` to `.env.local` (and to Vercel prod/preview env) before running F2 migrations or tests.

---

## 2. Install F2 dependencies

```bash
# cmdk only — @tanstack/react-table is deferred to F3 (critique X1c, 2026-04-11)
pnpm add cmdk

# Confirm resolved version + React 19 compatibility (critique E11)
pnpm view cmdk version        # should be >= 1.1.x
pnpm view cmdk peerDependencies

# Install shadcn primitives used in F2 (note: NO `checkbox` — it is a US7-only primitive, deferred with US7)
pnpm dlx shadcn add command table select popover tabs scroll-area separator switch radio-group textarea label
```

Verify no other dependency drift:

```bash
pnpm typecheck && pnpm lint
```

---

## 3. Extend the constitution-enforcing ESLint rule

F1's `eslint.config.mjs` has a `no-restricted-imports` block that forbids framework imports inside `src/modules/auth/domain/**`. Extend to cover the **two new F2 modules** — `src/modules/tenants/domain/**` (cross-cutting Domain-only module — critique E1/X2) and `src/modules/plans/domain/**`:

```js
// eslint.config.mjs — extend existing block

// Rule 1: Domain layers have zero framework imports
{
  files: [
    'src/modules/tenants/domain/**/*.ts',
    'src/modules/plans/domain/**/*.ts',
  ],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['next', 'next/*'],              message: 'Domain must not import Next.js' },
        { group: ['react', 'react/*'],            message: 'Domain must not import React' },
        { group: ['drizzle-orm', 'drizzle-orm/*'],message: 'Domain must not import ORM' },
        { group: ['resend', 'resend/*'],          message: 'Domain must not import Resend' },
        { group: ['@upstash/*'],                  message: 'Domain must not import Upstash' },
      ],
    }],
  },
}

// Rule 2: Cross-context boundary — outsiders cannot deep-import into plans
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/modules/plans/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@/modules/plans/domain/*', '@/modules/plans/application/*', '@/modules/plans/infrastructure/*'],
          message: 'Cross-context imports must go through @/modules/plans (the public barrel)' },
      ],
    }],
  },
}

// Rule 3: tenants is a cross-cutting module — allow-list its barrel, block deep imports
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/modules/tenants/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@/modules/tenants/domain/*'],
          message: 'Import TenantContext from @/modules/tenants (the public barrel)' },
      ],
    }],
  },
}
```

Re-run `pnpm lint` — expect zero errors (the rules are no-ops until F2 source files exist).

---

## 4. Generate + apply migrations

Drizzle schema file lives at `src/modules/plans/infrastructure/db/schema.ts` (see data-model.md § 4). Once it exists:

```bash
# Generate SQL from the Drizzle schema
pnpm drizzle-kit generate
# → creates drizzle/migrations/0006_<auto-name>.sql

# Rename to the agreed filename
mv drizzle/migrations/0006_<auto-name>.sql drizzle/migrations/0006_plans_and_fee_config.sql
```

**Hand-edit** the generated migration to append the RLS block (Drizzle does not emit RLS):

```sql
-- (generated CREATE TABLE statements for membership_plans and tenant_fee_config)

-- RLS policies — MUST be inside the same migration as the table creation
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_on_membership_plans
  ON membership_plans
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));

ALTER TABLE tenant_fee_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_fee_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_on_fee_config
  ON tenant_fee_config
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
```

Also hand-write `drizzle/migrations/0007_audit_log_f2_extension.sql` which does three things in one file (see research.md § 12 for the full SQL): (a) **extend the `audit_event_type` pgEnum with 10 new snake_case values** (`plan_created`, `plan_updated`, `plan_cloned`, `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`, `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated`) via 10 independent `ALTER TYPE audit_event_type ADD VALUE ...` statements at the top level of the file (Postgres forbids these inside `BEGIN…COMMIT`); (b) `ALTER TABLE audit_log ADD COLUMN payload jsonb` + `ADD COLUMN tenant_id text` (both nullable — F1 rows stay NULL); (c) enable RLS on `audit_log` with a **permissive** policy `USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', TRUE))` so F1 cross-tenant identity events remain globally visible while F2 plan events are tenant-scoped. Verified against F1 schema (`src/modules/auth/infrastructure/db/schema.ts`) on 2026-04-11 — F1 already uses a real pgEnum, so this migration is real, not a no-op.

Apply:

```bash
pnpm drizzle-kit migrate
```

Verify in Neon web console:

```sql
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE tablename IN ('membership_plans', 'tenant_fee_config');
-- Expect: both rowsecurity=t and forcerowsecurity=t

SELECT policyname, tablename FROM pg_policies
WHERE tablename IN ('membership_plans', 'tenant_fee_config');
-- Expect: tenant_isolation_on_membership_plans + tenant_isolation_on_fee_config
```

---

## 5. Seed SweCham 2026 plans

The seed script runs two independent idempotent stages (critique P4, 2026-04-11):
- **Stage A**: upsert `tenant_fee_config` row — safe to re-run at any time
- **Stage B**: insert 9 plans — refuses if any plan already exists for `(swecham, 2026)`

```bash
TENANT_SLUG=swecham pnpm tsx scripts/seed-swecham-2026-plans.ts
```

Expected output on first run:

```
[seed] Connecting to Neon ap-southeast-1...
[seed] Tenant: swecham
[seed] === Stage A: tenant_fee_config ===
[seed] BEGIN (Stage A)
[seed] Upserting tenant_fee_config row (currency=THB, vat_rate=0.0700, registration_fee=100000 minor units)... ok
[seed] COMMIT (Stage A)
[seed] Writing audit event fee_config_updated ... ok
[seed] === Stage B: membership_plans ===
[seed] BEGIN (Stage B)
[seed] Checking pre-existing 2026 plans for swecham... 0 found — proceeding.
[seed] Inserting plan 1/9: premium ... ok
[seed] Inserting plan 2/9: large ... ok
...
[seed] Inserting plan 9/9: gold ... ok
[seed] Writing 9 audit events (plan_created × 9)... ok
[seed] COMMIT (Stage B)
[seed] ✅ Done. 9 plans + 1 fee_config row for tenant 'swecham'. Audit: 10 events.
```

Partial-seeded recovery scenarios:

```bash
# Case 1: fee_config exists but plans were deleted
# Re-run → Stage A upserts idempotently (no change), Stage B inserts 9 plans
TENANT_SLUG=swecham pnpm tsx scripts/seed-swecham-2026-plans.ts

# Case 2: plans exist but fee_config was deleted (manual DB meddling)
# Re-run → Stage A re-inserts fee_config row, Stage B refuses at plan existence check
TENANT_SLUG=swecham pnpm tsx scripts/seed-swecham-2026-plans.ts
# Expected:
# [seed] Stage A: upserting tenant_fee_config... ok
# [seed] Stage B: 9 plans already exist — refusing Stage B. Exit 1.

# Case 3: everything already present
TENANT_SLUG=swecham pnpm tsx scripts/seed-swecham-2026-plans.ts
# Expected:
# [seed] Stage A: upserting tenant_fee_config... ok (no-op)
# [seed] Stage B: 9 plans already exist — refusing Stage B. Exit 1.
```

---

## 6. Test matrix

### 6.0 Pre-implementation verification (critique E3, 2026-04-11)

**Before implementing anything else**, run the Neon `SET LOCAL` smoke test to empirically verify the pgBouncer + serverless interaction assumed by research.md § 2:

```bash
# One-time verification; delete the script after committing the research receipt
pnpm tsx scripts/verify-rls-set-local.ts
```

Expected output (see research.md § 2.4):
```
[test] no-tenant select returned: 0 rows (expect 0)   ← unset → secure zero
[test] with-tenant select returned: 1 rows (expect 1) ← SET LOCAL works
[test] wrong-tenant select returned: 0 rows (expect 0) ← cross-tenant zero
```

If outputs match, commit a one-line receipt to `research.md § 2.4` (*"Verified on Neon Singapore YYYY-MM-DD"*) and delete the throwaway script. If any output diverges, halt and diagnose before proceeding — the `runInTenant` pattern depends on this assumption.

### 6.1 The Review-Gate blocker

```bash
pnpm test:integration tests/integration/plans/tenant-isolation.test.ts
```

This test:
1. Creates two test tenants with **UUID-suffixed slugs** (`test-swecham-${crypto.randomUUID()}`, `test-chamber-${crypto.randomUUID()}`) via a shared helper `tests/helpers/test-tenant.ts` so parallel CI runs never collide on tenant slugs (critique E8, 2026-04-11)
2. Inserts 3 plans into each
3. Wraps every operation in `runInTenant(ctx, ...)` with Tenant A's slug, then Tenant B's
4. Asserts cross-tenant SELECT returns 0 rows
5. Asserts cross-tenant INSERT / UPDATE / DELETE returns "0 rows affected"
6. Asserts the request path produces a `plan_not_found` audit event on admin 404 (info severity)
7. Cleans up both tenants via the helper's after-each hook (deletes all rows tagged with the test's tenant slug)

**This test MUST pass before the `/speckit.review` gate.** Per Constitution v1.4.0 Principle I clause 3, a tenant-scoped feature cannot be reviewed with this test failing or absent.

**Test-isolation helper** (`tests/helpers/test-tenant.ts`):

```typescript
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export function createTestTenant(prefix: 'test-swecham' | 'test-chamber'): {
  ctx: TenantContext;
  cleanup: () => Promise<void>;
} {
  const slug = `${prefix}-${randomUUID().slice(0, 8)}`;
  const ctx = asTenantContext(slug);
  const cleanup = async () => {
    // Must BYPASS RLS via a superuser connection OR set the session var to our own slug first
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.current_tenant = ${slug}`);
      await tx.execute(sql`DELETE FROM membership_plans WHERE tenant_id = ${slug}`);
      await tx.execute(sql`DELETE FROM tenant_fee_config WHERE tenant_id = ${slug}`);
      await tx.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${slug}`);
    });
  };
  return { ctx, cleanup };
}
```

Every `tests/integration/plans/**` test file imports `createTestTenant` and calls `cleanup()` in an `afterEach` hook so parallel test runs cannot interfere.

### 6.2 Full F2 suite (reproduce CI locally)

```bash
# Lint + typecheck
pnpm lint && pnpm typecheck

# Unit tests (Domain layer, 100% line coverage required on plans domain)
pnpm test tests/unit/plans

# Contract tests (one file per endpoint)
pnpm test tests/contract/plans

# Integration tests (live Neon Singapore via DATABASE_URL)
pnpm test:integration tests/integration/plans

# E2E — smoke
pnpm test:e2e tests/e2e/plans-list.spec.ts

# E2E — full set (chromium + mobile-chrome + mobile-safari, all suites)
# NOTE: tests/e2e/inline-edit-bulk.spec.ts is deferred to F3 per critique X1c
pnpm test:e2e --grep "plans-"

# i18n coverage — fails on missing EN keys under admin.plans.*
pnpm check:i18n

# A11y scan — axe-core against every /admin/plans screen
pnpm test:e2e --grep "@a11y"

# Reduced motion — shimmer → pulse fallback
pnpm test:e2e --grep "@reduced-motion"

# Keyboard-only — no mouse calls
pnpm test:e2e --grep "@keyboard-only"
```

Full F2 CI pipeline:

```bash
pnpm lint && \
pnpm typecheck && \
pnpm test:coverage && \
pnpm check:i18n && \
pnpm test:integration && \
pnpm test:e2e
```

### 6.3 Coverage thresholds (enforced by `vitest.config.ts`)

| Layer | Line | Branch | Notes |
|---|---|---|---|
| `src/modules/plans/domain/**` | 100% | 100% | Pure types, state machine, locked-field rule |
| `src/modules/plans/application/**` | ≥80% | ≥80% | Use cases |
| `src/modules/plans/application/**` security-critical | — | **100%** | `enforce-tenant-context`, `enforce-prior-year-lock`, `delete-plan.ts` (member-attachment check), `clone-plans.ts` (idempotency), `role-guard.ts` |
| `src/modules/plans/infrastructure/**` | — | — | Tested via integration only |

---

## 7. Manual smoke walkthrough

After migrations + seed + `pnpm dev`, manually verify the primary flows:

### 7.1 US1 — list plans

1. Navigate to `http://localhost:3100/admin/sign-in` (or `/admin` if already authenticated)
2. Sign in as the bootstrap admin (`first.admin@swecham.example`)
3. Click "Plans" in the staff navigation → `/admin/plans`
4. **Expect**: shimmer skeleton for ~100 ms, then 9 rows (6 corporate + 3 partnership), sort by `sort_order` ascending within each category
5. Switch language to Thai via the language toggle → plan names render in Thai
6. Switch to Swedish → plan names render in Swedish
7. Filter by category → 3 partnership rows only
8. Type "plat" in the list search → "Platinum Partnership" row only

### 7.2 US6 — command palette

1. Press `⌘K` (or `Ctrl+K`) from anywhere in `/admin`
2. **Expect**: palette opens in <100 ms, focus lands on input, Recent / Actions / Navigate groups visible
3. Type "fog" — no matches; "plat" — Platinum result visible
4. Arrow-down to Platinum, press Enter → navigates to `/admin/plans/2026/platinum/edit`
5. Press `⌘K` again, type "clone" → "Clone 2026 → 2027" action appears
6. Press Enter → confirmation dialog opens for cloning

### 7.3 US2 — clone year

1. From the Plans list, click the "Clone 2026 → 2027" button (or trigger via palette)
2. Confirmation dialog lists the 9 plans to be cloned
3. Click "Clone" → toast "9 plans cloned to 2027"
4. Navigate to year filter 2027 → 9 inactive plans appear

### 7.4 US3 + FR-014 — prior-year lock

1. Open Premium 2026 for edit
2. **Expect**: persistent banner at top of form — *"You are editing a prior-year plan. Pricing and eligibility fields are locked."*
3. Annual fee field is read-only with a lock icon + tooltip "Clone to 2027 to change"
4. Plan name (EN) field is editable — change it, save
5. **Expect**: toast "Plan updated", change persisted, audit log entry `plan_updated` visible in dev tools (with field-level diff in `audit_log.payload`)
6. Now attempt to change the annual fee via the API directly:
   ```bash
   curl -X PATCH http://localhost:3100/api/plans/2026/premium \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: $(uuidgen)" \
     -H "Cookie: <session>" \
     -d '{"annual_fee_minor_units":4000000}'
   ```
7. **Expect**: `422 prior_year_locked_fields` with `details.locked_fields: ["annual_fee"]`

### 7.5 US4 — deactivate + soft-delete

1. Open Start-up 2026, click "Deactivate" → confirmation dialog → confirm → badge switches to "Inactive"
2. Click "Delete" → **expect** refusal if the plan is currently active (must deactivate first)
3. Deactivate first, then Delete → confirmation → toast "Plan soft-deleted"
4. Toggle "Show deleted" filter → deleted plan reappears with subdued style + "Undelete" action
5. Click Undelete → plan returns to the main list as inactive (not active)

### 7.6 US5 — fee config

1. Navigate to `/admin/settings/fees`
2. **Expect**: currency THB, VAT 7%, registration fee 1,000 THB displayed in the current locale's format
3. Change VAT to 7.5% → save → info banner: *"New rate applies to future displays only. Historical invoices are not recalculated."* → toast "Fee config updated"
4. Sign in as a manager role → `/admin/settings/fees` → all inputs disabled

### 7.7 US7 — inline edit + bulk (**DEFERRED to F3**, critique X1c 2026-04-11)

Not applicable to F2. Single-row mutations in F2 flow through the standard edit form (US3) or row-level dropdown-menu actions on the Plans list. F3 Members & Contacts introduces `@tanstack/react-table` + the full inline-edit + bulk-action pattern and retro-applies it to the Plans list if desired.

### 7.8 Cross-tenant probe (requires a second tenant)

This is covered by the integration test, but to see it manually:

1. Insert a fake second tenant's plan directly in Neon:
   ```sql
   SET LOCAL app.current_tenant = 'fake-other-tenant';
   INSERT INTO membership_plans (...) VALUES (...);  -- one row
   RESET app.current_tenant;
   ```
2. Sign in as SweCham admin
3. Navigate to `/admin/plans/2026/<fake-plan-slug>/edit`
4. **Expect**: 404 page (never 403, never a leak of existence)
5. Check the `audit_log` table — expect a new `plan_not_found` info-severity entry (F13 periodic scan would later escalate to `plan_cross_tenant_probe` if correlation finds the plan in another tenant)

---

## 8. Troubleshooting

### 8.1 "No rows visible even though I seeded 9" — the silent zero-rows RLS trap

Almost always a missing `SET LOCAL app.current_tenant`. The RLS policy is deliberately secure-by-default: an unset session variable returns zero rows, not an error. This is correct production behaviour but creates a silent debugging trap during development.

**Fast fix — enable the dev assertion** (critique E5, 2026-04-11):

```bash
# Set in .env.local — dev only, NEVER in production
DEBUG_RLS_STATE=true
```

With this flag set, `src/lib/db.ts` raises a loud stack-traced error the moment a tenant-scoped query runs without `app.current_tenant` set, turning the silent "no data" debugging session into a 10-second fix ("oh, I forgot `runInTenant`").

Verify manually in Neon SQL console:

```sql
SELECT current_setting('app.current_tenant', TRUE);
-- If NULL → RLS returns 0 rows (the "hard-fail default" from research.md § 2)
```

Fix: every transaction that touches plans must go through `runInTenant(ctx, fn)`. Do **not** set the session variable at connection time — only at `SET LOCAL` transaction scope. pgBouncer transaction-mode pooling will leak session-level settings between requests, which would be a security bug.

**Production note**: `DEBUG_RLS_STATE` MUST NOT be set in production — the silent-zero-rows behaviour is the correct production default (no error leak to attackers). The env validator in `src/lib/env.ts` asserts that the flag is unset when `NODE_ENV=production`.

### 8.2 "Tests fail with `relation membership_plans does not exist`"

The integration test DB schema is out of sync. Re-run migrations:

```bash
DATABASE_URL=<test-db-url> pnpm drizzle-kit migrate
```

Use a separate `DATABASE_URL_TEST` to avoid contaminating the live SweCham DB.

### 8.3 "Coverage threshold failed on plans domain"

Domain layer requires 100% line coverage. Most common miss: an edge case in `detect-locked-field-changes.ts` that was not unit-tested. Add the missing case to `tests/unit/plans/domain/locked-field-rule.test.ts`.

### 8.4 "axe-core reports violations on /admin/plans"

Typical causes:
- Missing `aria-label` on the inline-edit input (add `aria-label="Annual fee"`)
- Insufficient contrast on the "inactive" badge in dark mode (use `bg-muted text-muted-foreground`)
- Focus ring invisible on a custom-styled button (remove `outline-none` without a replacement)

### 8.5 "Command palette opens slowly (>500ms)"

- Check that plans data is preloaded on admin shell mount (idle time)
- Check `React.useDeferredValue` is wrapping the filter term
- Verify the shadcn `Command` component is not re-mounting on each keystroke

### 8.6 "pnpm check:i18n fails on release branch"

Missing Thai or Swedish key under `admin.plans.*` or `palette.*`. Run:

```bash
pnpm tsx scripts/check-i18n-coverage.ts --verbose
# → prints the exact missing key + file
```

Add the translation and re-run.

---

## 9. Rollback plan

If F2 needs to be rolled back post-deploy:

1. **Feature flag the admin surface**: add `NEXT_PUBLIC_PLANS_ENABLED=false` to Vercel env. The admin navigation hides the Plans link and `/admin/plans/**` returns a `503 not_available` page. Default should be `true` in prod after F2 ships.
2. **Emergency write freeze**: set `READ_ONLY_MODE=true` (inherited from F1) — returns 503 on all `/api/plans/**` mutation endpoints while keeping reads alive. Reversible in ~30 s without a code deploy.
3. **Revert the code**: `git revert <F2 merge commit>` → deploy. Data remains untouched.
4. **Drop the tables** (last resort, destroys audit events too): run the inverse migration in a separate `0006_rollback.sql` file. Never do this in production without a fresh DB backup. **Do not drop the migrations themselves** — the sequence numbers must stay claimed.

---

## 9.5 Pre-implementation validation (critique P1 + E3 + E10, 2026-04-11)

Before `/speckit.tasks` commits task ordering — complete these short validation steps:

- [ ] **P1 — Admin workflow confirmation**: 10-minute chat with the SweCham admin to confirm the dominant annual workflow is "clone December → tweak → activate January" rather than "create each plan from scratch". If confirmed, task ordering emphasises the clone path as the primary user journey. If the admin reveals a different pattern, revisit US2 acceptance scenarios.
- [ ] **E3 — Neon SET LOCAL smoke test**: run `scripts/verify-rls-set-local.ts` against the dev Neon database; commit the one-line verification receipt to `research.md § 2.4`; delete the throwaway script.
- [ ] **E10 — F1 audit schema spot-check (completed 2026-04-11)**: ✅ verified in `src/modules/auth/infrastructure/db/schema.ts` — F1 uses `audit_event_type` pgEnum with 17 snake_case values; migration 0007 is real and extends both the enum + the table. See research.md § 12.

## 10. Definition of Done (F2)

The feature is ready for `/speckit.ship` when:

- [ ] Pre-implementation validation (§ 9.5) complete
- [ ] `tests/integration/plans/tenant-isolation.test.ts` passes (Review-Gate blocker per Constitution v1.4.0 Principle I clause 3)
- [ ] `tests/integration/plans/rls-debug-state.test.ts` passes (DEBUG_RLS_STATE assertion fires when expected — critique E5)
- [ ] Full CI pipeline green on `002-membership-plans`: lint + typecheck + unit + integration + E2E + i18n + a11y + keyboard-only + reduced-motion
- [ ] Coverage thresholds met (Domain 100% for both `tenants/domain` and `plans/domain`; Application ≥80% + 100% on security-critical)
- [ ] All 6 live user stories (US1–US6) manually smoke-tested via § 7 (US7 deferred to F3)
- [ ] All 9 live success criteria (SC-001..SC-008, SC-010) verified (SC-009 deferred to F3 with US7)
- [ ] `docs/ux-standards.md` § 15 checklist ticked for every new screen
- [ ] Spec Kit `/speckit.review` (≥6 passes) + `/speckit.staff-review` (≥2 rounds) + `/speckit.analyze` clean
- [ ] 2 migrations applied to prod Neon (`0006_plans_and_fee_config`, `0007_audit_log_f2_extension`) — migration 0007's `ALTER TYPE ADD VALUE` statements run as independent top-level statements (not inside a transaction block — see research.md § 12)
- [ ] SweCham 2026 seed run on prod Neon — 9 plans + 1 fee config row verified + 10 audit events appended
- [ ] `TENANT_SLUG=swecham` set in Vercel prod + preview env
- [ ] `DEBUG_RLS_STATE` NOT set in Vercel prod env (dev-only flag)
- [ ] `docs/observability.md` extended with the `plan_cross_tenant_probe` runbook (critique E9) — triage < 5 min SLA
- [ ] Retrospective file `specs/002-membership-plans/retrospective.md` authored
- [ ] F2-introduced infrastructure documented as reusable primitives for F3+: tenant-context resolver, RLS pattern + `runInTenant` helper, DEBUG_RLS_STATE dev assertion, command palette primitive, `src/modules/tenants/` cross-cutting Domain module

---

## 11. What this feature unlocks

- **F3 Members & Contacts** — member records reference `membership_plans` via `(plan_id, plan_year)` and use `member_type_scope` to branch signup UI
- **F4 Membership Invoicing** — consumes `annual_fee`, `vat_rate`, `registration_fee` to compute Thai-tax-compliant invoice line items
- **F5 Online Payment** — Stripe Payment Intent reuses the money minor-unit pattern from F2
- **F6 Event Integration** — event quotas come from `benefit_matrix.partnership.event_tickets_included` + `cultural_tickets_per_year`
- **F7 Email Broadcast** — e-blast quotas come from `benefit_matrix.eblast_per_year`
- **F8 Renewal Tracking** — start-up 2-year cap, Thai Alumni age limit, registration fee "first-time only" logic all depend on F2 constraints
- **F9 Admin Dashboard + Directory** — directory listing generator reads `directory_listing_size` + `homepage_logo_category` from F2
- **F10 Multi-tenant onboarding** — F2's RLS policies + tenant-context resolver are the baseline; F10 swaps the constant resolver for real subdomain / custom-domain parsing

**F2 is the load-bearing schema for every commerce feature on Chamber-OS.** Ship it right.
