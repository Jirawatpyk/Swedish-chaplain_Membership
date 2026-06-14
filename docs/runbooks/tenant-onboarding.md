# Tenant Onboarding Runbook

**Audience**: Maintainers + DevOps onboarding a new tenant onto Chamber-OS (post-MVP, after F8 ships).
**Last updated**: 2026-05-09 (Staff-Review SUG-4 — F8 migration 0114 swecham-hardcoded follow-up)

---

## When to use this runbook

You are onboarding a new tenant (e.g. `tcc-thailand`, `bccthai`, etc.) onto an existing Chamber-OS deployment that already has the SweCham tenant live. The new tenant needs a freshly-seeded base configuration that mirrors what `swecham` has, while staying isolated by `tenant_id` and RLS+FORCE.

This runbook is NOT used for the initial SweCham deploy — that's the original `001-auth-rbac` quickstart.

---

## Pre-requisites

- New tenant slug agreed with stakeholder (lowercase, kebab-case, ≤ 32 chars)
- New tenant's primary admin user email
- New tenant's default locale (one of `en` / `th` / `sv`)
- New tenant's primary currency (default `THB`)
- Maintainer access to:
  - Vercel dashboard (env vars + custom domains)
  - Neon Singapore (DB cluster)
  - Resend (API keys + domain validation)
  - cron-job.org (4 F7 + 6 F8 cron endpoints — see `cron-jobs.md`)
  - GPG-signed commit access on `main`

---

## Onboarding sequence

### 1. DB seed — base tenant row

```sql
INSERT INTO tenants (slug, display_name, primary_locale, primary_currency, created_at)
VALUES ('<NEW_TENANT_SLUG>', '<Display Name>', 'en', 'THB', NOW());
```

### 2. F2 — seed default membership plans

The new tenant inherits the SweCham 2026 Membership Package tier model unless the stakeholder explicitly requests custom tier names. Reuse `scripts/seed-tenant-default-plans.ts` (TBD — track as `T-onboarding-1` in the next backlog grooming).

### 3. F8 — fix `renewal_tier_bucket` mapping

> **WHY**: F8 migration `0114_f8_repair_renewal_tier_bucket_seed.sql` hardcodes `WHERE tenant_id = 'swecham'` because it was authored as a one-time data fix for SweCham's 3 misclassified plans (premium / start-up / thai-alumni / individual seeded with `renewal_tier_bucket='regular'`). New tenants onboarding post-F10 may arrive with the same plan IDs and the same misclassification — they will NOT be caught by 0114.

After F2 plans are seeded for the new tenant, run this per-tenant repair query (replace `<NEW_TENANT_SLUG>`):

```sql
-- Per-tenant tier_bucket repair (mirrors F8 migration 0114 logic)
DO $$
DECLARE
  affected_count BIGINT;
BEGIN
  -- premium → premium
  UPDATE "membership_plans"
     SET "renewal_tier_bucket" = 'premium'
   WHERE "tenant_id" = '<NEW_TENANT_SLUG>'
     AND ("plan_id" IN ('premium', 'gold', 'platinum') OR "plan_name"->>'en' ILIKE 'premium%')
     AND "renewal_tier_bucket" <> 'premium';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'Premium repair: % rows updated', affected_count;

  -- start-up → start_up
  UPDATE "membership_plans"
     SET "renewal_tier_bucket" = 'start_up'
   WHERE "tenant_id" = '<NEW_TENANT_SLUG>'
     AND ("plan_id" IN ('start-up', 'startup') OR "plan_name"->>'en' ILIKE 'start%')
     AND "renewal_tier_bucket" <> 'start_up';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'Start-up repair: % rows updated', affected_count;

  -- thai-alumni → thai_alumni
  UPDATE "membership_plans"
     SET "renewal_tier_bucket" = 'thai_alumni'
   WHERE "tenant_id" = '<NEW_TENANT_SLUG>'
     AND ("plan_id" IN ('thai-alumni', 'alumni') OR "plan_name"->>'en' ILIKE '%alumni%')
     AND "renewal_tier_bucket" <> 'thai_alumni';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'Thai-alumni repair: % rows updated', affected_count;

  -- partnership → partnership
  UPDATE "membership_plans"
     SET "renewal_tier_bucket" = 'partnership'
   WHERE "tenant_id" = '<NEW_TENANT_SLUG>'
     AND ("plan_id" IN ('partnership', 'partner') OR "plan_name"->>'en' ILIKE '%partner%')
     AND "renewal_tier_bucket" <> 'partnership';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'Partnership repair: % rows updated', affected_count;

  -- everything else stays as 'regular' (the 0094 default)
END $$;
```

> **VERIFICATION**: After running, query
> `SELECT "plan_id", "renewal_tier_bucket" FROM "membership_plans" WHERE "tenant_id" = '<NEW_TENANT_SLUG>' ORDER BY 1`
> and visually confirm each plan's bucket matches its semantic tier. Wrong buckets at this point cascade into wrong reminder schedules (F8 picks reminder steps from `tenant_renewal_schedule_policies` keyed on bucket) and wrong at-risk thresholds.

### 4. F8 — seed reminder schedules

Run the schedule policy seed (mirrors migration 0089) for the new tenant. Reuse `scripts/seed-renewal-schedule-policies.ts` (TBD).

### 5. F1 — bootstrap admin user

```bash
BOOTSTRAP_ADMIN_EMAIL=<admin@new-tenant.example> \
TENANT_SLUG=<NEW_TENANT_SLUG> \
pnpm tsx scripts/seed-bootstrap-admin.ts
```

### 6. Vercel — env wiring

Add per-tenant subdomain (e.g. `<slug>.zyncdata.app`) → bind to the same project. Tenant resolution lives in `src/lib/tenant-context.ts` via the host header.

### 7. cron-job.org — register F7 + F8 schedules

Per `docs/runbooks/cron-jobs.md` § 5 (F7) + § 6 (F8). The cron endpoints are tenant-scoped via the URL `[tenantId]` segment, so each new tenant needs its own cron entries (4 F7 + 6 F8 = 10 new cron-job.org rows).

### 8. Post-onboarding smoke test

1. Sign in as the bootstrap admin → `/admin` shell renders with new tenant context
2. Create a test member + plan → invoice flow → payment → renewal cycle creation
3. Verify `pnpm check:multi-tenant` still passes 24/24 SCOPED tables for the new tenant slug

### 9. Large-tenant index hardening (CONCURRENTLY out-of-band) — OPTIONAL

> **WHEN**: Only for a new tenant whose `renewal_cycles` table is expected to be large at onboarding time (e.g. a bulk historical import of tens of thousands of cycles), AND that tenant shares the live deployment with other active tenants. For SweCham scale (~131 members) this is a no-op — skip it.
>
> **WHY**: Migration `0215_f8_renewal_cycles_member_recency_idx.sql` creates `renewal_cycles_member_recency_idx` with `CREATE INDEX IF NOT EXISTS` (NOT `CONCURRENTLY`). The Drizzle migration runner (`scripts/run-migrations.ts` → `drizzle-orm/postgres-js` migrator) wraps every migration in a single transaction, and Postgres forbids `CREATE INDEX CONCURRENTLY` inside a transaction block (SQLSTATE 25001). So the migration intentionally uses the blocking form. A blocking `CREATE INDEX` takes a SHARE lock on `renewal_cycles` for the duration of the build — sub-second on small tables, but proportional to row count on a large one, during which writes to that tenant's renewal cycles block.

Because `IF NOT EXISTS` makes the migration a no-op once the index exists, you can build the index CONCURRENTLY out-of-band BEFORE the tenant's first run of `pnpm db:migrate` (or before importing the large cycle dataset). Run, outside any transaction, on the unpooled connection:

```sql
-- Run OUTSIDE a transaction (psql autocommit). Builds without a long SHARE lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "renewal_cycles_member_recency_idx"
  ON "renewal_cycles" ("tenant_id", "member_id", "created_at" DESC);
```

When migration 0215 later runs, its `IF NOT EXISTS` sees the index already present and does nothing. If `CREATE INDEX CONCURRENTLY` fails partway it leaves an INVALID index — drop it (`DROP INDEX CONCURRENTLY "renewal_cycles_member_recency_idx";`) and retry before letting the migration run.

---

## Rollback

If the new tenant must be removed (e.g. onboarding aborted mid-way):

```sql
-- Rollback in FK-reverse order
DELETE FROM renewal_cycles WHERE tenant_id = '<SLUG>';
DELETE FROM members WHERE tenant_id = '<SLUG>';
DELETE FROM membership_plans WHERE tenant_id = '<SLUG>';
DELETE FROM tenant_renewal_schedule_policies WHERE tenant_id = '<SLUG>';
DELETE FROM tenant_renewal_settings WHERE tenant_id = '<SLUG>';
DELETE FROM tenants WHERE slug = '<SLUG>';
```

Plus delete the cron-job.org entries and Vercel custom domain.

---

## Owner

F8 maintainer (renewals module) for steps 3–4. F1 maintainer for step 5. DevOps for steps 1, 6, 7.
