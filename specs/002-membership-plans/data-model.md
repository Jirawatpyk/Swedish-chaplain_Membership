# Data Model — F2 Membership Plans

**Feature**: F2 Membership Plans
**Branch**: `002-membership-plans`
**Date**: 2026-04-11
**Inputs**: [spec.md](./spec.md) (with Clarifications Q1–Q5) · [research.md](./research.md) · [`docs/membership-benefits-analysis.md`](../../docs/membership-benefits-analysis.md) · [`docs/saas-architecture.md`](../../docs/saas-architecture.md)

---

## 1. Overview

F2 introduces **two new tables** (`membership_plans`, `tenant_fee_config`) and **extends the F1 `audit_log` table** with three new columns (`payload jsonb`, `tenant_id text`) + 10 new values on the `audit_event_type` pgEnum. Both new F2 tables are tenant-scoped and protected by Postgres RLS policies that enforce `tenant_id = current_setting('app.current_tenant', TRUE)`. The extended `audit_log` gets a **permissive** RLS policy that allows NULL `tenant_id` rows (F1's cross-tenant identity-layer audit events) to remain globally visible while tenant-scoping F2's plan-event rows. For the SweCham single-tenant deployment the resolver emits the constant slug `'swecham'`, but the two-layer defence-in-depth is wired on day one per Constitution v1.4.0 Principle I.

**No `tenants` database table** is introduced in F2 (YAGNI — see plan.md § Constitution X). `tenant_id` is a `text` slug with no foreign key in F2; F10 will retrofit the FK to a real `tenants` table as part of multi-tenant onboarding. **However, a `tenants` *module* IS introduced** — `src/modules/tenants/` is a pure Domain-only module hosting the `TenantContext` branded type + constructors, imported by every tenant-scoped bounded context (critique E1/X2, 2026-04-11). This is a ~50-line TypeScript module with no Drizzle schema, no migrations, no table — just a cross-cutting type that survives F10 onboarding without modification.

---

## 2. Entities

### 2.1 `Plan` (Domain)

The authoritative in-code representation. Lives in `src/modules/plans/domain/plan.ts`.

```typescript
type Plan = {
  // Identity
  tenant_id: TenantSlug;              // branded string
  plan_id: PlanSlug;                  // branded string, e.g. 'premium', 'diamond'
  plan_year: PlanYear;                // branded number, e.g. 2026

  // Display & ordering
  plan_name: LocaleText;              // { en: string; th?: string; sv?: string }
  description: LocaleText;            // same shape, optional in full
  sort_order: number;                 // integer, lower = higher in dropdowns

  // Classification
  plan_category: PlanCategory;        // 'corporate' | 'partnership'
  member_type_scope: MemberTypeScope; // 'company' | 'individual' | 'both'  [Clarifications Q1]

  // Pricing — integer minor units only; currency resolved from tenant_fee_config.currency_code (critique P3)
  annual_fee_minor_units: number;     // integer, in the tenant's currency's smallest unit

  // Partnership → Corporate bundling
  includes_corporate_plan_id: PlanSlug | null;  // non-null only for partnership plans

  // Eligibility constraints — stored, not enforced in F2 (F3 enforces). Same currency as annual_fee (tenant-level).
  min_turnover_minor_units: number | null;
  max_turnover_minor_units: number | null;
  max_duration_years: number | null;  // null = unlimited, 2 = start-up
  max_member_age: number | null;      // null = unlimited, 35 = thai-alumni

  // Benefits matrix — structured, typed
  benefit_matrix: BenefitMatrix;

  // State
  is_active: boolean;                 // true = selectable in (future) F3 signup
  deleted_at: Timestamp | null;       // non-null = soft-deleted
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: UserId;                 // from F1
  updated_by: UserId;                 // from F1
};
```

**Uniqueness**: `(tenant_id, plan_id, plan_year)` is the composite primary key. Two plans with the same `plan_id` can coexist across different years (e.g. `(swecham, premium, 2026)` and `(swecham, premium, 2027)`) — this is year versioning (FR-012).

**State machine**:

```text
        ┌──────────┐
        │          │
        ▼          │
   (created)       │
        │          │
        │  activate│
        ▼          │
   ┌─────────┐     │
   │ active  │─────┘
   │         │
   └────┬────┘
        │ deactivate
        ▼
   ┌──────────┐  soft_delete  ┌──────────────┐
   │ inactive │──────────────▶│ soft_deleted │
   └──────────┘               └──────┬───────┘
        ▲                            │
        └────────────────────────────┘
                   undelete
```

- Created plans start in `active` state **when created via the wizard** or in `inactive` **when created via clone** (cloned plans need review before exposure per FR-008 + US2).
- `soft_delete` is allowed only from `inactive` and only when `zero active members attached` (FR-010). The active-members check is delegated to a **`MemberAttachmentChecker` port** declared in `src/modules/plans/application/ports.ts` with a single method `countActivePlanMembers(tenant: TenantContext, planId: PlanSlug, year: PlanYear): Promise<number>`. F2's Infrastructure ships a stub implementation at `src/modules/plans/infrastructure/members/stub-member-attachment-checker.ts` that always returns `0` (documented in a single file comment: *"F2 stub — F3 replaces with a real query against the `members` table"*). F3 replaces the stub with the real implementation through the same port — the Application layer and the contract are unchanged. This preserves the `409 plan_has_active_members` code path in F2 so downstream tests and error handling are stable, without creating a stub-in-perpetuity. Port wiring lives in `src/modules/plans/plans-deps.ts` (critique P7, 2026-04-11).
- `undelete` returns a plan to `inactive` state — never directly to `active`, so the admin is forced to reconfirm visibility.

### 2.2 `BenefitMatrix` (Domain value object)

Typed structure mirroring `docs/membership-benefits-analysis.md` §2 + §3.

```typescript
type BenefitMatrix = {
  // Brand Visibility (both categories)
  eblast_per_year: number;                      // 0..∞
  website_page_type:
    | 'member_news_update'
    | 'smes_spotlight'
    | 'student_intern_cv'
    | null;
  homepage_logo_category:
    | 'premium' | 'large' | 'regular' | 'start_up'
    | null;
  directory_listing_size: 'full_page' | 'half_page' | 'eighth_page' | null;

  // Events (base — both categories)
  event_discount_scope:
    | 'all_employees'
    | 'one_ticket_per_event'
    | 'none';
  events_cobranded_access: boolean;              // JFCCT, EABC etc.
  cultural_tickets_per_year: number;

  // Additional corporate benefits
  m2m_benefits_access: boolean;
  business_referrals: boolean;
  tailor_made_services: boolean;

  // Partnership-only — null for corporate plans
  partnership: null | {
    event_tickets_included: number;              // 6/4/2
    booth_included: boolean;
    rollup_logo_at_events: boolean;
    logo_on_merch: boolean;
    video_duration_minutes: number;              // 1.0 or 1.5 (stored as number — the fractional values are 1.0 and 1.5)
    video_frequency_scope:
      | 'all_events'
      | 'three_selected_events';
    website_logo_months: number;                 // 12/6/3
    banner_per_year: number;                     // 20/15/10
    newsletter_promotion: boolean;
    enewsletter_logo: boolean;
    directory_ad_position:
      | 'pages_1_and_2'
      | 'first_pages'
      | 'first_10_pages';
  };
};
```

**Validation rules**:

- If `plan_category === 'partnership'` then `benefit_matrix.partnership` MUST be non-null **and** `includes_corporate_plan_id` MUST be non-null (points at a corporate plan in the same `(tenant, year)`).
- If `plan_category === 'corporate'` then `benefit_matrix.partnership` MUST be null **and** `includes_corporate_plan_id` MUST be null.
- `video_duration_minutes` must be `1.0` or `1.5` (only observed values; a stricter union could be used).
- `homepage_logo_category` + `website_page_type` enums must match the plan's own tier — e.g. a `premium` plan cannot have `homepage_logo_category: 'large'`. This is an integrity rule enforced in the Domain validator.

### 2.3 `TenantFeeConfig` (Domain)

```typescript
type TenantFeeConfig = {
  tenant_id: TenantSlug;              // primary key — one row per tenant
  currency_code: string;              // ISO 4217, e.g. 'THB' — SINGLE authoritative currency for this tenant
  vat_rate: number;                   // decimal(5,4) → 0.0700 = 7%
  registration_fee_minor_units: number; // one-time new-member fee, in tenant's currency's smallest unit
  updated_at: Timestamp;
  updated_by: UserId;
};
```

- Exactly one row per `tenant_id`. On a new tenant onboarding, F10 inserts this row as part of the onboarding flow. For F2, the SweCham row is inserted by `seed-swecham-2026-plans.ts`.
- `vat_rate` is decimal with 4 decimal places — supports rates like 7.5% (`0.0750`), 12.345% (`0.1235` rounded), etc.
- `currency_code` on this row is **the authoritative currency for every money field in the tenant's catalogue** — per-plan `annual_fee_minor_units`, `min_turnover_minor_units`, `max_turnover_minor_units`, and this row's `registration_fee_minor_units` all share it. Per critique P3 (2026-04-11), per-plan currency is deliberately NOT stored in F2 — if and when a tenant with a mixed-currency catalogue actually onboards, an additive migration can retrofit per-plan `currency_code` columns without touching any F2 code.
- The `registration_fee_minor_units` is in the tenant's currency. SweCham: `100000` = 1,000.00 THB.

### 2.4 `Money` (Application/Infrastructure helper — not a persisted value object)

Because currency is single-valued per tenant (§ 2.3), `Money` in F2 is an **ephemeral helper** used at the Application boundary to hydrate + dehydrate money fields for presentation:

```typescript
type Money = {
  amount_minor_units: number;         // integer, in the currency's smallest unit (satang for THB)
  currency_code: string;              // ISO 4217, resolved from TenantFeeConfig.currency_code at Application boundary
};
```

**Invariants** (enforced by `src/modules/plans/domain/money.ts`):

- `amount_minor_units` is a **non-negative integer**. Rejected at construction: floats, negatives, `NaN`, `Infinity`.
- `currency_code` is a known ISO 4217 code. The Domain keeps a small allow-list `{ THB, SEK, EUR, USD, JPY, SGD, GBP, DKK, NOK, CHF }` — unknown codes are rejected to prevent typos.
- Arithmetic (`addVat`, `add`, `subtract`, `multiply`) only valid **within the same currency_code**. Cross-currency operations return an error, never silently convert.
- Formatting goes through `Intl.NumberFormat(locale, { style: 'currency', currency: code })` which knows the decimal places — we never hard-code "2 decimals".

**Repository pattern**: `plan-repo.ts` reads `tenant_fee_config.currency_code` once per request (cached inside `runInTenant`) and uses it to hydrate `Money` objects on read, then strips back to raw `*_minor_units` integers on write.

### 2.5 `TenantContext` (cross-cutting Domain — branded type — NEW `src/modules/tenants/` module per critique E1/X2)

```typescript
// src/modules/tenants/domain/tenant-context.ts
declare const tenantContextBrand: unique symbol;
export type TenantContext = {
  readonly slug: string;
  readonly [tenantContextBrand]: true;
};

export function asTenantContext(slug: string): TenantContext {
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) {
    throw new Error(`Invalid tenant slug: ${slug}`);
  }
  return { slug, [tenantContextBrand]: true } as TenantContext;
}
```

- **Module location**: `src/modules/tenants/` — a cross-cutting Domain-only module, not inside `plans/`. Rationale: critique E1/X2 (2026-04-11) — every F2+ bounded context (plans, F3 members, F4 invoices, …) needs to import `TenantContext`; placing it inside `plans/domain` would force siblings to deep-import through the plans barrel, which is wrong ownership.
- **Module shape**: only `domain/` subdirectory + public barrel `index.ts`. No application, no infrastructure, no database table. Just types + constructors.
- Created only by `asTenantContext(slug)` which validates `[a-z0-9-]{1,63}`.
- Every tenant-scoped Application use case takes `{ tenant: TenantContext; ... }` as an explicit dependency. Passing a raw string fails at compile time.
- The Infrastructure `runInTenant` helper requires a `TenantContext`, so the session variable `app.current_tenant` can only be set via a validated brand.

### 2.6 Audit event types (extending F1 audit_log — revised per critique E10, 2026-04-11)

**F1 baseline** (verified from `src/modules/auth/infrastructure/db/schema.ts`):
- `audit_log` table has columns `(id, timestamp, event_type, actor_user_id, target_user_id, source_ip, summary, request_id)`.
- `event_type` is a Postgres **enum** `audit_event_type` with 17 snake_case values (e.g., `sign_in_success`, `password_changed`, `invitation_redemption_failed`).
- **No `payload` column, no `tenant_id` column, no `severity` column** exists in F1.
- The `audit_log_immutable` trigger (migration `0001`) enforces append-only at the database level.
- F1 `audit_log` is **cross-tenant by design** — identity-layer audit (sign-in, password change, invitation) is not tenant-scoped.

**F2 extension plan** (applied by migration `0007_audit_log_f2_extension.sql` — see research.md § 12 for the SQL):
1. Widen `audit_event_type` enum with **10 new snake_case values**: `plan_created`, `plan_updated`, `plan_cloned`, `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`, `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated`. Each `ALTER TYPE ADD VALUE` statement is a separate top-level statement (Postgres forbids them inside a `BEGIN…COMMIT` block).
2. `ALTER TABLE audit_log ADD COLUMN payload jsonb` — nullable. F1 entries stay NULL. F2 entries populate it with field-level diffs.
3. `ALTER TABLE audit_log ADD COLUMN tenant_id text` — nullable. F1 entries stay NULL (cross-tenant). F2 entries populate it with the originating tenant slug.
4. Enable RLS on `audit_log` + `FORCE` + a **permissive** policy:
   ```sql
   USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', TRUE))
   ```
   This keeps F1 identity events visible to any tenant (as designed) while tenant-scoping F2 plan events.

**F2 event type catalogue**:

| Event type (snake_case) | Severity | Request-path vs scan | `payload` shape | Fires when |
|---|---|---|---|---|
| `plan_created` | info | request path | `{ plan_id, plan_year, plan_name_en, annual_fee_minor_units, category, member_type_scope }` | Admin creates a plan via wizard (FR-006) |
| `plan_updated` | info | request path | `{ plan_id, plan_year, diff: { [field]: {before, after} } }` | Admin edits a plan (FR-007); field-level diff |
| `plan_cloned` | info | request path | `{ source_year, target_year, plan_ids: [], count }` | Admin clones year (FR-008) |
| `plan_activated` | info | request path | `{ plan_id, plan_year }` | Admin toggles active (FR-009) |
| `plan_deactivated` | info | request path | `{ plan_id, plan_year }` | Admin toggles inactive (FR-009) |
| `plan_soft_deleted` | info | request path | `{ plan_id, plan_year }` | Admin soft-deletes (FR-010) |
| `plan_undeleted` | info | request path | `{ plan_id, plan_year }` | Admin restores (FR-011) |
| `fee_config_updated` | info | request path | `{ diff: { vat_rate?, currency_code?, registration_fee_minor_units? } }` | Admin updates fee config (FR-016) |
| `plan_not_found` | info | request path | `{ requested_plan_id, requested_year, method, route }` | Request path returns 404 on GET / PATCH / DELETE of a plan that does not exist (may be an innocent typo OR a cross-tenant probe — request path cannot tell the difference without a `BYPASS RLS` query, which is forbidden in the request path per critique E6) |
| `plan_cross_tenant_probe` | **high** | **scan escalation (F13)** | `{ requested_plan_id, found_in_tenant_id, original_event_id, actor_user_id, escalation_reason }` | Periodic super-admin scan (F13, future) finds a `plan_not_found` whose requested `plan_id` exists in another tenant — escalates to this event and fires the PagerDuty alert |

**Why `severity` is derived, not stored**: F1's audit_log schema has no severity column. Adding one would mean a schema change AND retrofitting 17 F1 event types with severity values (expensive + low value). Instead, **severity is derived at query time** by a lookup table in `src/modules/plans/domain/audit-event.ts`: `{ plan_cross_tenant_probe: 'high', default: 'info' }`. Observability tooling queries the table with the lookup, not from a DB column. If F5+ (payment events) need more severities, revisit then.

### 2.6a Audit payload diff shape (critique P9, 2026-04-11)

**Normative**: F2 audit events that carry a field-level diff use the shape:

```typescript
type AuditDiff = {
  [fieldName: string]: {
    before: unknown;   // exact column / field value BEFORE the mutation; null for create events
    after: unknown;    // exact column / field value AFTER the mutation; null for delete events
  };
};
```

Rules:

- **Only changed fields are included** — unchanged fields are omitted entirely, keeping the payload compact.
- **`before` and `after` carry the exact storage value**: integers for `*_minor_units`, booleans for `is_active`, JSONB objects verbatim for `plan_name` / `description` / `benefit_matrix`, ISO 8601 strings for timestamps.
- **Create events** (`plan_created`): `before` is `null` for every included field; `after` carries the created row's full value for each non-default field.
- **Soft-delete / undelete / activate / deactivate events**: payload contains only the single state field that changed (e.g. `{ is_active: { before: true, after: false } }` for `plan_deactivated`; `{ deleted_at: { before: null, after: "2026-04-11T10:00:00Z" } }` for `plan_soft_deleted`).
- **Clone events** (`plan_cloned`): payload is **not** a diff — it uses the shape `{ source_year: 2026, target_year: 2027, plan_ids: ["premium", ...], count: 9 }` as documented in § 2.6 and `contracts/plans-api.md` § 9.
- **Fee-config update events** (`fee_config_updated`): standard diff shape for each changed editable field (e.g. `{ vat_rate: { before: 0.0700, after: 0.0750 } }`). `currency_code` cannot appear in a diff in F2 because it is immutable (critique R1).
- **`plan_not_found` events**: payload is `{ requested_plan_id, requested_year, method, route }` as documented in § 2.6 — not a diff shape.
- **`plan_cross_tenant_probe` events**: payload is `{ requested_plan_id, found_in_tenant_id, original_event_id, actor_user_id, escalation_reason }` — not a diff shape.

**Zod schema location**: `src/modules/plans/domain/audit-event.ts` exports a discriminated-union `auditPayloadSchema` keyed by `event_type` that matches each event type to its payload shape. The audit writer in `src/modules/plans/application/record-audit-event.ts` validates the payload through the schema before inserting into `audit_log`. The test suite (`tests/integration/plans/audit-diff.test.ts`) imports the same schema and asserts that every captured payload round-trips through `auditPayloadSchema.safeParse(...)` with `success: true`. This single source of truth guarantees the audit writer and the test suite cannot drift on shape.

Retention inherits from F1 (≥ 5 years). Append-only guarantee inherits from F1 (the `audit_log_immutable` trigger continues to apply to F2 events automatically).

---

## 3. Database schema (Postgres / Drizzle)

### 3.1 Enums

```sql
CREATE TYPE plan_category AS ENUM ('corporate', 'partnership');
CREATE TYPE member_type_scope AS ENUM ('company', 'individual', 'both');
CREATE TYPE directory_listing_size AS ENUM ('full_page', 'half_page', 'eighth_page');
CREATE TYPE event_discount_scope AS ENUM ('all_employees', 'one_ticket_per_event', 'none');
CREATE TYPE website_page_type AS ENUM ('member_news_update', 'smes_spotlight', 'student_intern_cv');
CREATE TYPE homepage_logo_category AS ENUM ('premium', 'large', 'regular', 'start_up');
CREATE TYPE directory_ad_position AS ENUM ('pages_1_and_2', 'first_pages', 'first_10_pages');
CREATE TYPE video_frequency_scope AS ENUM ('all_events', 'three_selected_events');
```

### 3.2 `membership_plans`

```sql
CREATE TABLE membership_plans (
  -- Tenancy (MTA+STD — no FK to tenants table yet, F10 will add it)
  tenant_id              text           NOT NULL,

  -- Identity
  plan_id                text           NOT NULL,
  plan_year              integer        NOT NULL,

  -- Display
  plan_name              jsonb          NOT NULL,  -- LocaleText { en, th?, sv? }
  description            jsonb          NOT NULL DEFAULT '{"en":""}'::jsonb,
  sort_order             integer        NOT NULL DEFAULT 100,

  -- Classification
  plan_category          plan_category  NOT NULL,
  member_type_scope      member_type_scope NOT NULL,

  -- Pricing — integer minor units only. Currency comes from tenant_fee_config.currency_code (critique P3, 2026-04-11).
  annual_fee_minor_units    integer     NOT NULL CHECK (annual_fee_minor_units >= 0),

  -- Partnership ↔ Corporate bundling
  includes_corporate_plan_id text       NULL,

  -- Eligibility (optional) — all in the tenant's currency
  min_turnover_minor_units  integer     NULL CHECK (min_turnover_minor_units IS NULL OR min_turnover_minor_units >= 0),
  max_turnover_minor_units  integer     NULL CHECK (max_turnover_minor_units IS NULL OR max_turnover_minor_units >= 0),
  max_duration_years        integer     NULL CHECK (max_duration_years IS NULL OR max_duration_years > 0),
  max_member_age            integer     NULL CHECK (max_member_age IS NULL OR (max_member_age > 0 AND max_member_age < 200)),

  -- Benefits (typed JSONB — app validates shape)
  benefit_matrix         jsonb          NOT NULL,

  -- State
  is_active              boolean        NOT NULL DEFAULT true,
  deleted_at             timestamptz    NULL,
  created_at             timestamptz    NOT NULL DEFAULT NOW(),
  updated_at             timestamptz    NOT NULL DEFAULT NOW(),
  created_by             uuid           NOT NULL REFERENCES users(id),
  updated_by             uuid           NOT NULL REFERENCES users(id),

  -- Composite primary key
  PRIMARY KEY (tenant_id, plan_id, plan_year),

  -- Integrity constraints
  CONSTRAINT partnership_bundles_corporate CHECK (
    (plan_category = 'partnership' AND includes_corporate_plan_id IS NOT NULL)
    OR (plan_category = 'corporate' AND includes_corporate_plan_id IS NULL)
  ),

  -- Turnover range sanity
  CONSTRAINT turnover_range_ordered CHECK (
    min_turnover_minor_units IS NULL
    OR max_turnover_minor_units IS NULL
    OR min_turnover_minor_units < max_turnover_minor_units
  )
);

-- Indexes
CREATE INDEX membership_plans_tenant_year_idx
  ON membership_plans (tenant_id, plan_year)
  WHERE deleted_at IS NULL;

CREATE INDEX membership_plans_tenant_category_idx
  ON membership_plans (tenant_id, plan_category)
  WHERE deleted_at IS NULL;

CREATE INDEX membership_plans_tenant_active_idx
  ON membership_plans (tenant_id, is_active)
  WHERE deleted_at IS NULL;

-- Row Level Security
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans FORCE ROW LEVEL SECURITY;  -- applies even to table owner

CREATE POLICY tenant_isolation_on_membership_plans
  ON membership_plans
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
```

**Notes**:

- `FORCE ROW LEVEL SECURITY` means even the table owner role is subject to RLS. Only a superuser or a role with `BYPASS RLS` can bypass — we reserve that for future F13 super-admin operations only.
- `deleted_at IS NULL` partial indexes make the common "active catalogue read" path fast without scanning soft-deleted rows.
- Money fields are stored as a single integer column per field (`*_minor_units`). The currency code lives once per tenant on `tenant_fee_config.currency_code` and is joined / hydrated at the Application boundary (critique P3, 2026-04-11). A future tenant with a mixed-currency catalogue requirement can retrofit per-plan `*_currency` columns via an additive migration without breaking F2 code.

### 3.3 `tenant_fee_config`

```sql
CREATE TABLE tenant_fee_config (
  tenant_id                     text           PRIMARY KEY,
  currency_code                 text           NOT NULL,    -- ISO 4217 — AUTHORITATIVE for the tenant's catalogue
  vat_rate                      numeric(5, 4)  NOT NULL CHECK (vat_rate >= 0 AND vat_rate < 1),
  registration_fee_minor_units  integer        NOT NULL DEFAULT 0 CHECK (registration_fee_minor_units >= 0),
  updated_at                    timestamptz    NOT NULL DEFAULT NOW(),
  updated_by                    uuid           NOT NULL REFERENCES users(id)
);

ALTER TABLE tenant_fee_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_fee_config FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_on_fee_config
  ON tenant_fee_config
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
```

### 3.4 Audit log extension (revised per critique E10 verification, 2026-04-11)

F1's `audit_log` is a **real Postgres table with a `audit_event_type` pgEnum**, not a text column. F2 migration `0007_audit_log_f2_extension.sql` does three things (see research.md § 12 for the full SQL):

1. Extends the `audit_event_type` pgEnum with 10 new snake_case values via independent top-level `ALTER TYPE audit_event_type ADD VALUE 'plan_created'` statements (Postgres forbids these inside `BEGIN…COMMIT`).
2. Adds nullable columns to the existing table: `payload jsonb` (field-level diffs for F2 events) and `tenant_id text` (tenant scoping for F2 events).
3. Enables RLS on `audit_log` with a **permissive** policy that allows NULL `tenant_id` rows (F1 cross-tenant identity events) to remain globally visible while tenant-scoping F2 plan events.

F2's `audit_log_immutable` trigger from F1 migration 0001 continues to apply — the append-only guarantee is preserved automatically.

---

## 4. Drizzle schema sketch

```typescript
// src/modules/plans/infrastructure/db/schema.ts
import { pgTable, text, integer, boolean, jsonb, timestamp, pgEnum, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from '@/modules/auth/infrastructure/db/schema';  // F1

export const planCategoryEnum = pgEnum('plan_category', ['corporate', 'partnership']);
export const memberTypeScopeEnum = pgEnum('member_type_scope', ['company', 'individual', 'both']);

export const membershipPlans = pgTable(
  'membership_plans',
  {
    tenantId: text('tenant_id').notNull(),
    planId: text('plan_id').notNull(),
    planYear: integer('plan_year').notNull(),

    planName: jsonb('plan_name').$type<LocaleText>().notNull(),
    description: jsonb('description').$type<LocaleText>().notNull().default({ en: '' }),
    sortOrder: integer('sort_order').notNull().default(100),

    planCategory: planCategoryEnum('plan_category').notNull(),
    memberTypeScope: memberTypeScopeEnum('member_type_scope').notNull(),

    // Money: integer minor units only — currency lives on tenant_fee_config (critique P3)
    annualFeeMinorUnits: integer('annual_fee_minor_units').notNull(),

    includesCorporatePlanId: text('includes_corporate_plan_id'),

    minTurnoverMinorUnits: integer('min_turnover_minor_units'),
    maxTurnoverMinorUnits: integer('max_turnover_minor_units'),
    maxDurationYears: integer('max_duration_years'),
    maxMemberAge: integer('max_member_age'),

    benefitMatrix: jsonb('benefit_matrix').$type<BenefitMatrix>().notNull(),

    isActive: boolean('is_active').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    updatedBy: uuid('updated_by').notNull().references(() => users.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.planId, table.planYear] }),
    tenantYearIdx: index('membership_plans_tenant_year_idx').on(table.tenantId, table.planYear),
    tenantCategoryIdx: index('membership_plans_tenant_category_idx').on(table.tenantId, table.planCategory),
    tenantActiveIdx: index('membership_plans_tenant_active_idx').on(table.tenantId, table.isActive),
  }),
);

export const tenantFeeConfig = pgTable('tenant_fee_config', {
  tenantId: text('tenant_id').primaryKey(),
  currencyCode: text('currency_code').notNull(),    // Authoritative tenant currency
  vatRate: numeric('vat_rate', { precision: 5, scale: 4 }).notNull(),
  registrationFeeMinorUnits: integer('registration_fee_minor_units').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
});
```

**Drizzle + RLS caveat**: `drizzle-kit generate` does not emit `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` statements — those are added manually to the generated `0006_plans_and_fee_config.sql` migration file as a raw SQL block. This is normal Drizzle practice for RLS and is tested by `tests/integration/plans/tenant-isolation.test.ts` running on real Neon.

---

## 5. Validation rules (Domain)

Every plan mutation passes through the Domain validator before touching the repo. The validator is a zod schema composed from smaller schemas:

```typescript
// src/modules/plans/domain/plan-validators.ts
import { z } from 'zod';

const localeTextSchema = z.object({
  en: z.string().trim().min(1).max(120),
  th: z.string().trim().min(1).max(120).optional(),
  sv: z.string().trim().min(1).max(120).optional(),
});

// Per critique P3: currency lives on tenant_fee_config, not per-plan. Validators take raw minor_units integers.
const minorUnitsSchema = z.number().int().nonnegative().max(10_000_000_000);

const partnershipBenefitsSchema = z.object({
  event_tickets_included: z.number().int().nonnegative(),
  booth_included: z.boolean(),
  rollup_logo_at_events: z.boolean(),
  logo_on_merch: z.boolean(),
  video_duration_minutes: z.union([z.literal(1.0), z.literal(1.5)]),
  video_frequency_scope: z.enum(['all_events', 'three_selected_events']),
  website_logo_months: z.number().int().positive(),
  banner_per_year: z.number().int().nonnegative(),
  newsletter_promotion: z.boolean(),
  enewsletter_logo: z.boolean(),
  directory_ad_position: z.enum(['pages_1_and_2', 'first_pages', 'first_10_pages']),
});

const benefitMatrixSchema = z.object({
  eblast_per_year: z.number().int().nonnegative(),
  website_page_type: z.enum(['member_news_update', 'smes_spotlight', 'student_intern_cv']).nullable(),
  homepage_logo_category: z.enum(['premium', 'large', 'regular', 'start_up']).nullable(),
  directory_listing_size: z.enum(['full_page', 'half_page', 'eighth_page']).nullable(),
  event_discount_scope: z.enum(['all_employees', 'one_ticket_per_event', 'none']),
  events_cobranded_access: z.boolean(),
  cultural_tickets_per_year: z.number().int().nonnegative(),
  m2m_benefits_access: z.boolean(),
  business_referrals: z.boolean(),
  tailor_made_services: z.boolean(),
  partnership: partnershipBenefitsSchema.nullable(),
});

export const planSchema = z.object({
  plan_name: localeTextSchema,
  description: localeTextSchema.partial().extend({ en: z.string().trim().max(2000) }),
  sort_order: z.number().int().min(0).max(10_000),
  plan_category: z.enum(['corporate', 'partnership']),
  member_type_scope: z.enum(['company', 'individual', 'both']),
  annual_fee_minor_units: minorUnitsSchema,
  includes_corporate_plan_id: z.string().min(1).max(63).nullable(),
  min_turnover_minor_units: minorUnitsSchema.nullable(),
  max_turnover_minor_units: minorUnitsSchema.nullable(),
  max_duration_years: z.number().int().positive().nullable(),
  max_member_age: z.number().int().min(1).max(199).nullable(),
  benefit_matrix: benefitMatrixSchema,
}).superRefine((plan, ctx) => {
  // Corporate ↔ partnership integrity
  if (plan.plan_category === 'partnership' && plan.includes_corporate_plan_id === null) {
    ctx.addIssue({ code: 'custom', message: 'Partnership plans must bundle a corporate plan', path: ['includes_corporate_plan_id'] });
  }
  if (plan.plan_category === 'corporate' && plan.includes_corporate_plan_id !== null) {
    ctx.addIssue({ code: 'custom', message: 'Corporate plans cannot bundle another plan', path: ['includes_corporate_plan_id'] });
  }
  if (plan.plan_category === 'partnership' && plan.benefit_matrix.partnership === null) {
    ctx.addIssue({ code: 'custom', message: 'Partnership plans must have partnership benefits', path: ['benefit_matrix', 'partnership'] });
  }
  if (plan.plan_category === 'corporate' && plan.benefit_matrix.partnership !== null) {
    ctx.addIssue({ code: 'custom', message: 'Corporate plans cannot have partnership benefits', path: ['benefit_matrix', 'partnership'] });
  }
  // Turnover range sanity — single currency, just order check
  if (plan.min_turnover_minor_units !== null && plan.max_turnover_minor_units !== null) {
    if (plan.min_turnover_minor_units >= plan.max_turnover_minor_units) {
      ctx.addIssue({ code: 'custom', message: 'min_turnover must be less than max_turnover', path: ['max_turnover_minor_units'] });
    }
  }
});
```

Prior-year partial-lock is enforced **in addition** to the schema above by `detectLockedFieldChanges` (research.md § 8).

---

## 6. SweCham 2026 seed data (9 plans)

All money values are in THB minor units (satang). 36,000 THB = `3_600_000`. Stored inactive=false=active? Per US1 AS1, seed plans are **active** by default because SweCham is already operating against them.

### 6.1 Corporate (6 rows)

| plan_id | plan_name.en | annual_fee | min_turnover | max_turnover | max_duration | max_age | eblast | website_page | homepage_logo | directory | discount_scope | cobranded | cultural_tickets | m2m | referrals | tailor | member_type |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `premium`     | Premium Corporate    | 3_600_000 THB | 10_000_000_000 | — | — | — | 6 | member_news_update | premium   | full_page   | all_employees       | true  | 2 | true  | true  | true  | company |
| `large`       | Large Corporate      | 2_600_000 THB | 5_000_000_000  | 10_000_000_000 | — | — | 3 | member_news_update | large     | full_page   | all_employees       | true  | 1 | true  | true  | true  | company |
| `regular`     | Regular Corporate    | 1_600_000 THB | —              | 5_000_000_000  | — | — | 1 | member_news_update | regular   | half_page   | all_employees       | false | 0 | true  | true  | true  | company |
| `start-up`    | Start-up             | 1_000_000 THB | —              | —              | 2 | — | 0 | smes_spotlight     | start_up  | half_page   | all_employees       | false | 0 | true  | true  | false | company |
| `individual`  | Individual           | 600_000 THB   | —              | —              | — | — | 0 | —                  | —         | eighth_page | one_ticket_per_event| false | 0 | false | false | false | individual |
| `thai-alumni` | Thai Alumni/Student  | 100_000 THB   | —              | —              | — | 35 | 0 | student_intern_cv  | —         | eighth_page | one_ticket_per_event| false | 0 | false | false | false | individual |

Notes:
- `min_turnover` and `max_turnover` figures are in THB minor units — e.g. 100_000_000 THB = 10_000_000_000 satang.
- `includes_corporate_plan_id` = `null` for all corporate rows.
- `benefit_matrix.partnership` = `null` for all corporate rows.

### 6.2 Partnership (3 rows)

| plan_id | plan_name.en | annual_fee | includes_corp | event_tickets | video_min | video_scope | website_logo_mo | banner | eblast | dir_ad_pos |
|---|---|---|---|---|---|---|---|---|---|---|
| `diamond`   | Diamond Partnership   | 20_000_000 THB | `premium` | 6 | 1.5 | all_events          | 12 | 20 | 15 | pages_1_and_2 |
| `platinum`  | Platinum Partnership  | 15_000_000 THB | `premium` | 4 | 1.0 | all_events          |  6 | 15 | 10 | first_pages   |
| `gold`      | Gold Partnership      | 10_000_000 THB | `premium` | 2 | 1.0 | three_selected_events | 3 | 10 |  6 | first_10_pages|

Notes:
- All three set `booth_included`, `rollup_logo_at_events`, `logo_on_merch`, `newsletter_promotion`, `enewsletter_logo` to `true`.
- All three set `events_cobranded_access = true`, `m2m_benefits_access = true`, `business_referrals = true`, `tailor_made_services = true` (inherited from the Premium they bundle — duplicated onto the partnership row for flat-lookup simplicity).
- `member_type_scope = 'company'` for all three.

### 6.3 Seed plan name examples (localised)

```jsonc
{ "en": "Premium Corporate",   "sv": "Premium företagsmedlem",   "th": "สมาชิกองค์กรระดับพรีเมียม" }
{ "en": "Large Corporate",     "sv": "Större företagsmedlem",    "th": "สมาชิกองค์กรขนาดใหญ่" }
{ "en": "Regular Corporate",   "sv": "Vanlig företagsmedlem",    "th": "สมาชิกองค์กรทั่วไป" }
{ "en": "Start-up",            "sv": "Startup",                  "th": "สมาชิกสตาร์ทอัป" }
{ "en": "Individual",          "sv": "Privatmedlem",             "th": "สมาชิกบุคคลทั่วไป" }
{ "en": "Thai Alumni/Student", "sv": "Thailändsk alumn/student", "th": "สมาชิกศิษย์เก่า/นักศึกษาไทย" }
{ "en": "Diamond Partnership", "sv": "Diamond partnerskap",      "th": "พาร์ทเนอร์ระดับเพชร" }
{ "en": "Platinum Partnership","sv": "Platinum partnerskap",     "th": "พาร์ทเนอร์ระดับแพลตตินัม" }
{ "en": "Gold Partnership",    "sv": "Gold partnerskap",         "th": "พาร์ทเนอร์ระดับทอง" }
```

(Translations are best-effort starting values — admin can edit after seed runs. They satisfy the "EN required, TH/SV optional" validator and give the UI populated text out of the box rather than "missing translation" for every row.)

### 6.4 Tenant fee config row

```jsonc
{
  "tenant_id": "swecham",
  "currency_code": "THB",
  "vat_rate": 0.0700,
  "registration_fee_minor_units": 100000   // 1,000.00 THB — single tenant currency applies
}
```

---

## 7. Read patterns

### 7.1 List plans for current year (US1)

```typescript
// Application: list-plans.ts
const plans = await planRepo.findByTenantAndYear({
  tenant: deps.tenant,                       // TenantContext — used by runInTenant
  year: input.year ?? currentYear(deps.clock),
  includeDeleted: input.showDeleted ?? false,
  includeInactive: true,                     // admin sees both
  filter: { category: input.category, searchText: input.q },
});
```

SQL emitted (pseudocode):

```sql
SET LOCAL app.current_tenant = 'swecham';  -- injected by runInTenant
SELECT * FROM membership_plans
WHERE plan_year = 2026
  AND ($1::text IS NULL OR plan_category = $1)
  AND ($2::text IS NULL OR plan_name->>'en' ILIKE '%' || $2 || '%')
  AND ($3::bool IS TRUE OR deleted_at IS NULL)
ORDER BY plan_category DESC, sort_order ASC;
```

RLS implicitly adds `AND tenant_id = 'swecham'` at the policy layer — the application query does not need an explicit `WHERE tenant_id`. This is the desired pattern: the application code is tenant-agnostic, and adding `WHERE tenant_id` explicitly would be a code smell (implying distrust of the RLS layer).

### 7.2 Cross-tenant probe — 404 never 403

```typescript
// Application: get-plan.ts
export async function getPlan(input, deps): Promise<Result<Plan, GetPlanError>> {
  const plan = await deps.planRepo.findOne({ tenant: deps.tenant, planId: input.planId, year: input.year });
  if (!plan) {
    // Could be: plan doesn't exist, OR plan belongs to a different tenant (RLS returned 0 rows)
    // Either way: 404, never leak existence.
    return err({ type: 'not_found' });
  }
  return ok(plan);
}
```

The API route wraps this and additionally logs a `plan_not_found` audit event on every admin 404 (info severity). A separate periodic super-admin scan (F13, future) correlates `plan_not_found` events across tenants and escalates matches to `plan_cross_tenant_probe` high-severity events. **Request-path code never runs a `BYPASS RLS` query** — eliminates the privilege-escalation vector (critique E6, 2026-04-11).

---

## 8. Test fixtures

`tests/integration/plans/tenant-isolation.test.ts` uses two tenants:

```typescript
const TENANT_A = asTenantContext('test-swecham');
const TENANT_B = asTenantContext('test-chamber');

// Seed: 3 plans in A, 3 different plans in B
// Then:
// 1. With session var = A, list → expect A's 3 plans only
// 2. With session var = A, get by B's plan_id → expect 404
// 3. With session var = A, update B's plan → expect 0 rows affected / rejected
// 4. With session var = A, delete B's plan → expect 0 rows affected / rejected
// 5. With session var = B, same four checks with directions swapped
// 6. With session var unset (`RESET app.current_tenant`), any read → expect 0 rows
```

This is the Review-Gate blocker test per Constitution v1.4.0 Principle I clause 3.

---

## 9. Summary

| Item | Count / Value |
|---|---|
| New tables | 2 (`membership_plans`, `tenant_fee_config`) |
| Tables extended | 1 (`audit_log` — new `payload`, `tenant_id` columns + widened enum) |
| Migrations | 2 (`0006_plans_and_fee_config.sql`, `0007_audit_log_f2_extension.sql`) |
| New Postgres enums | 8 (`plan_category`, `member_type_scope`, `directory_listing_size`, `event_discount_scope`, `website_page_type`, `homepage_logo_category`, `directory_ad_position`, `video_frequency_scope`) |
| `audit_event_type` enum values added | 10 (snake_case: `plan_created`, `plan_updated`, `plan_cloned`, `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`, `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated`) |
| RLS policies | 3 (`membership_plans`, `tenant_fee_config`, `audit_log` permissive) |
| Seed rows (SweCham 2026) | 9 plans + 1 fee config row |
| New Domain modules | 2 (`src/modules/tenants/` cross-cutting + `src/modules/plans/` bounded context) |
| New Domain types | 10+ (Plan, BenefitMatrix, Money helper, LocaleText, TenantContext, PlanYear, PlanSlug, TenantSlug, MemberTypeScope, PlanCategory, …) |

**Ready for [contracts/plans-api.md](./contracts/plans-api.md) + [quickstart.md](./quickstart.md).**
