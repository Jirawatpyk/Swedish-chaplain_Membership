# Human-Readable Member Number — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-readable, per-tenant, sequential member number (e.g. `SCCM-0042`) as a display identifier across admin, portal, and tax PDFs — keeping the existing `members` UUID composite PK as the only key used in URLs and backend lookups.

**Architecture:** Additive. New nullable→`NOT NULL` `members.member_number` integer + two new per-tenant tables: `tenant_member_sequences` (lifetime counter) and `tenant_member_settings` (display prefix). An advisory-locked `MemberNumberAllocatorPort` runs **inside** `createMember`'s `runInTenant` tx (outside = RLS bypass). The integer is stored; the display string is derived by a pure Domain `formatMemberNumber`. Tax PDFs snapshot the number **at issue** (membership invoices only); already-issued invoices are never backfilled (§86/4 immutability).

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`), Next.js 16 App Router / React 19, Drizzle ORM + Neon Postgres (RLS+FORCE), Vitest + Playwright + axe-core, next-intl (EN/TH/SV), pnpm.

**Spec:** `docs/superpowers/specs/2026-06-05-member-number-design.md` · **Branch:** `055-member-number` · **Migrations:** `0209` (schema+backfill) + `0210` (audit enum).

---

## Execution order (TDD-ordered task groups)

Run the groups **in this order** — each builds on the prior. Within a group, tasks are sequential.

| # | Group | Covers (design §) | Gate |
|---|-------|-------------------|------|
| 1 | **MIG** — migrations + Drizzle schema | §4, §6 | apply 0209/0210 on Neon + `pnpm test:integration` BEFORE committing schema+code |
| 2 | **DOM** — `MemberNumber` value object | §7 | Domain 100% line+branch |
| 3 | **ALLOC** — allocator + settings ports/impls | §5 | live-Neon concurrency test |
| 4 | **CM** — `createMember` wiring + `rowToMember` | §5 | allocator inside `runInTenant`; audit `member_number_assigned` |
| 5 | **ADMIN** — list (+skeleton) / detail / search / i18n | §8.1, §8.2, §8.4, §10 | skeleton CLS-0; search parser in Application |
| 6 | **PORTAL** — portal + serializer + GDPR export | §8.3 | dual serializer emits `member_number`; GDPR `profile.json` |
| 7 | **PDF** — snapshot + template | §8.5 | interface+zod same task; `!== null` guard; no retro-backfill |
| 8 | **TEST** — cross-tenant + DB backstop + audit-count + E2E | §9, §11 | Principle I cross-tenant blocker |

**Cross-group invariants (CANON — identical names everywhere):**
`MemberNumber` (branded `number`), `asMemberNumber(n)`, `formatMemberNumber(prefix, n, pad=4)`, `parseMemberNumberQuery(q): number|null`, `MemberNumberAllocatorPort.allocate(tx, tenantId)`, `MemberSettingsReaderPort.getPrefix(tx, tenantId)`, tables `tenant_member_sequences` / `tenant_member_settings`, audit `member_number_assigned` (F3 union — **never** the F1 `AUDIT_EVENT_TYPES` count, which stays 32), advisory key `hashtextextended('members:'||tenantId, 0)`.

---

## Plan corrections (AUTHORITATIVE — override any conflicting inline wording below)

During parallel drafting, two groups referred to the member-settings reader by invented group names ("SETTINGS", "FOUNDATION"). **There is no such group.** Authoritative resolution:

1. **`MemberSettingsReaderPort` + `drizzleMemberSettingsRepo` live in Group ALLOC.** Any inline mention of a "SETTINGS group" / "FOUNDATION group" means **Group ALLOC**. ALLOC precedes ADMIN/PORTAL/PDF in the execution order, so the reader is always available downstream — there is **no conditional "gate behind" dependency and no `TODO` to leave** for it.
2. **Prefix at display time** (admin list/detail, portal, search, PDF) is resolved **only** via a read-only `runInTenant` wrapper — never a raw `db` query (RLS-bypass gotcha):
   ```ts
   const prefix = await runInTenant(tenantCtx, (tx) => deps.memberSettings.getPrefix(tx, tenantId));
   const display = formatMemberNumber(prefix, asMemberNumber(member.memberNumber));
   ```
   `getPrefix(tx, tenantId)` keeps the CANON signature; display consumers supply the `tx` from the read-only `runInTenant`.
3. **`deps.memberSettings: MemberSettingsReaderPort`** is added to `buildMembersDeps` (wired to `drizzleMemberSettingsRepo`) in **Group ALLOC**; ADMIN/PORTAL/PDF consume it.

---

## Migrations 0209 + 0210 + Drizzle Schema (GROUP: MIG)

**Scope**: Two new tables (`tenant_member_sequences`, `tenant_member_settings`), one new column (`members.member_number`), migration 0209 (tables + backfill + constraints), migration 0210 (audit enum extension), Drizzle schema files for both new tables, column addition to `schema-members.ts`, barrel export, and the F3 audit union extension.

**Order dependency**: MIG-1 → MIG-2 → MIG-3 (schema edit is unsafe until migration applies) → MIG-4 (enum migration) → MIG-5 (audit port) → MIG-6 (apply + integration gate).

---

### Task MIG-1: Create `schema-member-sequences.ts` and `schema-member-settings.ts` + barrel export

**Files:**
- Create: `src/modules/members/infrastructure/db/schema-member-sequences.ts`
- Create: `src/modules/members/infrastructure/db/schema-member-settings.ts`
- Modify: `src/modules/members/infrastructure/db/schema-members.ts` (add nullable `memberNumber` column — lines 168-198 table definition block; add after `updatedAt` before closing `}`)
- Modify: `src/modules/auth/infrastructure/db/schema.ts` (the Drizzle schema import `*` used by `src/lib/db.ts` does NOT import members schemas — members schemas are only used by the member repo; no barrel change needed there)

- [ ] **Step 1: Write the failing test** — typecheck is the test for schema shape; write a compile-only vitest import test:

```typescript
// tests/unit/members/infrastructure/schema-member-sequences.test.ts
import { describe, expect, it } from 'vitest';
import {
  tenantMemberSequences,
  type TenantMemberSequenceRow,
  type TenantMemberSequenceInsert,
} from '@/modules/members/infrastructure/db/schema-member-sequences';
import {
  tenantMemberSettings,
  type TenantMemberSettingsRow,
  type TenantMemberSettingsInsert,
} from '@/modules/members/infrastructure/db/schema-member-settings';

describe('schema-member-sequences', () => {
  it('tenantMemberSequences has required columns inferred correctly', () => {
    type _CheckRow = TenantMemberSequenceRow & {
      tenant_id: string;
      last_number: number;
      updated_at: Date;
    };
    expect(tenantMemberSequences._.name).toBe('tenant_member_sequences');
  });
});

describe('schema-member-settings', () => {
  it('tenantMemberSettings has required columns inferred correctly', () => {
    type _CheckRow = TenantMemberSettingsRow & {
      tenant_id: string;
      member_number_prefix: string;
      created_at: Date;
      updated_at: Date;
    };
    expect(tenantMemberSettings._.name).toBe('tenant_member_settings');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm vitest run tests/unit/members/infrastructure/schema-member-sequences.test.ts
```

Expected failure: `Cannot find module '@/modules/members/infrastructure/db/schema-member-sequences'`

- [ ] **Step 3: Implement**

Create `src/modules/members/infrastructure/db/schema-member-sequences.ts`:

```typescript
/**
 * F-member-number — per-tenant lifetime member-number counter.
 *
 * Separate from F4 `tenant_document_sequences` which is
 * (tenant_id, document_type, fiscal_year) and resets yearly per §87.
 * This counter is lifetime + never resets (gaps OK, no §87 obligation).
 *
 * RLS ENABLE + FORCE + chamber_app policy declared in migration 0209.
 * This file is Drizzle schema only — drizzle-kit cannot emit RLS.
 */
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tenantMemberSequences = pgTable('tenant_member_sequences', {
  tenantId: text('tenant_id').primaryKey(),
  lastNumber: integer('last_number').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantMemberSequenceRow =
  typeof tenantMemberSequences.$inferSelect;
export type TenantMemberSequenceInsert =
  typeof tenantMemberSequences.$inferInsert;
```

Create `src/modules/members/infrastructure/db/schema-member-settings.ts`:

```typescript
/**
 * F-member-number — per-tenant member-number display prefix config.
 *
 * Immutable after first member is created (no UPDATE use-case in MVP).
 * Prefix is seeded in migration 0209 for the SweCham tenant.
 * Format: ^[A-Z][A-Z0-9]{0,7}$ — 1–8 chars, uppercase alpha + digits.
 * Default 'M' applies for future tenants with no explicit seed row.
 *
 * RLS ENABLE + FORCE + chamber_app policy declared in migration 0209.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tenantMemberSettings = pgTable('tenant_member_settings', {
  tenantId: text('tenant_id').primaryKey(),
  memberNumberPrefix: text('member_number_prefix').notNull().default('M'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantMemberSettingsRow =
  typeof tenantMemberSettings.$inferSelect;
export type TenantMemberSettingsInsert =
  typeof tenantMemberSettings.$inferInsert;
```

Add nullable `memberNumber` column to `src/modules/members/infrastructure/db/schema-members.ts`. Insert after `updatedAt` (line 167) and before the closing `}` of the column block, before the `(table) =>` index array at line 169:

```typescript
    // F-member-number — human-readable display identifier.
    // NULLABLE in schema until migration 0209 backfill applies;
    // .notNull() is added in a SEPARATE edit only after 0209 is
    // verified applied (pnpm drizzle-kit migrate + pnpm test:integration).
    // See design doc §6 and migration 0094 idempotency comment.
    memberNumber: integer('member_number'),
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm vitest run tests/unit/members/infrastructure/schema-member-sequences.test.ts
```

Then typecheck:

```
pnpm typecheck
```

Expected: both pass, no type errors.

- [ ] **Step 5: Commit**

```
git add src/modules/members/infrastructure/db/schema-member-sequences.ts src/modules/members/infrastructure/db/schema-member-settings.ts src/modules/members/infrastructure/db/schema-members.ts tests/unit/members/infrastructure/schema-member-sequences.test.ts
git commit -m "$(cat <<'EOF'
feat(members): add Drizzle schemas for member-number tables (nullable column)

tenant_member_sequences + tenant_member_settings new schema files;
members.member_number added as nullable (NOT NULL tightened post-backfill).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task MIG-2: Write migration `0209_member_number_schema.sql`

**Files:**
- Create: `drizzle/migrations/0209_member_number_schema.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (append entry idx 209)

- [ ] **Step 1: Write the failing test** — the test is the migration itself applying cleanly; write a pre-apply integration test that probes the DB state:

```typescript
// tests/integration/members/migration-0209-pre-apply.test.ts
/**
 * RED gate — verifies the tables do NOT yet exist before 0209 is applied.
 * Run this ONCE before applying the migration to confirm baseline state.
 * Delete this file after 0209 is confirmed applied on Neon.
 *
 * After 0209 applies, replace this file with
 * migration-0209-post-apply.test.ts (see MIG-3 task).
 */
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

describe('migration 0209 — pre-apply baseline', () => {
  it('tenant_member_sequences table does not yet exist', async () => {
    const result = await db.execute(sql`
      SELECT to_regclass('public.tenant_member_sequences') AS oid
    `);
    expect(result.rows[0]?.oid).toBeNull();
  });

  it('tenant_member_settings table does not yet exist', async () => {
    const result = await db.execute(sql`
      SELECT to_regclass('public.tenant_member_settings') AS oid
    `);
    expect(result.rows[0]?.oid).toBeNull();
  });

  it('members.member_number column does not yet exist', async () => {
    const result = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'members'
        AND column_name = 'member_number'
    `);
    expect(result.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails with the expected baseline**

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0209-pre-apply.test.ts
```

Expected: all 3 pass (tables absent before migration). If any fail, 0209 was already partially applied — investigate before proceeding.

- [ ] **Step 3: Implement the migration**

Create `drizzle/migrations/0209_member_number_schema.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Migration 0209 — Member Number: new tables, backfill, constraints
--
-- Creates:
--   - tenant_member_sequences  (per-tenant lifetime counter)
--   - tenant_member_settings   (per-tenant prefix config)
--   - members.member_number    integer column (nullable → backfill → NOT NULL)
--
-- Backfill strategy:
--   PARTITION BY tenant_id is mandatory — without it ROW_NUMBER() runs
--   globally across tenants (cross-tenant data-corruption bug).
--   Tie-break: ORDER BY created_at ASC, member_id ASC (deterministic).
--
-- Idempotency: single-shot ALTER TABLE (no IF NOT EXISTS on column add —
-- see migration 0094 comment lines 16-21 and design doc §6). UNIQUE INDEX
-- uses IF NOT EXISTS. Seeds use ON CONFLICT DO NOTHING.
--
-- RLS: both new tables get ENABLE + FORCE + FOR ALL TO chamber_app.
-- Pattern mirrors tenant_document_sequences (migration 0019) and
-- tenant_payment_settings (migration 0035).
--
-- Rollback: DROP TABLE CASCADE on 2 tables; ALTER TABLE members DROP
-- COLUMN member_number; or Neon PITR to pre-0209 snapshot.
-- ---------------------------------------------------------------------------

-- --- 1. tenant_member_sequences -------------------------------------------

CREATE TABLE "tenant_member_sequences" (
  "tenant_id"   text PRIMARY KEY,
  "last_number" integer NOT NULL DEFAULT 0
                  CHECK ("last_number" >= 0),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_member_sequences" TO chamber_app;--> statement-breakpoint

ALTER TABLE "tenant_member_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_member_sequences" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_member_sequences"
  ON "tenant_member_sequences"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 2. tenant_member_settings --------------------------------------------

CREATE TABLE "tenant_member_settings" (
  "tenant_id"             text PRIMARY KEY,
  "member_number_prefix"  text NOT NULL DEFAULT 'M'
                            CHECK ("member_number_prefix" ~ '^[A-Z][A-Z0-9]{0,7}$'),
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_member_settings" TO chamber_app;--> statement-breakpoint

ALTER TABLE "tenant_member_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_member_settings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_member_settings"
  ON "tenant_member_settings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 3. Seed SweCham prefix --------------------------------------------------
-- SET LOCAL + INSERT in the same implicit migration tx so FORCE RLS
-- applies against the correct tenant. Pattern mirrors migration 0037.

SET LOCAL app.current_tenant = 'swecham';
INSERT INTO "tenant_member_settings" ("tenant_id", "member_number_prefix")
  VALUES ('swecham', 'SCCM')
  ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint

-- --- 4. members.member_number column (single-shot, no IF NOT EXISTS) --------
-- Single-shot: no IF NOT EXISTS so a second pass fails loudly instead of
-- silently skipping the backfill + SET NOT NULL steps. See data-model §6.

ALTER TABLE "members" ADD COLUMN "member_number" integer;--> statement-breakpoint

-- --- 5. Backfill: assign 1..N PER TENANT -----------------------------------
-- PARTITION BY tenant_id is mandatory — without it ROW_NUMBER() runs
-- globally across tenants = cross-tenant member-number collision bug.

UPDATE "members" m
SET    "member_number" = sub.rn
FROM (
  SELECT "tenant_id", "member_id",
         ROW_NUMBER() OVER (
           PARTITION BY "tenant_id"
           ORDER BY "created_at" ASC, "member_id" ASC
         ) AS rn
  FROM "members"
) sub
WHERE m."tenant_id" = sub."tenant_id"
  AND m."member_id" = sub."member_id";--> statement-breakpoint

-- --- 6. Loud-fail verification BEFORE SET NOT NULL -------------------------
-- Mirrors migration 0094 lines 88-96. Aborts the migration if any row
-- is still NULL so the SET NOT NULL below never runs on a partial backfill.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "members" WHERE "member_number" IS NULL) THEN
    RAISE EXCEPTION 'member_number backfill failed: % rows still NULL',
      (SELECT COUNT(*) FROM "members" WHERE "member_number" IS NULL);
  END IF;
END $$;--> statement-breakpoint

-- --- 7. Seed each tenant's counter to its current max ----------------------
-- next new member = last_number + 1 (allocator protocol, design doc §5)

SET LOCAL app.current_tenant = 'swecham';
INSERT INTO "tenant_member_sequences" ("tenant_id", "last_number")
  SELECT "tenant_id", MAX("member_number")
  FROM   "members"
  GROUP  BY "tenant_id"
  ON CONFLICT ("tenant_id")
    DO UPDATE SET "last_number" = EXCLUDED."last_number";--> statement-breakpoint

-- --- 8. Tighten column to NOT NULL -----------------------------------------

ALTER TABLE "members"
  ALTER COLUMN "member_number" SET NOT NULL;--> statement-breakpoint

-- --- 9. Unique index (IF NOT EXISTS safe — no SET NOT NULL interaction) ----

CREATE UNIQUE INDEX IF NOT EXISTS "members_tenant_member_number_uniq"
  ON "members" USING btree ("tenant_id", "member_number");--> statement-breakpoint

-- --- 10. Positive check constraint -----------------------------------------

ALTER TABLE "members"
  ADD CONSTRAINT "members_member_number_positive"
    CHECK ("member_number" > 0);--> statement-breakpoint
```

Append to `drizzle/migrations/meta/_journal.json` — add after entry idx 208 (timestamp `1798533700000`), using next timestamp `1798533800000`:

```json
{
  "idx": 209,
  "version": "7",
  "when": 1798533800000,
  "tag": "0209_member_number_schema",
  "breakpoints": true
}
```

- [ ] **Step 4: Run test, verify pass** — the pre-apply test file is already deleted at this stage; after applying migration run:

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0209-pre-apply.test.ts
```

Expected: the 3 "does not exist" assertions now FAIL (tables exist) — confirming migration ran. This file is then deleted in Step 5.

- [ ] **Step 5: Commit**

```
git add drizzle/migrations/0209_member_number_schema.sql drizzle/migrations/meta/_journal.json tests/integration/members/migration-0209-pre-apply.test.ts
git commit -m "$(cat <<'EOF'
feat(members): migration 0209 — member-number tables, backfill, constraints

tenant_member_sequences + tenant_member_settings + members.member_number;
PARTITION BY tenant_id backfill; loud-fail verify DO block; SET NOT NULL;
UNIQUE INDEX; positive CHECK. SweCham seed prefix=SCCM, counter=MAX.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task MIG-3: Apply migration 0209 + tighten schema `.notNull()` + post-apply integration test

**Files:**
- Modify: `src/modules/members/infrastructure/db/schema-members.ts` (add `.notNull()` to `memberNumber` column — ONLY after migration applies)
- Create: `tests/integration/members/migration-0209-post-apply.test.ts`
- Delete: `tests/integration/members/migration-0209-pre-apply.test.ts`

**IMPORTANT — Project gotcha (CLAUDE.md § Gotchas):** Run `pnpm drizzle-kit migrate` BEFORE editing schema to `.notNull()` and BEFORE committing. Unit-test mocks hide the schema gap; failure only surfaces against live Neon.

- [ ] **Step 1: Write the failing test** (post-apply DB probe):

```typescript
// tests/integration/members/migration-0209-post-apply.test.ts
/**
 * Verifies migration 0209 applied correctly against live Neon.
 * Run AFTER `pnpm drizzle-kit migrate`.
 */
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

describe('migration 0209 — post-apply verification', () => {
  it('tenant_member_sequences table exists with expected columns', async () => {
    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tenant_member_sequences'
      ORDER BY ordinal_position
    `);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('last_number');
    expect(cols).toContain('updated_at');
  });

  it('tenant_member_settings table exists with expected columns', async () => {
    const result = await db.execute(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'tenant_member_settings'
      ORDER BY ordinal_position
    `);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('member_number_prefix');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('members.member_number column is NOT NULL integer', async () => {
    const result = await db.execute(sql`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'members'
        AND column_name = 'member_number'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data_type).toBe('integer');
    expect(result.rows[0]?.is_nullable).toBe('NO');
  });

  it('members_tenant_member_number_uniq unique index exists', async () => {
    const result = await db.execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'members'
        AND indexname = 'members_tenant_member_number_uniq'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.indexdef).toContain('tenant_id');
    expect(result.rows[0]?.indexdef).toContain('member_number');
  });

  it('members_member_number_positive CHECK constraint exists', async () => {
    const result = await db.execute(sql`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'members'
        AND constraint_name = 'members_member_number_positive'
        AND constraint_type = 'CHECK'
    `);
    expect(result.rows).toHaveLength(1);
  });

  it('tenant_member_sequences RLS is FORCE enabled', async () => {
    const result = await db.execute(sql`
      SELECT rowsecurity, forcerowsecurity
      FROM pg_class
      WHERE relname = 'tenant_member_sequences'
    `);
    expect(result.rows[0]?.rowsecurity).toBe(true);
    expect(result.rows[0]?.forcerowsecurity).toBe(true);
  });

  it('tenant_member_settings RLS is FORCE enabled', async () => {
    const result = await db.execute(sql`
      SELECT rowsecurity, forcerowsecurity
      FROM pg_class
      WHERE relname = 'tenant_member_settings'
    `);
    expect(result.rows[0]?.rowsecurity).toBe(true);
    expect(result.rows[0]?.forcerowsecurity).toBe(true);
  });

  it('swecham seed row in tenant_member_settings has prefix SCCM', async () => {
    // DB owner bypasses RLS; direct query is safe for migration verification.
    const result = await db.execute(sql`
      SELECT member_number_prefix
      FROM tenant_member_settings
      WHERE tenant_id = 'swecham'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.member_number_prefix).toBe('SCCM');
  });

  it('swecham seed row in tenant_member_sequences has last_number > 0 (or 0 if no members exist)', async () => {
    const result = await db.execute(sql`
      SELECT last_number FROM tenant_member_sequences WHERE tenant_id = 'swecham'
    `);
    // Row must exist; last_number is 0 if no members seeded, otherwise positive.
    expect(result.rows).toHaveLength(1);
    expect(typeof result.rows[0]?.last_number).toBe('number');
    expect(result.rows[0]?.last_number as number).toBeGreaterThanOrEqual(0);
  });

  it('DB backstop: INSERT member_number = 0 violates positive CHECK', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO members (tenant_id, member_id, company_name, country,
          plan_id, plan_year, member_number)
        VALUES ('__test_impossible__', gen_random_uuid(), 'X', 'TH',
          '__x__', 2024, 0)
      `)
    ).rejects.toThrow();
  });

  it('DB backstop: INSERT member_number = -1 violates positive CHECK', async () => {
    await expect(
      db.execute(sql`
        INSERT INTO members (tenant_id, member_id, company_name, country,
          plan_id, plan_year, member_number)
        VALUES ('__test_impossible__', gen_random_uuid(), 'X', 'TH',
          '__x__', 2024, -1)
      `)
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Apply the migration first, then run the test**

```
pnpm drizzle-kit migrate
```

Verify output shows `0209_member_number_schema` applied. Then run:

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0209-post-apply.test.ts
```

Expected: all assertions fail (tables not found) before migration; all pass after migration.

- [ ] **Step 3: Implement — tighten `.notNull()` in schema-members.ts**

Only after `pnpm drizzle-kit migrate` confirms 0209 applied, edit line in `src/modules/members/infrastructure/db/schema-members.ts` — change:

```typescript
    memberNumber: integer('member_number'),
```

to:

```typescript
    memberNumber: integer('member_number').notNull(),
```

Then run `pnpm drizzle-kit generate` to confirm drizzle-kit does NOT emit a new migration (the column already exists and is NOT NULL in the DB — the schema now matches). If drizzle-kit generates a migration, that means the migration was not applied — stop and apply it first.

- [ ] **Step 4: Run test, verify pass**

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0209-post-apply.test.ts
pnpm typecheck
```

Expected: all post-apply assertions pass; no type errors.

- [ ] **Step 5: Commit**

```
git add src/modules/members/infrastructure/db/schema-members.ts tests/integration/members/migration-0209-post-apply.test.ts
git rm tests/integration/members/migration-0209-pre-apply.test.ts
git commit -m "$(cat <<'EOF'
feat(members): tighten schema memberNumber to notNull + post-apply probe

.notNull() safe to add only after 0209 migration applies to live Neon.
Post-apply integration test covers RLS FORCE, UNIQUE index, CHECK, seeds.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task MIG-4: Write migration `0210_member_number_audit_enum.sql`

**Files:**
- Create: `drizzle/migrations/0210_member_number_audit_enum.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (append entry idx 210)

**Rationale for split:** Postgres forbids `ALTER TYPE … ADD VALUE` inside the same transaction as code that uses the new value. Migration 0209 and 0210 are separate files so each gets its own implicit transaction boundary (precedent: migrations 0010, 0043, 0046, 0095, 0116 — all are standalone enum-extension files).

- [ ] **Step 1: Write the failing test** — verify the enum value does NOT yet exist:

```typescript
// tests/integration/members/migration-0210-pre-apply.test.ts
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

describe('migration 0210 — pre-apply baseline', () => {
  it('member_number_assigned enum value does not yet exist in audit_event_type', async () => {
    const result = await db.execute(sql`
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
        AND e.enumlabel = 'member_number_assigned'
    `);
    expect(result.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test, verify it passes (enum value absent)**

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0210-pre-apply.test.ts
```

Expected: passes (value not yet in DB).

- [ ] **Step 3: Implement**

Create `drizzle/migrations/0210_member_number_audit_enum.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Migration 0210 — audit_event_type extension: member_number_assigned
--
-- MUST be a separate migration from 0209 because Postgres forbids
-- ALTER TYPE … ADD VALUE inside the same transaction as code that uses
-- the new value. Precedent: 0010 (F3), 0043/0046 (F5), 0095/0099 (F8).
--
-- Idempotency: DO block guards with pg_enum existence check — same
-- pattern as every preceding enum-extension migration in this repo.
--
-- Retention: 5 years (F3 default via drizzleAuditAdapter — no action
-- required here; audit_log.retention_years default trigger handles it).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'member_number_assigned'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_number_assigned';
  END IF;
END$$;
```

Append to `drizzle/migrations/meta/_journal.json` — add after entry idx 209, using timestamp `1798533900000`:

```json
{
  "idx": 210,
  "version": "7",
  "when": 1798533900000,
  "tag": "0210_member_number_audit_enum",
  "breakpoints": true
}
```

- [ ] **Step 4: Apply migration and run verification test**

```
pnpm drizzle-kit migrate
```

Then run:

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0210-pre-apply.test.ts
```

Expected: now FAILS (enum value exists) — confirming 0210 applied.

Delete the pre-apply test and run the canonical enum check:

```
pnpm test:integration --reporter=verbose tests/integration/members/migration-0209-post-apply.test.ts
```

- [ ] **Step 5: Commit**

```
git add drizzle/migrations/0210_member_number_audit_enum.sql drizzle/migrations/meta/_journal.json
git rm tests/integration/members/migration-0210-pre-apply.test.ts
git commit -m "$(cat <<'EOF'
feat(members): migration 0210 — add member_number_assigned to audit_event_type enum

Separate migration required (Postgres forbids ALTER TYPE ADD VALUE in
same tx as value use). Idempotent DO block. Retention 5y (F3 default).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task MIG-5: Extend `auditEventTypeEnum` in `schema.ts` + `F3AuditEventType` union + F3 count guard

**Files:**
- Modify: `src/modules/auth/infrastructure/db/schema.ts` — add `'member_number_assigned'` to `auditEventTypeEnum` pgEnum (after the last `054-event-fee-invoices` entry at line 324)
- Modify: `src/modules/members/application/ports/audit-port.ts` — add `'member_number_assigned'` to `F3AuditEventType` union (after line 58 `'member_preferred_locale_changed'`)
- Create: `tests/unit/members/application/f3-audit-event-type-count.test.ts` (new F3 count guard — mirrors F2/F8 pattern in `check-cross-module-audit-counts.ts`)

**Note:** The `check-cross-module-audit-counts.ts` script tracks F2 and F8 only. F3 uses a TypeScript union type (not a `const [] as const` array) so there is no existing count guard. Add a Vitest unit test that counts the union members at build time via a TypeScript tuple trick, creating the guard that the design doc requires. Do NOT modify `AUDIT_EVENT_TYPES` in `src/modules/auth/domain/audit-event.ts` — that is F1-only and must stay at 32.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/members/application/f3-audit-event-type-count.test.ts
/**
 * F3 audit-event-type count guard.
 *
 * Mirrors the F2/F8 count-guard pattern but for the F3 union type.
 * Since F3AuditEventType is a TS union (not a const tuple), we use
 * a compile-time assertion via a mapped type that becomes a string[]
 * at runtime. Any new event type added to the union but NOT to this
 * test array causes a TS error (TS2345), not a silent pass.
 *
 * IMPORTANT: when adding a new F3AuditEventType value, add it BOTH
 * to the union in audit-port.ts AND to the F3_AUDIT_EVENTS tuple below.
 * The toBe(N) assertion then needs updating to N+1.
 */
import { describe, expect, it } from 'vitest';
import type { F3AuditEventType } from '@/modules/members/application/ports/audit-port';

// Compile-time exhaustiveness: this tuple must list every value in
// F3AuditEventType. A missing value → TS2322; an extra value → TS2322.
// Runtime: length is asserted to catch stale count strings.
const F3_AUDIT_EVENTS: readonly F3AuditEventType[] = [
  'member_created',
  'member_updated',
  'member_plan_changed',
  'member_plan_manually_changed',
  'member_primary_contact_changed',
  'member_status_changed',
  'member_archived',
  'member_undeleted',
  'contact_created',
  'contact_updated',
  'contact_removed',
  'member_self_updated',
  'member_self_update_forbidden',
  'member_cross_tenant_probe',
  'plan_bundle_changed',
  'member_contact_email_changed',
  'user_sessions_revoked',
  'email_verification_sent',
  'email_verification_consumed',
  'email_change_notification_sent_to_old_address',
  'member_email_change_reverted',
  'email_verification_resent',
  'email_dispatch_failed',
  'invitation_bounced',
  'bulk_action_rate_limit_exceeded',
  'member_portal_invite_queued',
  'contact_linked_to_user',
  'member_preferred_locale_changed',
  'member_number_assigned',
] as const;

// Compile-time proof that the tuple covers the full union.
// If F3AuditEventType adds a new variant that is not in the tuple,
// TS cannot assign `(typeof F3_AUDIT_EVENTS)[number]` to
// `F3AuditEventType` exhaustively.
type _AssertF3Coverage = typeof F3_AUDIT_EVENTS extends
  readonly F3AuditEventType[]
  ? F3AuditEventType extends (typeof F3_AUDIT_EVENTS)[number]
    ? true
    : never
  : never;
const _: _AssertF3Coverage = true;

describe('F3AuditEventType count guard', () => {
  it('F3 audit event type count is 29 (28 prior + member_number_assigned)', () => {
    expect(F3_AUDIT_EVENTS.length).toBe(29);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm vitest run tests/unit/members/application/f3-audit-event-type-count.test.ts
```

Expected failure: TypeScript error `'member_number_assigned' is not assignable to type 'F3AuditEventType'` (union does not yet contain it).

- [ ] **Step 3: Implement**

In `src/modules/members/application/ports/audit-port.ts`, add to the `F3AuditEventType` union after line 58 (`'member_preferred_locale_changed'`):

```typescript
  // F-member-number — emitted by createMember immediately after the
  // allocation INSERT returns. Payload: { member_number: number }.
  // 5y retention (F3 default). See design doc §9 audit wiring.
  | 'member_number_assigned';
```

In `src/modules/auth/infrastructure/db/schema.ts`, add to `auditEventTypeEnum` after the last entry at line 324 (`'event_buyer_pii_redacted'`) and before the closing `]);`:

```typescript
  // --- member-number feature (migration 0210) — member lifecycle event ---
  //     Emitted by createMember after allocation (F3 audit adapter,
  //     5y retention). Payload: { member_number }. See design doc §9.
  'member_number_assigned',
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm vitest run tests/unit/members/application/f3-audit-event-type-count.test.ts
pnpm typecheck
```

Expected: count guard passes at 29; no type errors.

- [ ] **Step 5: Commit**

```
git add src/modules/auth/infrastructure/db/schema.ts src/modules/members/application/ports/audit-port.ts tests/unit/members/application/f3-audit-event-type-count.test.ts
git commit -m "$(cat <<'EOF'
feat(members): add member_number_assigned to F3AuditEventType + auditEventTypeEnum

Extends F3 union, auditEventTypeEnum pgEnum, and adds a count-guard test
(29 F3 types). Does NOT touch F1 AUDIT_EVENT_TYPES (stays 32).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task MIG-6: Full integration gate — apply migrations + run integration tests before code merge

**Files:** No new files — this task enforces the project gotcha from CLAUDE.md § Gotchas.

**This task is a process gate, not a code change.** It MUST be executed before the application-layer code (allocator, `createMember` wiring, repo) is committed. See design doc §6: "Apply migration + run integration tests BEFORE committing schema+code."

- [ ] **Step 1: No test to write** — verify CI pre-conditions are met.

- [ ] **Step 2: Apply both migrations**

```
pnpm drizzle-kit migrate
```

Confirm output includes both:
- `0209_member_number_schema` — applied
- `0210_member_number_audit_enum` — applied

If either shows "already applied" without being in the journal, stop — investigate journal drift before proceeding.

- [ ] **Step 3: Run the full integration suite for the members module**

```
pnpm test:integration --reporter=verbose tests/integration/members/
```

Expected: all existing member integration tests pass against the live Neon schema that now includes `member_number` NOT NULL. Any test that inserts a member via raw SQL (bypassing the allocator) will fail if it omits `member_number` — those tests must be updated in the allocator wiring task (MIG group is complete at this point; the Application group picks up from here).

- [ ] **Step 4: Run typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Commit gate note**

No commit needed — this is a verification gate. The absence of a commit here means the Application group (allocator, `createMember` wiring) may begin. If step 3 surfaces failures, file them as new tasks before proceeding.

---

## Domain — `MemberNumber` value object (tasks `DOM-1` … `DOM-4`)

This group owns the pure Domain layer for the member-number feature: a new branded value-object file plus the aggregate change. Zero framework imports (Principle III). Tasks are ordered so the brand + constructor land first, then the two pure helpers, then the aggregate wiring. The file lives at `src/modules/members/domain/value-objects/member-number.ts` (mirrors the sibling VO directory: `tax-id.ts`, `iso-country-code.ts`, etc.); tests live at `tests/unit/members/domain/member-number.test.ts` (mirrors `tax-id.test.ts`).

Canonical interfaces (cross-group contract — do not rename):
```ts
declare const MemberNumberBrand: unique symbol;
export type MemberNumber = number & { readonly [MemberNumberBrand]: true };
export function asMemberNumber(n: number): MemberNumber;            // throws InvalidMemberNumberError on non-integer or <= 0
export function formatMemberNumber(prefix: string, n: MemberNumber, pad?: number): string; // pad default 4 → SCCM-0042; auto-expands past 9999
export function parseMemberNumberQuery(q: string): number | null;  // SCCM-0042 / 0042 / 42 → 42 ; '' / SCCM- / -1 / 0 / x → null
```

---

### Task DOM-1: Branded `MemberNumber` + `asMemberNumber` constructor (throws on non-int / ≤0)

**Files:**
- Create: `src/modules/members/domain/value-objects/member-number.ts` (new VO file; lines 1-end)
- Test: `tests/unit/members/domain/member-number.test.ts` (new)

- [ ] Step 1: Write the failing test — REAL test code. Create `tests/unit/members/domain/member-number.test.ts` with only the `asMemberNumber` block (later tasks append `describe` blocks to the same file):

```ts
import { describe, expect, it } from 'vitest';
import {
  asMemberNumber,
  InvalidMemberNumberError,
  type MemberNumber,
} from '@/modules/members/domain/value-objects/member-number';

describe('asMemberNumber — branded positive-integer constructor', () => {
  it('accepts a positive integer and returns it branded', () => {
    const n = asMemberNumber(42);
    // brand is compile-time only; at runtime the value is the plain number
    expect(n).toBe(42);
  });

  it('accepts 1 (lower boundary)', () => {
    expect(asMemberNumber(1)).toBe(1);
  });

  it('rejects 0 with InvalidMemberNumberError', () => {
    expect(() => asMemberNumber(0)).toThrow(InvalidMemberNumberError);
  });

  it('rejects a negative integer (-1)', () => {
    expect(() => asMemberNumber(-1)).toThrow(InvalidMemberNumberError);
  });

  it('rejects a non-integer (1.5)', () => {
    expect(() => asMemberNumber(1.5)).toThrow(InvalidMemberNumberError);
  });

  it('rejects NaN', () => {
    expect(() => asMemberNumber(Number.NaN)).toThrow(InvalidMemberNumberError);
  });

  it('error carries the offending value for diagnostics', () => {
    try {
      asMemberNumber(0);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMemberNumberError);
      expect((e as InvalidMemberNumberError).value).toBe(0);
    }
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/domain/member-number.test.ts`. Expected failure: module resolution error (`Failed to resolve import "@/modules/members/domain/value-objects/member-number"`) because the file does not exist yet. RED.

- [ ] Step 3: Implement — REAL code. Create `src/modules/members/domain/value-objects/member-number.ts` with the brand, the typed error, and the constructor only (DOM-2/DOM-3 append the helpers):

```ts
/**
 * MemberNumber — human-readable, per-tenant, lifetime-sequential display id
 * for a Member (e.g. `SCCM-0042`). The UUID `MemberId` remains the surrogate
 * PK and the only value used in URLs / backend lookups; MemberNumber is a
 * display identifier only (design 2026-06-05-member-number-design.md §7).
 *
 * Pure Domain — zero framework imports (Constitution Principle III). Reused by
 * the PDF template (Infrastructure) and API serializers (Presentation) via the
 * members public barrel.
 *
 * Mirrors the surrogate-UUID + human-readable-code pattern F4 uses for invoice
 * `DocumentNumber`. Prefix validation (`^[A-Z][A-Z0-9]{0,7}$`) lives on the
 * settings table CHECK, not here — the format helper trusts its prefix arg.
 */

declare const MemberNumberBrand: unique symbol;

/**
 * A validated, positive-integer member number. The brand is compile-time only;
 * the runtime value is the plain integer (so `SET last_number` round-trips and
 * `padStart` works directly). Construct via `asMemberNumber`.
 */
export type MemberNumber = number & { readonly [MemberNumberBrand]: true };

/**
 * Thrown by `asMemberNumber` when the input is not a positive integer.
 * A throwing constructor (vs `Result`) matches the value-object's invariant:
 * a non-positive-integer member number is a programmer/DB-corruption error
 * (the DB `CHECK (member_number > 0)` + allocator make it unreachable for
 * well-formed rows), not a recoverable user-input failure.
 */
export class InvalidMemberNumberError extends Error {
  readonly value: number;
  constructor(value: number) {
    super(`Invalid member number: ${value} (must be a positive integer)`);
    this.name = 'InvalidMemberNumberError';
    this.value = value;
  }
}

/**
 * Brand a raw number as a MemberNumber. Throws `InvalidMemberNumberError` on a
 * non-integer (incl. NaN) or a value <= 0. Used by `rowToMember()` to convert
 * `row.member_number` and by the allocator's returned `last_number`.
 */
export function asMemberNumber(n: number): MemberNumber {
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidMemberNumberError(n);
  }
  return n as MemberNumber;
}
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/domain/member-number.test.ts`. Expected: 7 passing, 0 failing. GREEN.

- [ ] Step 5: Commit — explicit files only:
```
git add src/modules/members/domain/value-objects/member-number.ts tests/unit/members/domain/member-number.test.ts
git commit -m "feat(members): add branded MemberNumber value object + asMemberNumber"
```

---

### Task DOM-2: `formatMemberNumber` (pad default 4, auto-expands past 9999)

**Files:**
- Modify: `src/modules/members/domain/value-objects/member-number.ts` (append `formatMemberNumber` after `asMemberNumber`)
- Test: `tests/unit/members/domain/member-number.test.ts` (append a `describe` block)

- [ ] Step 1: Write the failing test — append to `tests/unit/members/domain/member-number.test.ts`. Add `formatMemberNumber` to the existing import from the VO module, then add:

```ts
describe('formatMemberNumber — {prefix}-{zeroPad}', () => {
  it('pads to width 4 by default (SCCM-0042)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(42))).toBe('SCCM-0042');
  });

  it('pads a single digit (M-0001)', () => {
    expect(formatMemberNumber('M', asMemberNumber(1))).toBe('M-0001');
  });

  it('renders an exact-width number without extra padding (SCCM-9999)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(9999))).toBe('SCCM-9999');
  });

  it('auto-expands past the pad width (SCCM-10000, no truncation)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(10000))).toBe('SCCM-10000');
  });

  it('auto-expands far past the pad width (SCCM-123456)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(123456))).toBe('SCCM-123456');
  });

  it('honours an explicit pad override', () => {
    expect(formatMemberNumber('M', asMemberNumber(42), 6)).toBe('M-000042');
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/domain/member-number.test.ts`. Expected failure: `formatMemberNumber is not a function` / named-import resolution error (function not yet exported). RED.

- [ ] Step 3: Implement — append to `src/modules/members/domain/value-objects/member-number.ts`:

```ts
/**
 * Render a MemberNumber as `{prefix}-{zeroPad}` — e.g. `SCCM-0042`.
 * `pad` defaults to 4 (`0001`–`9999`); `padStart` is a no-op once the
 * digit count meets/exceeds `pad`, so values past 9999 auto-expand
 * (`SCCM-10000`) with no truncation. Pure — used by the PDF template and
 * the API/portal serializers. The caller supplies the per-tenant `prefix`
 * (validated by the settings-table CHECK, not re-validated here).
 */
export function formatMemberNumber(
  prefix: string,
  n: MemberNumber,
  pad = 4,
): string {
  return `${prefix}-${String(n).padStart(pad, '0')}`;
}
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/domain/member-number.test.ts`. Expected: all `asMemberNumber` + `formatMemberNumber` cases pass (13 total). GREEN.

- [ ] Step 5: Commit — explicit files only:
```
git add src/modules/members/domain/value-objects/member-number.ts tests/unit/members/domain/member-number.test.ts
git commit -m "feat(members): add formatMemberNumber (pad 4, auto-expand)"
```

---

### Task DOM-3: `parseMemberNumberQuery` (returns null on empty / prefix-only / ≤0 / non-numeric)

**Files:**
- Modify: `src/modules/members/domain/value-objects/member-number.ts` (append `parseMemberNumberQuery`)
- Test: `tests/unit/members/domain/member-number.test.ts` (append a `describe` block)

- [ ] Step 1: Write the failing test — append to `tests/unit/members/domain/member-number.test.ts`. Add `parseMemberNumberQuery` to the existing VO import, then add:

```ts
describe('parseMemberNumberQuery — search-box parser → integer | null', () => {
  it('parses a fully-formatted number (SCCM-0042 → 42)', () => {
    expect(parseMemberNumberQuery('SCCM-0042')).toBe(42);
  });

  it('parses a zero-padded bare number (0042 → 42)', () => {
    expect(parseMemberNumberQuery('0042')).toBe(42);
  });

  it('parses a bare number (42 → 42)', () => {
    expect(parseMemberNumberQuery('42')).toBe(42);
  });

  it('trims surrounding whitespace ("  SCCM-0042  " → 42)', () => {
    expect(parseMemberNumberQuery('  SCCM-0042  ')).toBe(42);
  });

  it('is case-insensitive on the prefix (sccm-0042 → 42)', () => {
    expect(parseMemberNumberQuery('sccm-0042')).toBe(42);
  });

  it('returns null for an empty string', () => {
    expect(parseMemberNumberQuery('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseMemberNumberQuery('   ')).toBeNull();
  });

  it('returns null for prefix-only (SCCM-)', () => {
    expect(parseMemberNumberQuery('SCCM-')).toBeNull();
  });

  it('returns null for a negative number (-1)', () => {
    expect(parseMemberNumberQuery('-1')).toBeNull();
  });

  it('returns null for zero (0)', () => {
    expect(parseMemberNumberQuery('0')).toBeNull();
  });

  it('returns null for zero-padded zero (0000)', () => {
    expect(parseMemberNumberQuery('0000')).toBeNull();
  });

  it('returns null for a non-numeric query (NOT-A-NUMBER)', () => {
    expect(parseMemberNumberQuery('NOT-A-NUMBER')).toBeNull();
  });

  it('returns null for a bare non-numeric token (x)', () => {
    expect(parseMemberNumberQuery('x')).toBeNull();
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/domain/member-number.test.ts`. Expected failure: `parseMemberNumberQuery is not a function` / named-import resolution error. RED.

- [ ] Step 3: Implement — append to `src/modules/members/domain/value-objects/member-number.ts`:

```ts
/**
 * Parse a free-text search query into a member-number integer, or `null` if it
 * is not a usable member-number query. Accepts the formatted form
 * (`SCCM-0042`), a zero-padded bare number (`0042`), or a bare number (`42`)
 * — all → `42`. Returns `null` for empty / whitespace-only / prefix-only
 * (`SCCM-`) / non-positive (`0`, `-1`, `0000`) / non-numeric (`NOT-A-NUMBER`,
 * `x`) input.
 *
 * Pure Application/Domain helper (no SQL, no route coupling). The directory
 * search route calls this; a non-null result drives an `eq(members.memberNumber)`
 * index hit, a null result falls through to the company/contact ILIKE branch.
 *
 * The digit segment is taken AFTER an optional trailing `PREFIX-`; leading
 * zeros are stripped by `Number()`. We intentionally do NOT brand the result
 * as `MemberNumber` — the parsed value is an untrusted search term, not a
 * constructed identity; callers compare it against the indexed column as a
 * plain integer.
 */
export function parseMemberNumberQuery(q: string): number | null {
  const trimmed = q.trim();
  if (trimmed.length === 0) return null;

  // Strip an optional leading `PREFIX-` (e.g. `SCCM-0042` → `0042`).
  // The remainder must be all digits — this rejects `SCCM-` (empty digits)
  // and `NOT-A-NUMBER` (non-digit remainder) alike.
  const digits = trimmed.replace(/^[A-Za-z][A-Za-z0-9]{0,7}-/, '');
  if (!/^\d+$/.test(digits)) return null;

  const n = Number(digits);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/domain/member-number.test.ts`. Expected: all 3 `describe` blocks green (26 total: 7 + 6 + 13). 100% line + branch on `member-number.ts`. GREEN.

- [ ] Step 5: Commit — explicit files only:
```
git add src/modules/members/domain/value-objects/member-number.ts tests/unit/members/domain/member-number.test.ts
git commit -m "feat(members): add parseMemberNumberQuery search parser"
```

---

### Task DOM-4: Add `readonly memberNumber: MemberNumber` to the `Member` aggregate (immutable — excluded from `MemberPatch`); re-export from barrel

**Files:**
- Modify: `src/modules/members/domain/member.ts` — add the import (after line 19) + the field in the `Member` type (`src/modules/members/domain/member.ts:140-164`, insert after `memberId` at line 142)
- Modify: `src/modules/members/index.ts` — re-export the VO (after the `tax-id` export block, around line 89)
- Modify: `tests/unit/members/domain/member-state.test.ts` — add `memberNumber` to the `fixture()` builder (`tests/unit/members/domain/member-state.test.ts:32-57`) so the now-fuller `Member` type still constructs
- Test: `tests/unit/members/domain/member-number.test.ts` (append an aggregate/immutability guard block)

- [ ] Step 1: Write the failing test — append a guard block to `tests/unit/members/domain/member-number.test.ts`. This asserts (a) the `Member` aggregate carries a `MemberNumber` and (b) `memberNumber` is NOT a key of `MemberPatch` (immutability is enforced by the `Pick` whitelist; a `@ts-expect-error` proves the negative at compile time, which `pnpm typecheck` gates):

```ts
import type { Member } from '@/modules/members/domain/member';
import type { MemberPatch } from '@/modules/members/application/ports/member-repo';

describe('Member aggregate — memberNumber field', () => {
  it('Member carries a branded memberNumber (compile-time + runtime read)', () => {
    const memberNumber = asMemberNumber(42);
    // Build only the discriminating + new field to assert the type shape;
    // a partial cast keeps this a Domain-only unit (no full fixture here).
    const partial = { memberNumber } satisfies Pick<Member, 'memberNumber'>;
    expect(partial.memberNumber).toBe(42);
  });

  it('memberNumber is immutable — not assignable via MemberPatch', () => {
    // @ts-expect-error memberNumber must NOT be a patchable field (immutable).
    const bad: MemberPatch = { memberNumber: asMemberNumber(7) };
    // Runtime no-op assertion keeps vitest happy; the real guard is the
    // @ts-expect-error above (verified by `pnpm typecheck`).
    expect(bad).toBeDefined();
  });
});
```

- [ ] Step 2: Run test, verify it fails — run BOTH the typecheck gate (the `@ts-expect-error`/`satisfies` are the real assertions) and vitest:
  - `pnpm typecheck` — Expected failure: `Property 'memberNumber' is missing in type ... but required in type 'Pick<Member, "memberNumber">'` (the `satisfies` line) AND `Unused '@ts-expect-error' directive` (because `memberNumber` is not yet a valid key, so the assignment is currently a different error / the directive may not fire as intended until the field exists). This is RED until DOM-4 Step 3 adds the field.
  - `pnpm vitest run tests/unit/members/domain/member-number.test.ts` — Expected failure: import resolution / type errors surfaced by the transform. RED.

- [ ] Step 3: Implement — three edits.

  1. `src/modules/members/domain/member.ts` — add the VO import after line 19 (the `./value-objects/tax-id` import):
```ts
import type { MemberNumber } from './value-objects/member-number';
```
  Then add the field to the `Member` type immediately after `memberId` (currently line 142):
```ts
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly memberNumber: MemberNumber;
  readonly companyName: string;
```

  2. `src/modules/members/index.ts` — re-export the VO from the public barrel, after the `tax-id` export block (after line 89):
```ts
export {
  asMemberNumber,
  formatMemberNumber,
  parseMemberNumberQuery,
  InvalidMemberNumberError,
  type MemberNumber,
} from './domain/value-objects/member-number';
```

  3. `tests/unit/members/domain/member-state.test.ts` — add `memberNumber` to the `fixture()` defaults so the fuller `Member` type still constructs. Add the VO to the existing import from `@/modules/members/domain/member` is NOT possible (the VO lives in its own file), so add a dedicated import at the top, then add the field in the builder body (after the `memberId: 'm' as ...` line, currently line 33):
```ts
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';
```
  and inside the returned object literal:
```ts
    tenantId: 't' as Member['tenantId'],
    memberId: 'm' as Member['memberId'],
    memberNumber: asMemberNumber(1),
    companyName: 'Co',
```

- [ ] Step 4: Run test, verify pass — run both gates:
  - `pnpm typecheck` — Expected: 0 errors (the `@ts-expect-error` now correctly fires on the rejected `MemberPatch` assignment, the `satisfies` resolves, and `member-state.test.ts` builds a complete `Member`).
  - `pnpm vitest run tests/unit/members/domain/member-number.test.ts tests/unit/members/domain/member-state.test.ts` — Expected: both suites green (member-number now 28 tests; member-state unchanged count, still passing). GREEN.

- [ ] Step 5: Commit — explicit files only:
```
git add src/modules/members/domain/member.ts src/modules/members/index.ts tests/unit/members/domain/member-number.test.ts tests/unit/members/domain/member-state.test.ts
git commit -m "feat(members): add readonly memberNumber to Member aggregate + barrel"
```

---

**DOM group handoff notes for downstream groups** (not tasks — wiring contracts):
- Barrel exports now available to other groups via `@/modules/members`: `asMemberNumber`, `formatMemberNumber`, `parseMemberNumberQuery`, `InvalidMemberNumberError`, `type MemberNumber`, and `Member.memberNumber`.
- `MemberPatch` (`src/modules/members/application/ports/member-repo.ts:111`) is a `Partial<Pick<Member, …>>` whitelist — `memberNumber` is excluded by omission (no code change needed there); DOM-4 adds the `@ts-expect-error` guard test that fails if anyone adds it to the `Pick`.
- Adding `readonly memberNumber` to `Member` will break any OTHER full-`Member` literal under typecheck (e.g. integration fixtures, `rowToMember` in `drizzle-member-repo.ts:56`, serializers). Those are owned by the INFRA / APP / serializer groups — DOM only fixes `member-state.test.ts` (the one Domain-layer fixture). Expect the cross-tree `pnpm typecheck` to stay RED until those groups land their `memberNumber` reads; that is by design (the type forces every read path to be wired — design §5 "Read path" note).

---

## Group ALLOC — MemberNumberAllocatorPort + MemberSettingsReaderPort + Drizzle impls

**Cross-group dependency (read before starting):** This group consumes the `MemberNumber` brand + `asMemberNumber` from `src/modules/members/domain/value-objects/member-number.ts` (Domain group's deliverable) and the two new tables (`tenant_member_sequences`, `tenant_member_settings`) created by migration `0209_member_number_schema.sql` (Migration group's deliverable). **Tasks ALLOC-1..ALLOC-4 require migration 0209 applied to live Neon and `asMemberNumber` exported.** If those are not yet landed when you start, apply 0209 first (`pnpm drizzle-kit migrate`) and stub-import `asMemberNumber` — do NOT redefine the brand here (single-source-of-truth, Principle X). All paths below are grounded in the real files read this session.

**Canon names this group OWNS (use verbatim, no synonyms):**
- `MemberNumberAllocatorPort.allocate(tx, tenantId: TenantId): Promise<MemberNumber>`
- `MemberSettingsReaderPort.getPrefix(tx, tenantId: TenantId): Promise<string>` (default `'M'`)
- `drizzleMemberNumberAllocator: MemberNumberAllocatorPort`
- `drizzleMemberSettingsRepo: MemberSettingsReaderPort`

**Grounded facts:** `TenantTx` + `runInTenant` are exported from `@/lib/db` (db.ts:109, :239). `TenantId` is a branded string (`= TenantSlug`) exported from the members barrel `@/modules/members` (member.ts:37, re-exported index.ts:31). Lock-key convention: F4 uses legacy 32-bit `hashtext()`; CANON for members uses 64-bit `hashtextextended('members:'||$tenantId, 0)`. The F4 allocator does `SELECT … FOR UPDATE` then a separate `UPDATE`; CANON says **`UPDATE … RETURNING` only** (advisory lock already serialises) — do **not** copy F4 verbatim. Integration tests use `createTwoTestTenants` / `createTestTenant` from `tests/integration/helpers/test-tenant` + `asTenantContext` from `@/modules/tenants`, mirroring `seq-number-atomicity.test.ts`.

---

### Task ALLOC-1: Define `MemberNumberAllocatorPort` (Application port)

**Files:**
- Create: `src/modules/members/application/ports/member-number-allocator-port.ts`
- Test: `tests/unit/members/member-number-allocator-port.test.ts`

- [ ] Step 1: Write the failing test — a type-shape + structural conformance test (a port is an interface, so the test pins the contract via a typed conforming stub that must compile + satisfy the canon signature).

```ts
// tests/unit/members/member-number-allocator-port.test.ts
import { describe, it, expect } from 'vitest';
import type { TenantTx } from '@/lib/db';
import type { MemberNumberAllocatorPort } from '@/modules/members/application/ports/member-number-allocator-port';
import { asTenantId } from '@/modules/members';
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';

describe('MemberNumberAllocatorPort contract', () => {
  it('a conforming stub allocates a branded MemberNumber for a tenant', async () => {
    // The stub is the conformance proof: if the port signature drifts
    // (e.g. drops `tx`, returns `number`, takes raw string), this fails
    // to type-check and the suite goes red.
    const stub: MemberNumberAllocatorPort = {
      allocate: async (_tx, tenantId) => {
        expect(typeof tenantId).toBe('string'); // TenantId is a branded string
        return asMemberNumber(42);
      },
    };

    const fakeTx = {} as TenantTx;
    const n = await stub.allocate(fakeTx, asTenantId('alpha'));
    expect(n).toBe(42);
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/member-number-allocator-port.test.ts`. Expected failure: `Cannot find module '@/modules/members/application/ports/member-number-allocator-port'` (the port file does not exist yet).

- [ ] Step 3: Implement — create the port. Mirror the doc-comment style of `sequence-allocator-port.ts` but with the CANON signature (`tx` typed `TenantTx`, `tenantId: TenantId`, returns `MemberNumber`).

```ts
// src/modules/members/application/ports/member-number-allocator-port.ts
/**
 * Application port — per-tenant human-readable member-number allocator
 * (055-member-number, §5).
 *
 * Protocol (design §5): advisory xact lock on `members:{tenantId}` +
 * `INSERT … ON CONFLICT DO NOTHING` seed + `UPDATE … RETURNING` of the
 * incremented counter. The advisory lock alone serialises every writer,
 * so — unlike the F4 sequence allocator — there is NO `SELECT … FOR
 * UPDATE`. Implementation: `infrastructure/repos/drizzle-member-number-allocator.ts`.
 *
 * MUST be called as the FIRST statement inside the `createMember`
 * `runInTenant(tenant, async (tx) => …)` lambda, before
 * `createWithPrimaryContactInTx`. Running outside that tx uses a
 * pool-fresh connection without `SET LOCAL app.current_tenant` and
 * silently bypasses RLS (F7.1a US2 incident class — CLAUDE.md § Gotchas).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantId } from '../../domain/member';
import type { MemberNumber } from '../../domain/value-objects/member-number';

export interface MemberNumberAllocatorPort {
  /**
   * Allocate the next member number for `tenantId` INSIDE the caller's
   * tenant-scoped transaction. Seeds the per-tenant counter row on first
   * use. Returns the freshly allocated (post-increment) value as a
   * branded `MemberNumber`. Gaps are acceptable (a `createMember`
   * rollback unwinds the member row but leaves the counter incremented).
   */
  allocate(tx: TenantTx, tenantId: TenantId): Promise<MemberNumber>;
}
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/member-number-allocator-port.test.ts`. Expected: 1 passed.

- [ ] Step 5: Commit
```
git add src/modules/members/application/ports/member-number-allocator-port.ts tests/unit/members/member-number-allocator-port.test.ts
git commit -m "feat(members): add MemberNumberAllocatorPort application port"
```

---

### Task ALLOC-2: Define `MemberSettingsReaderPort` (Application port)

**Files:**
- Create: `src/modules/members/application/ports/member-settings-port.ts`
- Test: `tests/unit/members/member-settings-port.test.ts`

- [ ] Step 1: Write the failing test.

```ts
// tests/unit/members/member-settings-port.test.ts
import { describe, it, expect } from 'vitest';
import type { TenantTx } from '@/lib/db';
import type { MemberSettingsReaderPort } from '@/modules/members/application/ports/member-settings-port';
import { asTenantId } from '@/modules/members';

describe('MemberSettingsReaderPort contract', () => {
  it('a conforming stub returns the per-tenant prefix string', async () => {
    const stub: MemberSettingsReaderPort = {
      getPrefix: async (_tx, tenantId) => {
        expect(typeof tenantId).toBe('string');
        return 'SCCM';
      },
    };

    const fakeTx = {} as TenantTx;
    const prefix = await stub.getPrefix(fakeTx, asTenantId('alpha'));
    expect(prefix).toBe('SCCM');
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/member-settings-port.test.ts`. Expected failure: `Cannot find module '@/modules/members/application/ports/member-settings-port'`.

- [ ] Step 3: Implement.

```ts
// src/modules/members/application/ports/member-settings-port.ts
/**
 * Application port — per-tenant member-number SETTINGS reader
 * (055-member-number, §4.3).
 *
 * Read-only in MVP: the prefix is seed-only + immutable after the first
 * member (design §2) — there is NO update method by design (the guard is
 * the absence of an UPDATE use-case, not a DB check). The reader runs at
 * DISPLAY time, never at allocation time, so it touches ONLY
 * `tenant_member_settings` and never the sequence table — keeping the
 * lock graph acyclic (design §5 lock-order discipline).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantId } from '../../domain/member';

export interface MemberSettingsReaderPort {
  /**
   * Read the per-tenant member-number prefix (e.g. `'SCCM'`). Returns the
   * column DEFAULT `'M'` when no `tenant_member_settings` row exists for
   * the tenant — so a tenant provisioned before the settings seed still
   * renders a valid formatted number.
   */
  getPrefix(tx: TenantTx, tenantId: TenantId): Promise<string>;
}
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/member-settings-port.test.ts`. Expected: 1 passed.

- [ ] Step 5: Commit
```
git add src/modules/members/application/ports/member-settings-port.ts tests/unit/members/member-settings-port.test.ts
git commit -m "feat(members): add MemberSettingsReaderPort application port"
```

---

### Task ALLOC-3: Implement `drizzleMemberNumberAllocator` + concurrency integration test (live Neon)

**Prereq:** migration `0209_member_number_schema.sql` applied (`pnpm drizzle-kit migrate`) and `asMemberNumber` exported from `domain/value-objects/member-number.ts`. Confirm before writing the test or it fails on a missing table, not on missing impl.

**Files:**
- Create: `src/modules/members/infrastructure/repos/drizzle-member-number-allocator.ts` (new `repos/` dir under members infra — no prior file there; mirrors invoicing's `infrastructure/repos/` layout)
- Test: `tests/integration/members/member-number-allocator-atomicity.test.ts` (mirrors `tests/integration/invoicing/seq-number-atomicity.test.ts` scenarios (d) + (f) + (h))

- [ ] Step 1: Write the failing test — live-Neon concurrency + bootstrap-seed. Mirrors `seq-number-atomicity.test.ts`: `createTestTenant`, `asTenantContext`, `runInTenant`, `Promise.all` fan-out, raw `db.select()` to assert seeded counter state.

```ts
// tests/integration/members/member-number-allocator-atomicity.test.ts
/**
 * 055-member-number — member-number allocator atomicity (live Neon).
 *
 * Mirrors tests/integration/invoicing/seq-number-atomicity.test.ts
 * (advisory-lock serialisation). The member counter is a single
 * per-tenant stream (no document_type / fiscal_year sub-dimensions),
 * lifetime, never resets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';
import { tenantMemberSequences } from '@/modules/members/infrastructure/db/schema-member-number';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('member-number allocator atomicity (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('first allocate seeds the counter row and returns 1', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    const n = await runInTenant(ctx, (tx) =>
      drizzleMemberNumberAllocator.allocate(tx, asTenantId(tenant.ctx.slug)),
    );
    expect(n).toBe(1);

    const rows = await db
      .select()
      .from(tenantMemberSequences)
      .where(eq(tenantMemberSequences.tenantId, tenant.ctx.slug));
    expect(rows).toHaveLength(1);
    // last_number stores the LAST-issued value → equals what we returned.
    expect(rows[0]!.lastNumber).toBe(1);
  }, 30_000);

  it('sequential allocations produce consecutive numbers with no gaps', async () => {
    // Fresh tenant so the stream starts at 1 independent of the test above.
    const fresh = await createTestTenant('test-swecham');
    try {
      const ctx = asTenantContext(fresh.ctx.slug);
      const seqs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const s = await runInTenant(ctx, (tx) =>
          drizzleMemberNumberAllocator.allocate(tx, asTenantId(fresh.ctx.slug)),
        );
        seqs.push(s);
      }
      expect(seqs).toEqual([1, 2, 3]);
    } finally {
      await fresh.cleanup().catch(() => {});
    }
  }, 60_000);

  it('two concurrent allocations under one tenant yield distinct consecutive numbers (no duplicate)', async () => {
    const fresh = await createTestTenant('test-swecham');
    try {
      const ctx = asTenantContext(fresh.ctx.slug);
      const allocations = await Promise.all(
        Array.from({ length: 2 }, () =>
          runInTenant(ctx, (tx) =>
            drizzleMemberNumberAllocator.allocate(tx, asTenantId(fresh.ctx.slug)),
          ),
        ),
      );
      const sorted = [...allocations].sort((a, b) => a - b);
      expect(sorted).toEqual([1, 2]); // consecutive, no gap
      expect(new Set(allocations).size).toBe(2); // distinct, no duplicate
    } finally {
      await fresh.cleanup().catch(() => {});
    }
  }, 60_000);

  it('10 concurrent allocations produce contiguous 1..10 with no duplicates', async () => {
    const fresh = await createTestTenant('test-swecham');
    try {
      const ctx = asTenantContext(fresh.ctx.slug);
      const allocations = await Promise.all(
        Array.from({ length: 10 }, () =>
          runInTenant(ctx, (tx) =>
            drizzleMemberNumberAllocator.allocate(tx, asTenantId(fresh.ctx.slug)),
          ),
        ),
      );
      const sorted = [...allocations].sort((a, b) => a - b);
      expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(new Set(allocations).size).toBe(10);
    } finally {
      await fresh.cleanup().catch(() => {});
    }
  }, 60_000);
});
```

> Note on `schema-member-number.ts`: the Drizzle table objects (`tenantMemberSequences`, `tenantMemberSettings`) are owned by the Migration/Schema group. If that file isn't landed yet, create the minimal `tenantMemberSequences` `pgTable` definition (`tenant_id` text PK, `last_number` integer, `updated_at` timestamptz) in this task's Step-3 block so the test compiles; reconcile to the canonical schema file when the Migration group lands it (do not duplicate-define — import once it exists).

- [ ] Step 2: Run test, verify it fails — `pnpm test:integration tests/integration/members/member-number-allocator-atomicity.test.ts`. Expected failure: `Cannot find module '@/modules/members/infrastructure/repos/drizzle-member-number-allocator'` (the allocator impl does not exist yet).

- [ ] Step 3: Implement — the advisory-lock protocol from CANON. 64-bit `hashtextextended('members:'||$tenantId, 0)`; `INSERT … ON CONFLICT DO NOTHING` seed; **`UPDATE … RETURNING last_number` only** (no `SELECT FOR UPDATE`); return `asMemberNumber(last_number)`. Include the same dev/`DEBUG_RLS_STATE` tenant-context assertion the F4 allocator carries (postgres-sequence-allocator.ts:57-68) — belt-and-suspenders against a bare-`db` caller.

```ts
// src/modules/members/infrastructure/repos/drizzle-member-number-allocator.ts
/**
 * 055-member-number — Postgres member-number allocator.
 *
 * Protocol (design §5):
 *   1. pg_advisory_xact_lock(hashtextextended('members:'||$tenantId, 0))
 *        — 64-bit (F5–F9 convention). `members:` is disjoint from
 *          `invoicing:` / `payments:` / `broadcasts:` so no cross-stream
 *          contention.
 *   2. INSERT … ON CONFLICT DO NOTHING — seed the counter on first use.
 *   3. UPDATE … SET last_number = last_number + 1 … RETURNING last_number.
 *        The advisory lock already serialises every writer, so — unlike
 *        the F4 sequence allocator — there is NO `SELECT … FOR UPDATE`.
 *        DO NOT copy the F4 allocator verbatim.
 *
 * Lock-order discipline: this allocator touches ONLY
 * `tenant_member_sequences` — never `tenant_member_settings` (the prefix
 * is read at display time, not allocation time). Single-table lock graph
 * is trivially acyclic (mirrors the F4 allocator's lock-order rule).
 *
 * MUST run inside the caller's `runInTenant(tenant, tx)` scope — see the
 * port doc-comment. The dev-mode assertion below hard-fails if handed a
 * non-tenant-scoped tx.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { MemberNumberAllocatorPort } from '../../application/ports/member-number-allocator-port';
import type { TenantId } from '../../domain/member';
import {
  asMemberNumber,
  type MemberNumber,
} from '../../domain/value-objects/member-number';

export const drizzleMemberNumberAllocator: MemberNumberAllocatorPort = {
  async allocate(tx: TenantTx, tenantId: TenantId): Promise<MemberNumber> {
    // Belt-and-suspenders tenant-context assertion (mirrors
    // postgres-sequence-allocator.ts:57-68). A caller that accidentally
    // hands a bare `db` would advisory-lock fine but bypass RLS. Hard-fail
    // in dev/test; skip the round-trip in prod unless DEBUG_RLS_STATE=true.
    if (
      process.env.NODE_ENV !== 'production' ||
      process.env.DEBUG_RLS_STATE === 'true'
    ) {
      const ctxRows = (await tx.execute(
        sql`SELECT current_setting('app.current_tenant', TRUE) AS ctx`,
      )) as unknown as Array<{ ctx: string | null }>;
      const ctx = ctxRows[0]?.ctx ?? null;
      if (ctx !== tenantId) {
        throw new Error(
          `drizzleMemberNumberAllocator: tenant-context mismatch — expected=${tenantId}, got=${ctx}. ` +
            'Caller must run inside runInTenant(ctx, …).',
        );
      }
    }

    const lockKey = `members:${tenantId}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );

    await tx.execute(sql`
      INSERT INTO tenant_member_sequences (tenant_id, last_number)
      VALUES (${tenantId}, 0)
      ON CONFLICT (tenant_id) DO NOTHING
    `);

    const rows = (await tx.execute(sql`
      UPDATE tenant_member_sequences
         SET last_number = last_number + 1,
             updated_at  = now()
       WHERE tenant_id = ${tenantId}
       RETURNING last_number
    `)) as unknown as Array<{ last_number: number }>;

    const allocated = rows[0]?.last_number;
    if (allocated === undefined) {
      throw new Error(
        `drizzleMemberNumberAllocator: missing row after seed+update — members:${tenantId}`,
      );
    }
    return asMemberNumber(allocated);
  },
};
```

- [ ] Step 4: Run test, verify pass — `pnpm test:integration tests/integration/members/member-number-allocator-atomicity.test.ts`. Expected: 4 passed (seed→1, sequential 1/2/3, 2 concurrent distinct-consecutive, 10 concurrent contiguous 1..10).

- [ ] Step 5: Commit
```
git add src/modules/members/infrastructure/repos/drizzle-member-number-allocator.ts tests/integration/members/member-number-allocator-atomicity.test.ts
git commit -m "feat(members): drizzle member-number allocator with advisory-lock protocol"
```

---

### Task ALLOC-4: Implement `drizzleMemberSettingsRepo.getPrefix` + integration test (live Neon)

**Prereq:** migration `0209` applied (creates `tenant_member_settings` with `member_number_prefix text NOT NULL DEFAULT 'M'`).

**Files:**
- Create: `src/modules/members/infrastructure/repos/drizzle-member-settings-repo.ts`
- Test: `tests/integration/members/member-settings-prefix.test.ts`

- [ ] Step 1: Write the failing test — read returns the seeded prefix for a seeded tenant, and the default `'M'` for a tenant with no settings row.

```ts
// tests/integration/members/member-settings-prefix.test.ts
/**
 * 055-member-number — member-settings prefix reader (live Neon).
 *
 * getPrefix returns the seeded per-tenant prefix, or the column DEFAULT
 * 'M' when no tenant_member_settings row exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { drizzleMemberSettingsRepo } from '@/modules/members/infrastructure/repos/drizzle-member-settings-repo';
import { tenantMemberSettings } from '@/modules/members/infrastructure/db/schema-member-number';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('member-settings prefix reader (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('returns the column default "M" when no settings row exists', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    const prefix = await runInTenant(ctx, (tx) =>
      drizzleMemberSettingsRepo.getPrefix(tx, asTenantId(tenant.ctx.slug)),
    );
    expect(prefix).toBe('M');
  }, 30_000);

  it('returns the seeded prefix when a settings row exists', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    await runInTenant(ctx, (tx) =>
      tx.insert(tenantMemberSettings).values({
        tenantId: tenant.ctx.slug,
        memberNumberPrefix: 'SCCM',
      }),
    );

    const prefix = await runInTenant(ctx, (tx) =>
      drizzleMemberSettingsRepo.getPrefix(tx, asTenantId(tenant.ctx.slug)),
    );
    expect(prefix).toBe('SCCM');
  }, 30_000);
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm test:integration tests/integration/members/member-settings-prefix.test.ts`. Expected failure: `Cannot find module '@/modules/members/infrastructure/repos/drizzle-member-settings-repo'`.

- [ ] Step 3: Implement — single tenant-scoped SELECT, returns `'M'` fallback when no row. Use raw `sql` (consistent with the allocator) so it does not depend on the Drizzle table object's column-name mapping being final.

```ts
// src/modules/members/infrastructure/repos/drizzle-member-settings-repo.ts
/**
 * 055-member-number — per-tenant member-number SETTINGS reader.
 *
 * Read-only (design §2: prefix is seed-only + immutable after first
 * member; no UPDATE method exists by design). Runs at display time —
 * touches ONLY `tenant_member_settings`, never the sequence table, so it
 * never participates in the allocation lock graph (lock-order discipline).
 *
 * Returns the column DEFAULT `'M'` when no row exists, so a tenant
 * provisioned before the settings seed still renders a valid number.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { MemberSettingsReaderPort } from '../../application/ports/member-settings-port';
import type { TenantId } from '../../domain/member';

export const drizzleMemberSettingsRepo: MemberSettingsReaderPort = {
  async getPrefix(tx: TenantTx, tenantId: TenantId): Promise<string> {
    const rows = (await tx.execute(sql`
      SELECT member_number_prefix
        FROM tenant_member_settings
       WHERE tenant_id = ${tenantId}
    `)) as unknown as Array<{ member_number_prefix: string }>;

    // No row → tenant provisioned before the settings seed. Fall back to
    // the column DEFAULT so display never breaks (design §4.3).
    return rows[0]?.member_number_prefix ?? 'M';
  },
};
```

- [ ] Step 4: Run test, verify pass — `pnpm test:integration tests/integration/members/member-settings-prefix.test.ts`. Expected: 2 passed (default `'M'`, seeded `'SCCM'`).

- [ ] Step 5: Commit
```
git add src/modules/members/infrastructure/repos/drizzle-member-settings-repo.ts tests/integration/members/member-settings-prefix.test.ts
git commit -m "feat(members): drizzle member-settings prefix reader with M default"
```

---

### Task ALLOC-5: Export both ports + both adapters from the members public barrel

**Files:**
- Modify: `src/modules/members/index.ts` (append to the existing export blocks; barrel is the ONLY cross-module surface — index.ts:6-14)
- Test: `tests/unit/members/barrel-member-number-allocator.test.ts`

- [ ] Step 1: Write the failing test — assert the barrel re-exports the two concrete adapters + the two port types (so the `createMember` wiring group + the route composition root can import them via `@/modules/members`, not deep paths blocked by `no-restricted-imports`).

```ts
// tests/unit/members/barrel-member-number-allocator.test.ts
import { describe, it, expect } from 'vitest';
import * as membersBarrel from '@/modules/members';

describe('members barrel — member-number allocator + settings exports', () => {
  it('re-exports the concrete allocator + settings adapters', () => {
    expect(typeof membersBarrel.drizzleMemberNumberAllocator.allocate).toBe(
      'function',
    );
    expect(typeof membersBarrel.drizzleMemberSettingsRepo.getPrefix).toBe(
      'function',
    );
  });

  it('type-exports the two port interfaces (compile-time contract)', () => {
    // Type-only conformance: these lines fail to compile if the barrel
    // drops the type re-exports.
    const _a: membersBarrel.MemberNumberAllocatorPort | null = null;
    const _s: membersBarrel.MemberSettingsReaderPort | null = null;
    expect(_a).toBeNull();
    expect(_s).toBeNull();
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/barrel-member-number-allocator.test.ts`. Expected failure: `membersBarrel.drizzleMemberNumberAllocator is undefined` + TS errors on the two port type references (not yet re-exported).

- [ ] Step 3: Implement — append a new section to the barrel, mirroring the existing `drizzleMemberRepo` re-export idiom (index.ts:419-422).

```ts
// --- 055-member-number — allocator + settings (ALLOC group) -----------------

export { drizzleMemberNumberAllocator } from './infrastructure/repos/drizzle-member-number-allocator';
export type { MemberNumberAllocatorPort } from './application/ports/member-number-allocator-port';

export { drizzleMemberSettingsRepo } from './infrastructure/repos/drizzle-member-settings-repo';
export type { MemberSettingsReaderPort } from './application/ports/member-settings-port';
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/barrel-member-number-allocator.test.ts` then `pnpm typecheck` (the FINAL gate per the typecheck-not-in-pre-push rule — barrel edits surface cross-module type drift only under tsc). Expected: 2 passed; typecheck clean.

- [ ] Step 5: Commit
```
git add src/modules/members/index.ts tests/unit/members/barrel-member-number-allocator.test.ts
git commit -m "feat(members): export member-number allocator + settings via public barrel"
```

---

**ALLOC group hand-off notes for downstream groups:**
- The `createMember`-wiring group calls `drizzleMemberNumberAllocator.allocate(tx, asTenantId(tenantId))` as the FIRST statement inside the existing `runInTenant(deps.tenant, tx)` lambda (design §5 step 4: thread the result into the `memberDraft` before `createWithPrimaryContactInTx`). It does NOT open its own tx.
- The display/PDF/search groups call `drizzleMemberSettingsRepo.getPrefix(tx, …)` + `formatMemberNumber(prefix, n)` (Domain group) — never inside the allocation tx (lock-order: settings is display-time only).
- Both adapters use raw `sql` template literals and assume migration `0209`'s table/column names (`tenant_member_sequences`, `tenant_member_settings.member_number_prefix`). If the Schema group's Drizzle table objects differ in JS field naming, the raw SQL is unaffected (it targets DB identifiers directly).

---

## Group CM — `createMember` wiring + `rowToMember` (TDD task plan)

**Prerequisites (produced by upstream groups — DO NOT author here; import only):**
- Domain VO `src/modules/members/domain/value-objects/member-number.ts` exporting `MemberNumber`, `asMemberNumber(n)` (Group: Domain).
- `Member` aggregate (`src/modules/members/domain/member.ts`) GAINS `readonly memberNumber: MemberNumber` (Group: Domain).
- Application port `src/modules/members/application/ports/member-number-allocator-port.ts` exporting `interface MemberNumberAllocatorPort { allocate(tx, tenantId: TenantId): Promise<MemberNumber> }` (Group: Allocator).
- Infrastructure allocator impl + `tenant_member_sequences` table + migration `0209` (Group: Allocator/Migration).
- `members.member_number` column added to `schema-members.ts` as nullable, then `.notNull()` post-backfill (Group: Migration/Schema). **My CM tasks add `memberNumber` to the `MemberRow` read + INSERT column list once that column exists.**
- `member_number_assigned` added to `F3AuditEventType` union + `auditEventTypeEnum` + migration `0210` + F3 count guard (Group: Audit-enum).

If a CM task runs before its prerequisite lands, the RED step fails on a missing import (expected) — proceed only once the prerequisite symbol resolves under `pnpm typecheck`.

---

### Task CM-1: Inject `MemberNumberAllocatorPort` into `CreateMemberDeps`

**Files:**
- Modify: `src/modules/members/application/use-cases/create-member.ts` (deps type ~line 117-127; add import near line 44)
- Modify: `src/modules/members/members-deps.ts` (wire the production singleton into `buildMembersDeps` ~line 126-148)
- Test: `tests/unit/members/application/create-member-number-wiring.test.ts` (NEW)

- [ ] **Step 1 — Write the failing test.** This locks in the deps shape only: a `CreateMemberDeps` value carrying a `memberNumberAllocator` port compiles and the use-case accepts it. (Behaviour assertions land in CM-2/CM-3.)

```ts
/**
 * CM-1 — createMember accepts a MemberNumberAllocatorPort in its deps bag.
 * Shape-only guard: the allocator is wired and the use-case still returns ok
 * on the happy path (allocate stubbed to a fixed MemberNumber).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { createMember } from '@/modules/members/application/use-cases/create-member';
import type { CreateMemberDeps } from '@/modules/members/application/use-cases/create-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';

const tenant = asTenantContext('test-tenant');

function makeBaseMember() {
  return {
    tenantId: tenant.slug as never,
    memberId: asMemberId('44444444-4444-4444-8444-444444444444'),
    memberNumber: asMemberNumber(7),
    companyName: 'New Co',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1' as never,
    planYear: 2026,
    registrationDate: new Date('2026-06-05'),
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    status: 'active' as const,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeBaseContact() {
  return {
    tenantId: tenant.slug as never,
    contactId: asContactId('55555555-5555-4555-8555-555555555555'),
    memberId: asMemberId('44444444-4444-4444-8444-444444444444'),
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@test.example' as never,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en' as const,
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeDeps(): CreateMemberDeps {
  return {
    tenant,
    memberRepo: {
      findSoftDuplicate: vi.fn().mockResolvedValue(ok(null)),
      createWithPrimaryContactInTx: vi
        .fn()
        .mockResolvedValue(
          ok({ member: makeBaseMember(), contact: makeBaseContact() }),
        ),
    } as unknown as CreateMemberDeps['memberRepo'],
    plans: {
      getPlan: vi.fn().mockResolvedValue(
        ok({
          tenantId: tenant.slug,
          planId: 'plan-1',
          planYear: 2026,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          minTurnoverThb: null,
          maxTurnoverThb: null,
          maxDurationYears: null,
          maxMemberAge: null,
          includesCorporatePlanId: null,
          isSoftDeleted: false,
          annualFeeMinorUnits: 1_000_000,
          isActive: true,
        }),
      ),
    } as unknown as CreateMemberDeps['plans'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as CreateMemberDeps['audit'],
    clock: { now: () => new Date('2026-06-05') },
    memberNumberAllocator: {
      allocate: vi.fn().mockResolvedValue(asMemberNumber(7)),
    },
    idFactory: {
      memberId: () => asMemberId('44444444-4444-4444-8444-444444444444'),
      contactId: () => asContactId('55555555-5555-4555-8555-555555555555'),
    },
  };
}

const input = {
  company_name: 'New Co',
  country: 'TH',
  plan_id: 'plan-1',
  plan_year: 2026,
  primary_contact: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@test.example',
    preferred_language: 'en' as const,
  },
};
const meta = { actorUserId: 'actor-uuid', requestId: 'req-cm1-001' };

describe('CM-1 — createMember accepts memberNumberAllocator dep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok with allocator wired', async () => {
    const deps = makeDeps();
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2 — Run, verify fail.**
  `pnpm vitest run tests/unit/members/application/create-member-number-wiring.test.ts`
  Expected: compile-time failure — `Object literal may only specify known properties, and 'memberNumberAllocator' does not exist in type 'CreateMemberDeps'` (the dep field is not yet on the type). (Also fails on `err` import being unused — drop it if lint complains; keep only if CM-2/CM-3 reuse this file.)

- [ ] **Step 3 — Implement.** Add the import + the deps field.

In `create-member.ts`, after the existing port imports (after line 44 `import type { PlanLookupPort } …`):
```ts
import type { MemberNumberAllocatorPort } from '../ports/member-number-allocator-port';
```
Extend `CreateMemberDeps` (insert the field after `clock: ClockPort;`, line 122):
```ts
export type CreateMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  plans: PlanLookupPort;
  audit: AuditPort;
  clock: ClockPort;
  /**
   * Allocates the next per-tenant human-readable member number INSIDE the
   * createMember runInTenant(tx) lambda (under the tenant RLS session).
   * Must run BEFORE createWithPrimaryContactInTx — the allocated integer is
   * threaded into the member INSERT in the SAME tx (gap-OK on rollback).
   */
  memberNumberAllocator: MemberNumberAllocatorPort;
  idFactory: {
    memberId(): MemberId;
    contactId(): ContactId;
  };
};
```
In `members-deps.ts`, add the import (after line 29 `import { drizzlePlanAdvisoryLockAdapter } …`):
```ts
import { drizzleMemberNumberAllocator } from './infrastructure/db/member-number-allocator';
import type { MemberNumberAllocatorPort } from './application/ports/member-number-allocator-port';
```
Add to `MembersDeps` (after `clock: ClockPort;`, line 92):
```ts
  memberNumberAllocator: MemberNumberAllocatorPort;
```
Add to the `buildMembersDeps` return object (after `clock: systemClock,`, line 146):
```ts
    memberNumberAllocator: drizzleMemberNumberAllocator,
```

- [ ] **Step 4 — Run, verify pass.**
  `pnpm vitest run tests/unit/members/application/create-member-number-wiring.test.ts`
  Expected: `1 passed`. Then `pnpm typecheck` — `members-deps.ts` resolves the allocator singleton (prerequisite from the Allocator group).

- [ ] **Step 5 — Commit.**
  `git add src/modules/members/application/use-cases/create-member.ts src/modules/members/members-deps.ts tests/unit/members/application/create-member-number-wiring.test.ts`
  `git commit -m "feat(members): inject MemberNumberAllocatorPort into createMember deps"`

---

### Task CM-2: Allocate FIRST in the `runInTenant(tx)` lambda, thread `memberNumber` into the INSERT

**Files:**
- Modify: `src/modules/members/application/use-cases/create-member.ts` (`memberDraft` type+assembly line 276-300; `runInTenant` lambda line 320-357)
- Test: `tests/unit/members/application/create-member-number-wiring.test.ts` (extend with an allocation-order + handoff `describe`)

- [ ] **Step 1 — Write the failing test.** Append to the CM-1 file. Asserts (a) `allocate(tx, tenantId)` is called, (b) it is called BEFORE `createWithPrimaryContactInTx`, (c) the draft passed to the repo carries the allocated `memberNumber`.

```ts
describe('CM-2 — allocate runs first and threads memberNumber into the INSERT', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls allocate before createWithPrimaryContactInTx and passes the number', async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    (deps.memberNumberAllocator.allocate as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => {
        calls.push('allocate');
        return asMemberNumber(7);
      });
    (deps.memberRepo.createWithPrimaryContactInTx as ReturnType<typeof vi.fn>)
      .mockImplementation(async (_tx: unknown, draft: { member: { memberNumber: unknown } }) => {
        calls.push('insert');
        // handoff: the draft INSERT carries the allocated number
        expect(draft.member.memberNumber).toBe(7);
        return ok({ member: makeBaseMember(), contact: makeBaseContact() });
      });

    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);
    // allocate is the FIRST statement inside the tx lambda
    expect(calls).toEqual(['allocate', 'insert']);
    // allocate received the tenant id (TenantContext.slug)
    expect(deps.memberNumberAllocator.allocate).toHaveBeenCalledWith(
      expect.anything(),
      tenant.slug,
    );
  });
});
```

- [ ] **Step 2 — Run, verify fail.**
  `pnpm vitest run tests/unit/members/application/create-member-number-wiring.test.ts`
  Expected: `CM-2` fails — `allocate` is never called (`calls` is `['insert']`), and `draft.member.memberNumber` is `undefined` (the draft type doesn't carry the field yet → also a `TS2353` once `memberNumber` is referenced).

- [ ] **Step 3 — Implement.** Widen the draft type to include `memberNumber` and allocate first inside the tx.

Change the `memberDraft` declaration (line 276) — the type already is `Omit<Member, 'createdAt' | 'updatedAt'>`, which now includes `memberNumber` (the Domain group added it to `Member`). So the assembly must set it. Allocate inside the lambda and assemble the draft there (the allocated number is only known inside the tx). Restructure: move the `memberDraft` assembly to AFTER `allocate`, inside the `runInTenant` lambda.

Replace lines 273-357 (`// 6. Assemble the draft and persist` through the `runInTenant` block) with:
```ts
  // 6. Assemble identity + persist. The member number is allocated INSIDE
  // the tenant tx (first statement) so the per-tenant counter bump and the
  // member INSERT commit/rollback atomically (gap-OK: a rolled-back create
  // leaves the counter incremented — numbers are never reused).
  const memberId = deps.idFactory.memberId();
  const contactId = deps.idFactory.contactId();
  const contactDraft: Omit<Contact, 'createdAt' | 'updatedAt' | 'memberId'> = {
    tenantId: deps.tenant.slug,
    contactId,
    firstName: data.primary_contact.first_name.trim(),
    lastName: data.primary_contact.last_name.trim(),
    email: email.value,
    phone,
    roleTitle: data.primary_contact.role_title ?? null,
    preferredLanguage: data.primary_contact.preferred_language,
    isPrimary: true,
    dateOfBirth: data.primary_contact.date_of_birth
      ? new Date(data.primary_contact.date_of_birth)
      : null,
    linkedUserId: null,
    inviteBouncedAt: null,
    removedAt: null,
  };

  // W1: throw-to-rollback — number allocation + state + 3 audit rows atomic.
  try {
    const created = await runInTenant(deps.tenant, async (tx) => {
      // FIRST statement: allocate under the tenant RLS session. Running this
      // outside the tx would use a pool-fresh connection without
      // SET LOCAL app.current_tenant → silent RLS bypass (F7.1a US2 class).
      const memberNumber = await deps.memberNumberAllocator.allocate(
        tx,
        deps.tenant.slug,
      );

      const memberDraft: Omit<Member, 'createdAt' | 'updatedAt'> = {
        tenantId: deps.tenant.slug,
        memberId,
        memberNumber,
        companyName: data.company_name.trim(),
        legalEntityType: data.legal_entity_type ?? null,
        country: country.value,
        taxId,
        website: data.website ?? null,
        description: data.description ?? null,
        foundedYear: data.founded_year ?? null,
        turnoverThb: data.turnover_thb ?? null,
        planId: plan.planId,
        planYear: data.plan_year,
        registrationDate: regDate,
        registrationFeePaid: false,
        lastActivityAt: null,
        notes: null,
        addressLine1: data.address_line1 ?? null,
        addressLine2: data.address_line2 ?? null,
        city: data.city ?? null,
        province: data.province ?? null,
        postalCode: data.postal_code ?? null,
        status: 'active',
        archivedAt: null,
      };

      const result = await deps.memberRepo.createWithPrimaryContactInTx(tx, {
        member: memberDraft,
        primaryContact: contactDraft,
      });
      if (!result.ok) throw new UseCaseAbort<RepoError>(result.error);

      const memberAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_created',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_created ${result.value.member.companyName}`,
        payload: {
          member_id: result.value.member.memberId,
          company_name: result.value.member.companyName,
          plan_id: result.value.member.planId,
          plan_year: result.value.member.planYear,
          primary_contact_id: result.value.contact.contactId,
        },
      });
      if (!memberAudit.ok) throw new UseCaseAbort<RepoError>(memberAudit.error);

      const contactAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'contact_created',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `contact_created for member ${result.value.member.memberId}`,
        payload: {
          member_id: result.value.member.memberId,
          contact_id: result.value.contact.contactId,
          is_primary: true,
        },
      });
      if (!contactAudit.ok) throw new UseCaseAbort<RepoError>(contactAudit.error);

      return result.value;
    });

    return ok({
      memberId: created.member.memberId,
      contactId: created.contact.contactId,
    });
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      if (re.code === 'repo.conflict')
        return err({ type: 'conflict', reason: re.reason });
      return err({ type: 'server_error', message: `create: ${re.code}` });
    }
    return err({ type: 'server_error', message: 'create: unexpected' });
  }
}
```
(The `member_number_assigned` audit emission is added in CM-3, so the draft handoff + ordering land first and keep this diff reviewable.)

- [ ] **Step 4 — Run, verify pass.**
  `pnpm vitest run tests/unit/members/application/create-member-number-wiring.test.ts`
  Expected: CM-1 + CM-2 green. Re-run the pre-existing W1 suite to confirm no regression from the lambda restructure:
  `pnpm vitest run tests/unit/members/application/w1-tx-rollback.test.ts` (note: this suite's `makeCreateMemberDeps` will need the `memberNumberAllocator` stub — see CM-4).

- [ ] **Step 5 — Commit.**
  `git add src/modules/members/application/use-cases/create-member.ts tests/unit/members/application/create-member-number-wiring.test.ts`
  `git commit -m "feat(members): allocate member number first in createMember tx, thread into INSERT"`

---

### Task CM-3: Emit `member_number_assigned` via the F3 audit port (`recordInTx`)

**Files:**
- Modify: `src/modules/members/application/use-cases/create-member.ts` (inside the `runInTenant` lambda, after the `member_created` audit)
- Test: `tests/unit/members/application/create-member-number-wiring.test.ts` (extend)

- [ ] **Step 1 — Write the failing test.** Append a `describe` asserting a `member_number_assigned` event is recorded with the allocated number in the payload, and that it lands inside the tx (alongside `member_created`/`contact_created`).

```ts
describe('CM-3 — createMember emits member_number_assigned audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records member_number_assigned with payload.member_number', async () => {
    const deps = makeDeps();
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);

    const recordInTx = deps.audit.recordInTx as ReturnType<typeof vi.fn>;
    const types = recordInTx.mock.calls.map((c) => c[2].type);
    expect(types).toContain('member_number_assigned');

    const assigned = recordInTx.mock.calls.find(
      (c) => c[2].type === 'member_number_assigned',
    );
    expect(assigned).toBeDefined();
    expect(assigned![2].payload).toMatchObject({
      member_id: '44444444-4444-4444-8444-444444444444',
      member_number: 7,
    });
  });

  it('aborts cleanly when member_number_assigned audit fails (returns err, no swallow)', async () => {
    const deps = makeDeps();
    const recordInTx = deps.audit.recordInTx as ReturnType<typeof vi.fn>;
    // member_created ok, contact_created ok, member_number_assigned fails.
    recordInTx
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });
});
```

- [ ] **Step 2 — Run, verify fail.**
  `pnpm vitest run tests/unit/members/application/create-member-number-wiring.test.ts`
  Expected: CM-3 fails — no `member_number_assigned` call exists; `types` lacks the value and the abort test still returns ok (only 2 audit calls happen). (Also a `TS` error on `type: 'member_number_assigned'` only if the Audit-enum group hasn't added it to `F3AuditEventType` yet — that union extension is the prerequisite.)

- [ ] **Step 3 — Implement.** Add the third `recordInTx` call inside the lambda, immediately after the `member_created` audit and before `contact_created` (so the number-assignment audit is adjacent to member creation in the timeline). Uses `member_id` (snake_case — required by the `last_activity_at` trigger, see `schema-members.ts:76`) and `member_number`.

Insert after the `if (!memberAudit.ok) throw …` line (the `member_created` guard), before the `const contactAudit = …` block:
```ts
      const numberAudit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_number_assigned',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `member_number_assigned ${memberNumber}`,
        payload: {
          member_id: result.value.member.memberId,
          member_number: memberNumber,
        },
      });
      if (!numberAudit.ok) throw new UseCaseAbort<RepoError>(numberAudit.error);
```

- [ ] **Step 4 — Run, verify pass.**
  `pnpm vitest run tests/unit/members/application/create-member-number-wiring.test.ts`
  Expected: all CM-1/2/3 describes green. `pnpm typecheck` confirms `member_number_assigned` is a valid `F3AuditEventType` (prerequisite).

- [ ] **Step 5 — Commit.**
  `git add src/modules/members/application/use-cases/create-member.ts tests/unit/members/application/create-member-number-wiring.test.ts`
  `git commit -m "feat(members): emit member_number_assigned audit on createMember"`

---

### Task CM-4: Patch the pre-existing W1 createMember mock to satisfy the new dep

**Files:**
- Modify: `tests/unit/members/application/w1-tx-rollback.test.ts` (`makeCreateMemberDeps` ~line 478-527; `makeBaseMember` ~line 319-342)

- [ ] **Step 1 — Write the failing test.** No new test — the RED is the existing W1 suite failing to compile because `makeCreateMemberDeps` returns a `CreateMemberDeps` missing `memberNumberAllocator`, and `makeBaseMember()` lacks `memberNumber`. Confirm the break:
  `pnpm vitest run tests/unit/members/application/w1-tx-rollback.test.ts`
  Expected: `TS2741: Property 'memberNumberAllocator' is missing in type … but required in type 'CreateMemberDeps'` and `Property 'memberNumber' is missing` on the createMember `fakeCreated.member`.

- [ ] **Step 2 — (same as Step 1)** — this task IS the fix for a RED introduced by CM-1/CM-2. The command above is the failing run.

- [ ] **Step 3 — Implement.** Add the allocator stub to `makeCreateMemberDeps` and `memberNumber` to `makeBaseMember`.

Add the import (near the existing `asMemberId`/`asContactId` imports at the top of the file, ~line 49):
```ts
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';
```
In `makeBaseMember()` (line 319), add after `memberId,`:
```ts
    memberNumber: asMemberNumber(1),
```
In `makeCreateMemberDeps` (line 481), add the dep after the `audit: { … }` block and before `clock:` (line 521):
```ts
    memberNumberAllocator: {
      allocate: vi.fn().mockResolvedValue(asMemberNumber(1)),
    },
```
The W1 "second audit fails" test (`auditResults: [ok, err]`) now exercises THREE audits (`member_created`, `member_number_assigned`, `contact_created`). It asserts `toHaveBeenCalledTimes(2)`. After CM-3 the order is `member_created` → `member_number_assigned` → `contact_created`, so the existing two-element `auditResults` array no longer maps to "contact_created fails". Update that test's expectation to the new sequence: make the SECOND audit (`member_number_assigned`) the failing one and assert `toHaveBeenCalledTimes(2)` (member_created ok, number fails, contact never runs):
```ts
  it('returns err when an audit event fails after the member insert succeeds', async () => {
    const fakeCreated = {
      member: makeBaseMember(),
      contact: makeBaseContact(),
    };
    const deps = makeCreateMemberDeps({
      createResult: ok(fakeCreated),
      auditResults: [
        ok(undefined), // member_created ok
        err({ code: 'repo.unexpected' as const }), // member_number_assigned fail
      ],
    });
    const result = await createMember(createMemberInput, createMemberMeta, deps);
    expect(result.ok).toBe(false);
    // member_created ok, member_number_assigned throws → contact_created never runs.
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 4 — Run, verify pass.**
  `pnpm vitest run tests/unit/members/application/w1-tx-rollback.test.ts`
  Expected: all W1 describes green (createMember + contact-crud + invite-colleague + self-update). `pnpm typecheck` clean.

- [ ] **Step 5 — Commit.**
  `git add tests/unit/members/application/w1-tx-rollback.test.ts`
  `git commit -m "test(members): update W1 createMember mock for memberNumberAllocator dep"`

---

### Task CM-5: `rowToMember` reads `row.memberNumber` via `asMemberNumber`; add `member_number` to `MemberRow` + INSERT column list

**Files:**
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` (`rowToMember` line 56-84; `createWithPrimaryContactInTx` INSERT `.values({…})` line 379-404; import block line 42-52)
- Modify: `src/modules/members/infrastructure/db/schema-members.ts` (add `memberNumber` column — **nullable** per design §6, since `.notNull()` is set only post-backfill by the Migration group)
- Test: `tests/integration/members/member-number-create.test.ts` (NEW — live Neon)

> Schema note: the `memberNumber` Drizzle column declaration in `schema-members.ts` may already be added by the Migration group. If `MemberRow['memberNumber']` already resolves under typecheck, skip the schema edit in Step 3 and only touch the repo. The integer column is `integer('member_number')` — keep it nullable in Drizzle until the backfill migration lands `SET NOT NULL` (design §6: declaring `.notNull()` before backfill makes `drizzle-kit generate` emit `ADD COLUMN NOT NULL` without a default → fails on the live non-empty table).

- [ ] **Step 1 — Write the failing test.** Live-Neon integration: `createMember` persists `member_number`, and a second create increments it; the persisted integer equals the row read back. (This is the design §11 "createMember persists member_number equal to the next sequence value" case.) Mirror `tests/integration/members/create-member.test.ts` fixture setup (tenant + invoice settings + plan seeded in `beforeAll`).

```ts
/**
 * CM-5 — Integration: createMember persists members.member_number from the
 * per-tenant allocator, and consecutive creates increment by 1. Live Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

function goodInput(planId: string) {
  return {
    company_name: `Numbered Co ${randomUUID().slice(0, 8)}`,
    country: 'TH',
    plan_id: planId,
    plan_year: 2026,
    primary_contact: {
      first_name: 'Anna',
      last_name: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      preferred_language: 'en' as const,
    },
  };
}

describe('CM-5 — createMember persists member_number (integration)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-premium';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Test Premium' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('persists a positive member_number and increments on the next create', async () => {
    const deps = buildMembersDeps(tenant.ctx);

    const first = await createMember(
      goodInput(planId),
      { actorUserId: user.userId, requestId: `rq-${randomUUID().slice(0, 8)}` },
      deps,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const firstRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, first.value.memberId)),
    );
    expect(firstRows).toHaveLength(1);
    const n1 = firstRows[0]!.memberNumber;
    expect(n1).not.toBeNull();
    expect(n1!).toBeGreaterThan(0);

    const second = await createMember(
      goodInput(planId),
      { actorUserId: user.userId, requestId: `rq-${randomUUID().slice(0, 8)}` },
      deps,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const secondRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, second.value.memberId)),
    );
    const n2 = secondRows[0]!.memberNumber;
    // Continuous per-tenant sequence: next allocation = previous + 1.
    expect(n2!).toBe(n1! + 1);
  });
});
```

- [ ] **Step 2 — Run, verify fail.**
  First apply the migration on live Neon (project gotcha — migration + integration before commit): `pnpm db:migrate` (or the repo's migrate command), then:
  `pnpm test:integration tests/integration/members/member-number-create.test.ts`
  Expected: fail — either `members.memberNumber` is not a column on the Drizzle select (TS error / `undefined`), or the persisted value is `null` because the INSERT never writes it. (Until CM-1/CM-2 are merged, `buildMembersDeps` also lacks the allocator → typecheck error.)

- [ ] **Step 3 — Implement.**

(a) In `schema-members.ts`, add the column in the `members` table body (after `memberId: uuid('member_id').notNull(),`, line 49) — **nullable** for now:
```ts
    // Human-readable per-tenant display id (design 2026-06-05). UUID stays the
    // PK; this is display-only. Declared NULLABLE here — the backfill migration
    // 0209 assigns 1..N then runs ALTER COLUMN … SET NOT NULL. Adding .notNull()
    // before backfill would make drizzle-kit emit ADD COLUMN NOT NULL with no
    // default → fails on the live non-empty members table.
    memberNumber: integer('member_number'),
```
(`integer` is already imported on line 22.)

(b) In `drizzle-member-repo.ts`, add `asMemberNumber` to the Domain imports (the `from '../../domain/member'` group, line 42-48, OR the value-objects group — import from the VO file):
```ts
import { asMemberNumber } from '../../domain/value-objects/member-number';
```
In `rowToMember` (line 56), add the field after `memberId:` (line 59):
```ts
    memberNumber: asMemberNumber(row.memberNumber!),
```
> `row.memberNumber` is typed `number | null` while the column is nullable; after the backfill `SET NOT NULL` every persisted row is non-null. The `!` asserts the invariant; `asMemberNumber` throws `InvalidMemberNumberError` on a `<= 0`/non-integer value, which is the loud backstop if a direct-INSERT bypass ever writes a bad value. (Do NOT silently coerce.)

(c) In `createWithPrimaryContactInTx`, add `memberNumber` to the member INSERT `.values({…})` (line 379, after `memberId: draft.member.memberId,`):
```ts
          memberNumber: draft.member.memberNumber,
```

- [ ] **Step 4 — Run, verify pass.**
  `pnpm test:integration tests/integration/members/member-number-create.test.ts`
  Expected: `2 passed` (or `1 passed` if you keep it a single `it`). Then the full create-member integration suite to confirm no regression: `pnpm test:integration tests/integration/members/create-member.test.ts`. Finally `pnpm typecheck`.

- [ ] **Step 5 — Commit.**
  `git add src/modules/members/infrastructure/db/drizzle-member-repo.ts src/modules/members/infrastructure/db/schema-members.ts tests/integration/members/member-number-create.test.ts`
  `git commit -m "feat(members): persist + read member_number in member repo"`

---

**CM section grounding notes (for reviewers):**
- `createWithPrimaryContactInTx` already returns the persisted `Member` via `rowToMember(result.memberRow)` (repo line 433), so once CM-5 lands, `result.value.member.memberNumber` is populated for the CM-3 audit payload without a re-read.
- The `memberDraft` type was `Omit<Member, 'createdAt' | 'updatedAt'>` (use-case line 276) — it automatically requires `memberNumber` once the Domain group adds it to `Member`, which is why CM-2 must assemble the draft inside the lambda (the number isn't known until `allocate` runs).
- Audit payloads use snake_case `member_id` deliberately: the `last_activity_at` denorm trigger (`schema-members.ts:76-79`) fires ONLY on `payload ? 'member_id'`. `member_number_assigned` carrying `member_id` keeps the member rising in the directory's last-activity sort.
- The CM unit tests mock `@/lib/db`'s `runInTenant` to invoke the lambda with `{}` as `tx` (mirrors `w1-tx-rollback.test.ts:37-41`); the allocator + repo are mocked so no live DB is needed for ordering/handoff/audit assertions. Only CM-5 hits live Neon.

---

## Implementation Plan — Group ADMIN: Admin list + detail + search + i18n

**Scope:** member-number display + sort + search on the admin directory, the admin detail formatted number + CopyButton, the directory serialiser mapping, the skeleton column-count bump + a guarding presentation test, and EN+TH+SV i18n. Consumes the CANON Domain symbols (`MemberNumber`, `formatMemberNumber`, `parseMemberNumberQuery`) and the `members.memberNumber` Drizzle column — both delivered by the Group ALLOC. Every task below assumes those exist; ADMIN-1 is the first task that *reads* `members.memberNumber`, so if FOUNDATION has not landed, ADMIN-1's test fails on a missing column (expected ordering — ADMIN depends on FOUNDATION).

Grounded line references (read 2026-06-05):
- `DirectoryOffsetFilter.sort` union — `src/modules/members/application/ports/member-repo.ts:57`
- `searchDirectoryWithCount` orderBy — `src/modules/members/infrastructure/db/drizzle-member-repo.ts:649-657`
- `directoryQFilter` — `drizzle-member-repo.ts:167-182`; `buildDirectoryConds` — `:137-164`
- `rowToMember` (single row→aggregate) — `drizzle-member-repo.ts:56-84`
- `serialiseDirectoryRow` — `src/app/api/members/_serialise.ts:64-86`; `serialiseMember` — `:11-38`
- `MembersTableRow` type + columns `useMemo` — `src/components/members/members-table.tsx:81-119`, `:577-825`
- Skeleton `cols`/`gridTemplate` — `src/components/members/members-table-skeleton.tsx:34-40`
- Admin detail `memberId` Field + CopyButton — `src/app/(staff)/admin/members/[memberId]/page.tsx:617-627`
- i18n `directory.columns` — `src/i18n/messages/en.json:885-896`; `directory.searchPlaceholder` — `:859`; `detail.fields` — `:973-979`; `detail.copy.copyMemberId` — referenced `page.tsx:624`

---

### Task ADMIN-1: Extend `DirectoryOffsetFilter.sort` union + add `memberNumber` orderBy branch

**Files:**
- Modify: `src/modules/members/application/ports/member-repo.ts` (`:57` — `sort?: 'engagement'`)
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` (`:649-657` orderBy block)
- Test: `tests/integration/members/member-number-directory-sort.test.ts` (new)

- [ ] Step 1: Write the failing test — REAL test code:

```ts
// tests/integration/members/member-number-directory-sort.test.ts
import { describe, expect, it } from 'vitest';
import { drizzleMemberRepo } from '@/modules/members';
import { createTwoTestTenants, seedMember } from '../../helpers/member-test-helpers';

describe('searchDirectoryWithCount — sort by memberNumber', () => {
  it('orders ascending by member_number with NULLS LAST', async () => {
    const { tenantA } = await createTwoTestTenants();
    // seedMember assigns sequential member numbers via the allocator (Group ALLOC).
    const m3 = await seedMember(tenantA, { companyName: 'Gamma Co' }); // number 3
    const m1 = await seedMember(tenantA, { companyName: 'Alpha Co' }); // number 1? no — allocation order
    const m2 = await seedMember(tenantA, { companyName: 'Beta Co' });

    const res = await drizzleMemberRepo.searchDirectoryWithCount(tenantA, {
      sort: 'memberNumber',
      order: 'asc',
      status: ['active', 'inactive'],
      limit: 50,
      offset: 0,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const numbers = res.value.items.map((r) => r.member.memberNumber);
    // strictly non-decreasing (ASC)
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]! >= numbers[i - 1]!).toBe(true);
    }
    // sanity: the three seeded members are present
    const ids = res.value.items.map((r) => r.member.memberId);
    expect(ids).toEqual(expect.arrayContaining([m1.memberId, m2.memberId, m3.memberId]));
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/integration/members/member-number-directory-sort.test.ts`. Expected failure: TypeScript rejects `sort: 'memberNumber'` (not assignable to `'engagement' | undefined`), or at runtime the orderBy falls through to the recency default so the ASC ordering assertion may pass spuriously — the **type error is the RED signal**. (If the helper `seedMember` is owned by Group ALLOC and absent, this fails on import — that is the expected cross-group ordering dependency.)

- [ ] Step 3: Implement.

In `member-repo.ts`, widen the union (`:57`), keeping the existing engagement doc-comment:
```ts
  /**
   * Sort column (FR-007a). `engagement` orders by the F8 risk score inverted
   * (engagement = 100 − risk): `desc` (default) = healthiest first; `asc` =
   * least-engaged first. Unscored members (null risk) always sort last.
   * `memberNumber` orders by the human-readable member number (ASC NULLS LAST;
   * `desc` reverses). Omitted → default recency order (`last_activity_at DESC`).
   */
  readonly sort?: 'engagement' | 'memberNumber';
```

In `drizzle-member-repo.ts`, extend the `orderBy` ternary (`:649-657`) into an explicit branch chain so the recency default stays last:
```ts
        const orderBy =
          filter.sort === 'engagement'
            ? [
                filter.order === 'asc'
                  ? sql`${members.riskScore} DESC NULLS LAST`
                  : sql`${members.riskScore} ASC NULLS LAST`,
                asc(members.memberId),
              ]
            : filter.sort === 'memberNumber'
              ? [
                  filter.order === 'desc'
                    ? sql`${members.memberNumber} DESC NULLS LAST`
                    : sql`${members.memberNumber} ASC NULLS LAST`,
                  asc(members.memberId),
                ]
              : [sql`${members.lastActivityAt} DESC NULLS LAST`, asc(members.memberId)];
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/integration/members/member-number-directory-sort.test.ts`. Expected: 1 passed. Then `pnpm typecheck` (final gate after the last edit per project rule).

- [ ] Step 5: Commit — `git add src/modules/members/application/ports/member-repo.ts src/modules/members/infrastructure/db/drizzle-member-repo.ts tests/integration/members/member-number-directory-sort.test.ts` then `git commit -m "feat(members): sort directory by member_number (ASC NULLS LAST)"`.

---

### Task ADMIN-2: Search-by-number — fold parsed number into `directoryQFilter`

**Files:**
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` (`directoryQFilter` `:167-182`; both call sites pass the parsed number — `searchDirectoryWithCount` `:633`, cursor `searchDirectory` `~:565` region)
- Test: `tests/integration/members/member-number-search.test.ts` (new)

Design note (grounded): `directoryQFilter(q)` returns ONE `or(...)` pushed as a single AND-conjunct in both callers. Adding the integer branch **inside** `directoryQFilter` keeps both callers byte-identical (no caller signature change). The parser is the CANON `parseMemberNumberQuery` (Domain pure fn) — imported here via the in-module relative path `../../domain/value-objects/member-number` (the repo is *inside* the module, so it does not go through the barrel).

- [ ] Step 1: Write the failing test — REAL test code:

```ts
// tests/integration/members/member-number-search.test.ts
import { describe, expect, it } from 'vitest';
import { drizzleMemberRepo } from '@/modules/members';
import { createTwoTestTenants, seedMember } from '../../helpers/member-test-helpers';

describe('searchDirectoryWithCount — search by member number', () => {
  it('matches a member by its formatted number, padded number, or bare integer', async () => {
    const { tenantA } = await createTwoTestTenants();
    const target = await seedMember(tenantA, { companyName: 'Zeta Holdings' });
    const n = target.memberNumber; // e.g. 1

    for (const q of [`SCCM-${String(n).padStart(4, '0')}`, String(n).padStart(4, '0'), String(n)]) {
      const res = await drizzleMemberRepo.searchDirectoryWithCount(tenantA, {
        q,
        status: ['active', 'inactive'],
        limit: 50,
        offset: 0,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const ids = res.value.items.map((r) => r.member.memberId);
      expect(ids).toContain(target.memberId);
    }
  });

  it('falls back to company/contact ILIKE when q is not a member number', async () => {
    const { tenantA } = await createTwoTestTenants();
    const m = await seedMember(tenantA, { companyName: 'Acme Trading' });
    const res = await drizzleMemberRepo.searchDirectoryWithCount(tenantA, {
      q: 'Acme',
      status: ['active', 'inactive'],
      limit: 50,
      offset: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.map((r) => r.member.memberId)).toContain(m.memberId);
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/integration/members/member-number-search.test.ts`. Expected failure: the `SCCM-0001` and `0001` queries return zero rows (current `directoryQFilter` only does company/contact ILIKE; `%SCCM-0001%` matches no `company_name`) → first test's `toContain` fails.

- [ ] Step 3: Implement — extend `directoryQFilter` to fold an optional integer equality into the same `or(...)`. Add the import at the top of the file (with the other domain imports):

```ts
import { parseMemberNumberQuery } from '../../domain/value-objects/member-number';
```

Replace `directoryQFilter` (`:167-182`):
```ts
/** Substring `q` across company_name + non-removed primary-contact name/email,
 *  plus an exact member-number match when `q` parses to a positive integer
 *  (`SCCM-0042` / `0042` / `42`). The integer branch uses the
 *  `members_tenant_member_number_uniq` index. */
function directoryQFilter(q: string) {
  // Escape LIKE metacharacters (% _ \) so a literal `_`/`%` in the term matches
  // literally instead of acting as a wildcard. Postgres ILIKE escape char is `\`.
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const num = parseMemberNumberQuery(q);
  return or(
    ilike(members.companyName, like),
    sql`EXISTS (SELECT 1 FROM contacts c
               WHERE c.tenant_id = ${members.tenantId}
                 AND c.member_id = ${members.memberId}
                 AND c.removed_at IS NULL
                 AND (c.first_name ILIKE ${like}
                      OR c.last_name ILIKE ${like}
                      OR c.email ILIKE ${like}))`,
    ...(num !== null ? [eq(members.memberNumber, num)] : []),
  )!;
}
```
(No call-site change — both callers already pass the conjunct through unchanged; `eq` is already imported.)

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/integration/members/member-number-search.test.ts`. Expected: 2 passed. Then `pnpm typecheck`.

- [ ] Step 5: Commit — `git add src/modules/members/infrastructure/db/drizzle-member-repo.ts tests/integration/members/member-number-search.test.ts` then `git commit -m "feat(members): admin directory search matches by member number"`.

---

### Task ADMIN-3: Map `memberNumber → member_number` in directory + member serialisers

**Files:**
- Modify: `src/app/api/members/_serialise.ts` (`serialiseDirectoryRow` `:64-86`, `serialiseMember` `:11-38`)
- Test: `tests/unit/members/presentation/serialise-member-number.test.ts` (new)

- [ ] Step 1: Write the failing test — REAL test code:

```ts
// tests/unit/members/presentation/serialise-member-number.test.ts
import { describe, expect, it } from 'vitest';
import { serialiseDirectoryRow, serialiseMember } from '@/app/api/members/_serialise';
import { asMemberNumber } from '@/modules/members';
import { makeTestMember, makeTestDirectoryRow } from '../../helpers/member-fixtures';

describe('serialiser maps memberNumber → member_number', () => {
  it('serialiseMember emits member_number', () => {
    const m = makeTestMember({ memberNumber: asMemberNumber(42) });
    expect(serialiseMember(m).member_number).toBe(42);
  });

  it('serialiseDirectoryRow emits member_number', () => {
    const row = makeTestDirectoryRow({ memberNumber: asMemberNumber(7) });
    expect(serialiseDirectoryRow(row).member_number).toBe(7);
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/presentation/serialise-member-number.test.ts`. Expected failure: `member_number` is `undefined` on both serialiser outputs → `toBe(42)` / `toBe(7)` fail. (If `makeTestMember`/fixtures are FOUNDATION-owned and lack `memberNumber`, this fails on the fixture type — expected.)

- [ ] Step 3: Implement — add `member_number` to both serialisers. `Member.memberNumber` is a branded `MemberNumber` (a `number`); JSON emits the raw integer.

In `serialiseMember` (`:11-38`), add after `member_id: m.memberId,`:
```ts
    member_number: m.memberNumber,
```

In `serialiseDirectoryRow` (`:64-86`), add after `member_id: row.member.memberId,`:
```ts
    member_number: row.member.memberNumber,
```

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/presentation/serialise-member-number.test.ts`. Expected: 2 passed. Then `pnpm typecheck`.

- [ ] Step 5: Commit — `git add src/app/api/members/_serialise.ts tests/unit/members/presentation/serialise-member-number.test.ts` then `git commit -m "feat(members): serialise member_number on member + directory payloads"`.

---

### Task ADMIN-4: `member_number` column in `MembersTableRow` + sortable table column

**Files:**
- Modify: `src/components/members/members-table.tsx` (`MembersTableRow` type `:81-119`; columns `useMemo` `:577-825`; add a `MemberNumberSortHeader` mirroring `EngagementSortHeader` `:152-182`)
- Test: `tests/unit/members/presentation/members-table-member-number.test.tsx` (new)

Placement: insert the `member_number` column as the **first data column** (before `company_name`), narrow + `whitespace-nowrap`, with a server-side sort header that toggles `?sort=memberNumber&order=`. The formatted string uses the CANON `formatMemberNumber` — but the *prefix* is per-tenant and resolved server-side; the row already carries the formatted string (see ADMIN-5 wiring note). To keep the client cell pure, the row carries a pre-formatted `member_number_display: string` from the page mapping; the raw integer `member_number` stays for sort/aria. (This avoids importing the tenant prefix into a client component.)

- [ ] Step 1: Write the failing test — REAL test code:

```tsx
// tests/unit/members/presentation/members-table-member-number.test.tsx
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error minimal jsdom polyfill
    globalThis.PointerEvent = class extends MouseEvent {};
  }
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const messages = {
  admin: {
    members: {
      directory: {
        sortByMemberNumber: 'Sort by member number',
        columns: {
          memberNumber: 'Member No.',
          company: 'Company', country: 'Country', plan: 'Plan', year: 'Year',
          primaryContact: 'Primary contact', status: 'Status', risk: 'Risk',
          engagement: 'Engagement', lastActivity: 'Last activity', notes: 'Notes',
        },
        sortByEngagement: 'Sort by engagement',
        engagementBand: { healthy: 'H', moderate: 'M', warning: 'W', critical: 'C' },
        riskNotComputed: 'Not yet scored', riskNotComputedTooltip: 'later',
        rowAriaLabel: 'Open {company}', noPrimary: 'No primary', loadMore: 'Load more',
        tableCaption: 'Members directory',
      },
      inlineEdit: { columnHeaderHintTooltip: 'edit' },
    },
  },
};

const row: MembersTableRow = {
  member_id: '11111111-1111-4111-8111-111111111111',
  member_number: 42,
  member_number_display: 'SCCM-0042',
  company_name: 'Zeta Holdings', country: 'TH',
  plan_id: 'corporate', plan_year: 2026, plan_display_name: 'Corporate',
  status: 'active', member_risk_flag: null, engagement: null,
  last_activity_at: null, notes: null, primary_contact: null,
};

describe('MembersTable member number column', () => {
  it('renders the formatted member number and a sort header', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable rows={[row]} nextCursor={null} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('SCCM-0042')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sort by member number' }),
    ).toBeInTheDocument();
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/presentation/members-table-member-number.test.tsx`. Expected failure: `member_number` / `member_number_display` are not valid `MembersTableRow` keys (TS error) and there is no `SCCM-0042` cell / "Sort by member number" button rendered.

- [ ] Step 3: Implement.

Extend `MembersTableRow` (after `member_id` at `:82`):
```ts
  /** Raw human-readable member number (integer) — used for sort + aria. */
  readonly member_number: number;
  /**
   * Pre-formatted display string (`SCCM-0042`) computed server-side in the
   * page row-mapping via `formatMemberNumber(tenantPrefix, …)`. Kept separate
   * from the raw integer so this client cell never imports the tenant prefix.
   */
  readonly member_number_display: string;
```

Add a sort header component (mirrors `EngagementSortHeader` `:152-182`), placed just above it:
```tsx
/** Server-side sort control for the member-number column (toggles
 *  `?sort=memberNumber&order=asc|desc`, resetting to page 1). */
function MemberNumberSortHeader() {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get('sort') === 'memberNumber';
  const order = searchParams.get('order');
  const nextOrder = active && order === 'asc' ? 'desc' : 'asc';

  function onSort() {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', 'memberNumber');
    params.set('order', nextOrder);
    params.set('page', '1');
    router.push(`${pathname}?${params.toString()}`);
  }

  const Icon = !active ? ArrowUpDownIcon : order === 'asc' ? ArrowUpIcon : ArrowDownIcon;
  return (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('sortByMemberNumber')}
      {...(active ? { 'aria-sort': order === 'asc' ? 'ascending' : 'descending' } : {})}
    >
      {t('columns.memberNumber')}
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
```

Insert the column as the **first accessor** in the columns array, immediately before the `company_name` accessor (`:630`):
```tsx
    columnHelper.accessor('member_number', {
      header: () => <MemberNumberSortHeader />,
      cell: (info) => (
        <span className="whitespace-nowrap tabular-nums text-sm">
          {info.row.original.member_number_display}
        </span>
      ),
      size: 90,
    }),
```

Note: the company-name link logic keys off `idx === 0` (no selection) / `idx === 1` (selection) at `:964`/`:975`. Adding member-number as the first column shifts the company link to `idx === 1` (no selection) / `idx === 2` (selection). Update those two index checks accordingly so the company name remains the linked cell. Add `member_number` is non-link (the row is reachable via the company link). Verify with the E2E row-link spec (ADMIN-6 covers CLS; row-link is exercised by the existing members E2E).

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/presentation/members-table-member-number.test.tsx`. Expected: 1 passed. Then `pnpm typecheck`.

- [ ] Step 5: Commit — `git add src/components/members/members-table.tsx tests/unit/members/presentation/members-table-member-number.test.tsx` then `git commit -m "feat(members): member-number column (narrow, nowrap, server-sortable)"`.

---

### Task ADMIN-5: Skeleton column-count bump (9→10 / 10→11) + presentation cell-count test

**Files:**
- Modify: `src/components/members/members-table-skeleton.tsx` (`cols` + `gridTemplate` `:34-40`, plus the header doc-comment `:8-18`)
- Test: `tests/unit/members/presentation/members-table-skeleton.test.tsx` (new)

CLS-0 blocker (ux-standards §15): the real table now emits **10** columns (no selection / manager) or **11** (with selection / admin) after ADMIN-4. TS/lint cannot catch the skeleton drift — this Vitest cell-count test guards it.

- [ ] Step 1: Write the failing test — REAL test code:

```tsx
// tests/unit/members/presentation/members-table-skeleton.test.tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

function headerCellCount(container: HTMLElement): number {
  // The header row is the first grid; count its Skeleton children.
  const grids = container.querySelectorAll('div.grid');
  return grids[0]!.querySelectorAll('div').length; // Skeleton renders a <div>
}

describe('MembersTableSkeleton column count matches the live table', () => {
  it('renders 10 header cells without selection (manager + baseline)', () => {
    const { container } = render(<MembersTableSkeleton />);
    expect(headerCellCount(container)).toBe(10);
  });

  it('renders 11 header cells with selection (admin)', () => {
    const { container } = render(<MembersTableSkeleton withSelection />);
    expect(headerCellCount(container)).toBe(11);
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/presentation/members-table-skeleton.test.tsx`. Expected failure: current skeleton emits 9 / 10 → `toBe(10)` / `toBe(11)` fail with `expected 9 to be 10`.

- [ ] Step 3: Implement — bump `cols` and both grid templates (`:34-40`):
```ts
  const cols = withSelection ? 11 : 10;
  // Build a grid template where the select column (when present) is
  // narrow to match the real `size: 40` checkbox column.
  const gridTemplate = withSelection
    ? '40px repeat(10, minmax(0, 1fr))'
    : 'repeat(10, minmax(0, 1fr))';
```
Update the header doc-comment (`:8-18`) so the count rationale stays accurate: the real table emits 10 (no selection) / 11 (with selection) since the member-number column landed; default stays `false` (manager baseline → CLS 0; admin sees at-most a 1-column first-paint shift).

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/presentation/members-table-skeleton.test.tsx`. Expected: 2 passed. Then `pnpm typecheck`.

- [ ] Step 5: Commit — `git add src/components/members/members-table-skeleton.tsx tests/unit/members/presentation/members-table-skeleton.test.tsx` then `git commit -m "fix(members): skeleton 10/11 cols for member-number column (CLS-0)"`.

---

### Task ADMIN-6: Admin detail — formatted member number + CopyButton above the UUID

**Files:**
- Modify: `src/app/(staff)/admin/members/[memberId]/page.tsx` (Company `<dl>` — insert before the `fields.memberId` UUID Field at `:617-627`)
- Test: `tests/unit/members/presentation/member-detail-number-field.test.tsx` (new — renders the Field+CopyButton fragment in isolation)

The detail page is an RSC that loads the full `Member` (carrying `memberNumber` from FOUNDATION). The tenant prefix is resolved server-side via the FOUNDATION `MemberSettingsReaderPort` (a `getPrefix` read already wired by the page's loader for this feature); format with the CANON `formatMemberNumber(prefix, member.memberNumber)`. Because the full page loader needs live Neon + auth, the unit test renders only the new `Field` fragment to assert the formatted value + copy affordance; full-page wiring is covered by the members E2E badge/detail spec.

- [ ] Step 1: Write the failing test — REAL test code:

```tsx
// tests/unit/members/presentation/member-detail-number-field.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MemberNumberField } from '@/components/members/member-number-field';

const messages = {
  admin: { members: { detail: {
    fields: { memberNumber: 'Member No.' },
    copy: { copyMemberNumber: 'Copy member number' },
  } } },
};

describe('MemberNumberField (admin detail)', () => {
  it('shows the formatted member number + a copy button', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MemberNumberField formatted="SCCM-0042" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('SCCM-0042')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy member number' }),
    ).toBeInTheDocument();
  });
});
```

- [ ] Step 2: Run test, verify it fails — `pnpm vitest run tests/unit/members/presentation/member-detail-number-field.test.tsx`. Expected failure: module `@/components/members/member-number-field` does not exist → import error.

- [ ] Step 3: Implement.

Create `src/components/members/member-number-field.tsx` — a small RSC-friendly fragment reusing the existing `Field` primitive + `CopyButton` (`page.tsx:45`, `:617-627` pattern):
```tsx
import { useTranslations } from 'next-intl';
import { Field } from '@/components/ui/field';
import { CopyButton } from '@/components/members/copy-button';

/** Admin detail — formatted human-readable member number with a copy
 *  affordance. Rendered ABOVE the UUID Field (backend lookups stay UUID). */
export function MemberNumberField({ formatted }: { readonly formatted: string }) {
  const t = useTranslations('admin.members.detail');
  return (
    <Field
      label={t('fields.memberNumber')}
      value={formatted}
      mono
      extra={<CopyButton value={formatted} label={t('copy.copyMemberNumber')} />}
    />
  );
}
```
(Confirm the `Field` import path against `page.tsx` — it imports `Field` from its local detail helpers; if `Field` is page-local, lift this fragment inline into the `<dl>` instead of a separate component and adjust the test to render the page's `Field`. Reading `page.tsx`'s `Field` import at implementation time decides this; the canonical CANON contract here is only the i18n keys + the "formatted number with CopyButton above the UUID" placement.)

Wire into the Company `<dl>` (insert immediately before the `fields.memberId` Field at `:617`):
```tsx
              <MemberNumberField formatted={memberNumberDisplay} />
```
where `memberNumberDisplay = formatMemberNumber(memberPrefix, member.memberNumber)` is computed in the page body after the member + prefix load (Group ALLOC supplies `memberPrefix` via `MemberSettingsReaderPort.getPrefix`).

- [ ] Step 4: Run test, verify pass — `pnpm vitest run tests/unit/members/presentation/member-detail-number-field.test.tsx`. Expected: 1 passed. Then `pnpm typecheck`.

- [ ] Step 5: Commit — `git add src/components/members/member-number-field.tsx "src/app/(staff)/admin/members/[memberId]/page.tsx" tests/unit/members/presentation/member-detail-number-field.test.tsx` then `git commit -m "feat(members): admin detail shows formatted member number + copy button"`.

---

### Task ADMIN-7: i18n keys (EN canonical + TH + SV) — column label, sort label, detail field, copy label, updated search placeholder

**Files:**
- Modify: `src/i18n/messages/en.json` (`admin.members.directory.columns` `:885-896`; `directory.searchPlaceholder` `:859`; add `directory.sortByMemberNumber`; `detail.fields` `:973-979`; `detail.copy`)
- Modify: `src/i18n/messages/th.json` (same paths)
- Modify: `src/i18n/messages/sv.json` (same paths)
- Test: gate via `pnpm check:i18n` (no new Vitest file — the i18n coverage script is the guard)

Per design §10: column label `Member No.` / `เลขสมาชิก` / `Medlemsnr` (nowrap applied in the component); detail full label `Member Number` / `หมายเลขสมาชิก` / `Medlemsnummer`; updated search placeholder hints a member number is accepted.

- [ ] Step 1: Write the failing check — run the i18n coverage gate first to capture the baseline (the new EN keys are referenced by ADMIN-4/ADMIN-6 components but not yet present):
  `pnpm check:i18n` — expected at this point: PASS on the *current* tree (keys not yet referenced in committed messages) but the component tests added in ADMIN-4/6 already reference `columns.memberNumber`, `sortByMemberNumber`, `detail.fields.memberNumber`, `detail.copy.copyMemberNumber`. To make the missing-key failure explicit, add the keys to EN only first, then run `pnpm check:i18n` — expected FAIL: `missing TH key admin.members.directory.columns.memberNumber` (+ SV) since EN is canonical and TH/SV must mirror.

- [ ] Step 2: Verify it fails — `pnpm check:i18n`. Expected: non-zero exit listing the missing TH + SV keys (`columns.memberNumber`, `sortByMemberNumber`, `detail.fields.memberNumber`, `detail.copy.copyMemberNumber`) and the changed `searchPlaceholder` is not a coverage failure (same key) — the four NEW keys are the RED.

- [ ] Step 3: Implement — add the keys in all three locales.

EN (`en.json`) — in `directory.columns` (`:885-896`) add `"memberNumber": "Member No.",` as the **first** column key; add sibling `"sortByMemberNumber": "Sort by member number"` next to `"sortByEngagement"` (`:884`); change `searchPlaceholder` (`:859`) to `"Search by company, contact name, email, or member number"`; in `detail.fields` (`:973`) add `"memberNumber": "Member Number",`; in `detail.copy` add `"copyMemberNumber": "Copy member number"`.

TH (`th.json`) — same paths: `columns.memberNumber` = `"เลขสมาชิก"`; `sortByMemberNumber` = `"เรียงตามหมายเลขสมาชิก"`; `searchPlaceholder` = `"ค้นหาด้วยชื่อบริษัท ผู้ติดต่อ อีเมล หรือหมายเลขสมาชิก"`; `detail.fields.memberNumber` = `"หมายเลขสมาชิก"`; `detail.copy.copyMemberNumber` = `"คัดลอกหมายเลขสมาชิก"`.

SV (`sv.json`) — `columns.memberNumber` = `"Medlemsnr"`; `sortByMemberNumber` = `"Sortera efter medlemsnummer"`; `searchPlaceholder` = `"Sök på företag, kontakt, e-post eller medlemsnummer"`; `detail.fields.memberNumber` = `"Medlemsnummer"`; `detail.copy.copyMemberNumber` = `"Kopiera medlemsnummer"`.

- [ ] Step 4: Run check, verify pass — `pnpm check:i18n`. Expected: PASS (0 missing keys across EN/TH/SV). Then re-run the ADMIN-4 + ADMIN-6 component tests with real messages stubs unaffected: `pnpm vitest run tests/unit/members/presentation/members-table-member-number.test.tsx tests/unit/members/presentation/member-detail-number-field.test.tsx`. Expected: all passed. Then `pnpm typecheck`.

- [ ] Step 5: Commit — `git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json` then `git commit -m "i18n(members): member-number column, sort, detail + search placeholder (en/th/sv)"`.

---

**Cross-group dependency note:** ADMIN-1/2/3/4/6 read `members.memberNumber` (Drizzle column + `Member.memberNumber` aggregate field), `asMemberNumber`, `formatMemberNumber`, `parseMemberNumberQuery`, and the `MemberSettingsReaderPort.getPrefix` read — all delivered by the Group ALLOC and re-exported from `@/modules/members`. Run the ADMIN suite only after FOUNDATION's migrations `0209`/`0210` are applied to live Neon (`pnpm drizzle-kit migrate`) and FOUNDATION's barrel exports land, otherwise ADMIN-1/2 fail on a missing column and ADMIN-3/4/6 fail on missing CANON imports (the intended ordering signal, not a regression).

---

## Group PORTAL — member-facing serializers, portal display & GDPR export

> **Cross-group dependency:** these tasks consume CANON Domain exports (`formatMemberNumber`, `MemberNumber`, `Member.memberNumber`) that Group DOMAIN adds to `src/modules/members/index.ts` + `src/modules/members/domain/member.ts`. PORTAL tasks are written so each test fails *first* on a missing field/import (RED), then passes once both DOMAIN has landed `memberNumber` on the `Member` aggregate **and** the PORTAL code emits it. Run PORTAL tests after DOMAIN's `member-number.ts` + barrel re-export tasks are green. Where a test must not depend on DOMAIN timing, it stubs `formatMemberNumber`/`memberNumber` locally (noted per-task).

---

### Task PORTAL-1: Admin `serialiseMember` emits `member_number` (+ unit test)

**Files:**
- Modify: `src/app/api/members/_serialise.ts` (`serialiseMember`, lines 11-38 — add one mapped field)
- Test (Create): `tests/unit/members/serialise-member.test.ts`

- [ ] **Step 1: Write the failing test** — REAL test code:

```ts
/**
 * Unit: serialiseMember maps the Domain aggregate to the /api/members JSON shape.
 * Pins that member_number (snake_case) is emitted from Member.memberNumber.
 */
import { describe, it, expect } from 'vitest';
import { serialiseMember } from '@/app/api/members/_serialise';
import type { Member } from '@/modules/members';

function makeMember(): Member {
  return {
    memberId: '11111111-1111-1111-1111-111111111111',
    tenantId: 'test-swecham',
    memberNumber: 42 as Member['memberNumber'],
    companyName: 'Fogmaker AB',
    legalEntityType: 'limited',
    country: 'SE',
    taxId: null,
    website: null,
    description: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: new Date('2026-01-15T00:00:00.000Z'),
    registrationFeePaid: true,
    status: 'active',
    archivedAt: null,
    lastActivityAt: null,
    notes: null,
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    updatedAt: new Date('2026-01-15T00:00:00.000Z'),
  } as Member;
}

describe('serialiseMember', () => {
  it('emits member_number from Member.memberNumber', () => {
    const body = serialiseMember(makeMember());
    expect(body.member_number).toBe(42);
  });

  it('keeps the existing member_id + status mapping intact', () => {
    const body = serialiseMember(makeMember());
    expect(body.member_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm vitest run tests/unit/members/serialise-member.test.ts`
  Expected: FAIL — `expect(body.member_number).toBe(42)` → `received: undefined` (serializer does not map the field yet). If DOMAIN has not landed `memberNumber` on `Member`, the `as Member` cast keeps this compiling; the assertion still drives the RED.

- [ ] **Step 3: Implement** — add the field to `serialiseMember` (after `member_id`, before `company_name`, so the number sits next to the UUID it complements):

```ts
export function serialiseMember(m: Member) {
  return {
    member_id: m.memberId,
    member_number: m.memberNumber,
    company_name: m.companyName,
    legal_entity_type: m.legalEntityType,
    country: m.country,
    tax_id: m.taxId,
    website: m.website,
    description: m.description,
    address_line1: m.addressLine1,
    address_line2: m.addressLine2,
    city: m.city,
    province: m.province,
    postal_code: m.postalCode,
    founded_year: m.foundedYear,
    turnover_thb: m.turnoverThb,
    plan_id: m.planId,
    plan_year: m.planYear,
    registration_date: m.registrationDate.toISOString().slice(0, 10),
    registration_fee_paid: m.registrationFeePaid,
    status: m.status,
    archived_at: m.archivedAt?.toISOString() ?? null,
    last_activity_at: m.lastActivityAt?.toISOString() ?? null,
    notes: m.notes,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
  };
}
```

- [ ] **Step 4: Run test, verify pass** — `pnpm vitest run tests/unit/members/serialise-member.test.ts`
  Expected: PASS — 2/2 green.

- [ ] **Step 5: Commit**
  `git add src/app/api/members/_serialise.ts tests/unit/members/serialise-member.test.ts`
  `git commit -m "feat(members): admin serialiseMember emits member_number"`

---

### Task PORTAL-2: MANDATORY contract test — `GET /api/members/[id]` body has `member_number`

**Files:**
- Modify: `tests/contract/members/get-member.test.ts` (`MEMBER_FIXTURE.member` ~lines 79-100; success test ~lines 129-141)
- (No route change — `route.ts:85` already spreads `serialiseMember(...)`; PORTAL-1 wired the field. This task is the contract-level proof per design §8.3.)

- [ ] **Step 1: Write the failing test** — add `memberNumber` to the fixture and a new assertion. Edit `MEMBER_FIXTURE.member` to add the field right under `memberId`:

```ts
const MEMBER_FIXTURE = {
  member: {
    memberId: MEMBER_ID,
    memberNumber: 42,
    tenantId: 'test-swecham',
    companyName: 'Fogmaker AB',
    legalEntityType: 'limited',
    country: 'SE',
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: new Date('2026-01-15'),
    registrationFeePaid: true,
    status: 'active',
    archivedAt: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: null,
  },
  // ...contacts unchanged
```

  And extend the 200 success test (after the `body.member_id` assertion, ~line 138):

```ts
  it('200 — returns serialised member with contacts on success', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(ok(MEMBER_FIXTURE));

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toBe(MEMBER_ID);
    // Human-readable display id — MUST be present in the admin payload
    // (design §8.3: serializer divergence already bit tax_id once).
    expect(body.member_number).toBe(42);
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].first_name).toBe('Anna');
  });
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm vitest run tests/contract/members/get-member.test.ts`
  Expected: FAIL on the `member_number` assertion **only if PORTAL-1 is not yet applied**. If PORTAL-1 already landed, this is a regression-lock that should pass immediately — to confirm RED first, run this test *before* committing PORTAL-1, or temporarily stub the assertion against the un-mapped serializer. Document in the commit which order was used.

- [ ] **Step 3: Implement** — no production change here (PORTAL-1 supplies the mapping). This task's deliverable is the contract assertion + fixture field. If RED was observed pre-PORTAL-1, apply PORTAL-1 to turn it green.

- [ ] **Step 4: Run test, verify pass** — `pnpm vitest run tests/contract/members/get-member.test.ts`
  Expected: PASS — all 5 `it` blocks green; the 200 case now asserts `member_number === 42`.

- [ ] **Step 5: Commit**
  `git add tests/contract/members/get-member.test.ts`
  `git commit -m "test(members): contract asserts GET /api/members/[id] body.member_number"`

---

### Task PORTAL-3: Portal `serialiseMember` emits `member_number` (preserve redaction whitelist)

**Files:**
- Modify: `src/app/api/portal/profile/route.ts` (`serialiseMember`, lines 21-54 — narrower whitelisted struct that redacts `tax_id`/`notes`)
- Test (Create): `tests/unit/portal/portal-serialise-member.test.ts`

- [ ] **Step 1: Write the failing test** — REAL test code. The portal serializer is a local (non-exported) function, so the test exercises it through the GET route with mocked deps, asserting both that `member_number` is present **and** that the redaction whitelist still holds (no `tax_id`/`notes`):

```ts
/**
 * Unit: portal serialiseMember (via GET /api/portal/profile) emits member_number
 * WITHOUT breaking the redaction whitelist (tax_id / notes stay omitted).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const getMemberMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...a: unknown[]) => requireMemberContextMock(...a),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, contactRepo: {}, audit: {} }),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return { ...actual, getMember: (...a: unknown[]) => getMemberMock(...a) };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const MEMBER_ID = '11111111-1111-1111-1111-111111111111';

const memberCtx = {
  tenant: { slug: 'test-swecham', __brand: true },
  memberId: MEMBER_ID,
  current: { user: { id: 'u1' } },
  requestId: 'req-portal-1',
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3100/api/portal/profile', { method: 'GET' });
}

const MEMBER = {
  memberId: MEMBER_ID,
  memberNumber: 42,
  companyName: 'Fogmaker AB',
  legalEntityType: 'limited',
  country: 'SE',
  taxId: 'SE-SECRET-9999', // MUST NOT appear in the portal payload
  website: null,
  description: null,
  planId: 'plan-1',
  planYear: 2026,
  registrationDate: new Date('2026-01-15T00:00:00.000Z'),
  registrationFeePaid: true,
  status: 'active',
  lastActivityAt: null,
  notes: 'INTERNAL ADMIN NOTE', // MUST NOT appear
  createdAt: new Date('2026-01-15T00:00:00.000Z'),
  updatedAt: new Date('2026-01-15T00:00:00.000Z'),
};

describe('portal GET /api/portal/profile serialiseMember', () => {
  afterEach(() => vi.clearAllMocks());

  it('emits member_number and preserves the redaction whitelist', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    getMemberMock.mockResolvedValueOnce(ok({ member: MEMBER, contacts: [] }));

    const { GET } = await import('@/app/api/portal/profile/route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_number).toBe(42);
    // Redaction whitelist intact (design §8.3 — tax_id/notes deliberately absent).
    expect(body).not.toHaveProperty('tax_id');
    expect(body).not.toHaveProperty('notes');
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm vitest run tests/unit/portal/portal-serialise-member.test.ts`
  Expected: FAIL — `expect(body.member_number).toBe(42)` → `received: undefined` (portal serializer does not map the field).

- [ ] **Step 3: Implement** — extend the portal `serialiseMember` type + body. Add `memberNumber: number` to the param type and `member_number` next to `member_id` (keep the redaction comment):

```ts
function serialiseMember(member: {
  memberId: string;
  memberNumber: number;
  companyName: string;
  legalEntityType: string | null;
  country: string;
  website: string | null;
  description: string | null;
  planId: string;
  planYear: number;
  registrationDate: Date;
  registrationFeePaid: boolean;
  status: string;
  lastActivityAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    member_id: member.memberId,
    member_number: member.memberNumber,
    company_name: member.companyName,
    legal_entity_type: member.legalEntityType,
    country: member.country,
    website: member.website,
    description: member.description,
    plan_id: member.planId,
    plan_year: member.planYear,
    registration_date: member.registrationDate.toISOString().split('T')[0],
    registration_fee_paid: member.registrationFeePaid,
    status: member.status,
    last_activity_at: member.lastActivityAt?.toISOString() ?? null,
    created_at: member.createdAt.toISOString(),
    updated_at: member.updatedAt.toISOString(),
    // Redacted fields per contract #12: tax_id, notes, override reasons omitted
  };
}
```

- [ ] **Step 4: Run test, verify pass** — `pnpm vitest run tests/unit/portal/portal-serialise-member.test.ts`
  Expected: PASS — `member_number === 42`, no `tax_id`/`notes` keys.

- [ ] **Step 5: Commit**
  `git add src/app/api/portal/profile/route.ts tests/unit/portal/portal-serialise-member.test.ts`
  `git commit -m "feat(portal): profile serialiser emits member_number, redaction preserved"`

---

### Task PORTAL-4: i18n portal full label `Member Number` (EN+TH+SV)

**Files:**
- Modify: `src/i18n/messages/en.json` (`portal.profile.fields`, after line 4244 `memberIdCopy`)
- Modify: `src/i18n/messages/th.json` (same path)
- Modify: `src/i18n/messages/sv.json` (same path)
- Test: covered by `pnpm check:i18n` (no Vitest file — i18n coverage is a CI gate)

- [ ] **Step 1: Write the failing test** — the failing check is the i18n coverage gate. First add the canonical EN key, then prove TH/SV are missing. Add to EN `portal.profile.fields` (after `memberIdCopied`):

```json
        "memberId": "Member ID",
        "memberIdHelp": "Reference this ID when contacting chamber support.",
        "memberIdCopy": "Copy member ID",
        "memberIdCopied": "Member ID copied",
        "memberNumber": "Member Number",
        "memberNumberCopy": "Copy member number",
        "companyName": "Company Name",
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm check:i18n`
  Expected: FAIL/WARN — `portal.profile.fields.memberNumber` + `.memberNumberCopy` present in `en` but missing in `th` and `sv` (release-branch CI-blocking warning per CLAUDE.md i18n rule).

- [ ] **Step 3: Implement** — add the matching keys to TH and SV at `portal.profile.fields`:

  `th.json`:
```json
        "memberNumber": "หมายเลขสมาชิก",
        "memberNumberCopy": "คัดลอกหมายเลขสมาชิก",
```
  `sv.json`:
```json
        "memberNumber": "Medlemsnummer",
        "memberNumberCopy": "Kopiera medlemsnummer",
```

- [ ] **Step 4: Run test, verify pass** — `pnpm check:i18n`
  Expected: PASS — all three locales carry `portal.profile.fields.memberNumber` + `.memberNumberCopy`; no missing-key warning.

- [ ] **Step 5: Commit**
  `git add src/i18n/messages/en.json src/i18n/messages/th.json src/i18n/messages/sv.json`
  `git commit -m "i18n(portal): add member number label (en/th/sv)"`

---

### Task PORTAL-5: Portal profile card shows `formatMemberNumber` above the UUID

**Files:**
- Modify: `src/app/(member)/portal/profile/page.tsx` (Company Info card, the member-id `<div className="lg:col-span-3">` block, lines 124-138)
- Test: RSC — no JSON contract; covered by the E2E badge/label test owned by the E2E group (design §8.3/§11). This task adds the markup; verify via `pnpm typecheck` + `pnpm lint` + a dev-server visual check.

- [ ] **Step 1: Write the failing test** — RSC has no unit-test seam here (server component fetching session + deps). The "failing test" is the design assertion that the formatted number renders **above** the UUID. Capture it as a throwaway probe in the dev environment per the E2E group's badge spec; for this task the executable gate is `pnpm typecheck` failing on the missing `formatMemberNumber` import / `m.memberNumber` field until DOMAIN lands. Record the expected rendered string for the E2E group: prefix from tenant settings (SweCham=`SCCM`) + pad-4 → e.g. `SCCM-0042`.

  > For MVP the portal card uses the default prefix `M` unless a per-tenant prefix is threaded. Design §8.2/§8.3 reads the prefix at display time. To avoid a portal→`tenant_member_settings` read in this task (Group ALLOC owns that port wiring), render with the resolved prefix passed by SETTINGS' `MemberSettingsReaderPort`; if that wiring is not yet available on the portal RSC, render `formatMemberNumber('M', asMemberNumber(m.memberNumber))` and leave a `// prefix threaded via deps.memberSettings (Group ALLOC) — resolved through runInTenant, see Plan corrections

- [ ] **Step 2: Run test, verify it fails** — `pnpm typecheck`
  Expected: FAIL — `Property 'memberNumber' does not exist on type 'Member'` (until DOMAIN lands) and/or `formatMemberNumber is not exported from '@/modules/members'`.

- [ ] **Step 3: Implement** — import the formatter + value-object from the barrel and add a member-number row **above** the existing member-id row. Add to the import block (with the other `@/modules/members` import near line 20):

```ts
import { getMember, formatMemberNumber, asMemberNumber } from '@/modules/members';
```

  Then insert, immediately **before** the `<div className="lg:col-span-3">` member-id block at line 124, a new full-width row (prefix resolved from the tenant settings reader threaded by Group ALLOC as `memberNumberPrefix`; default `'M'`):

```tsx
            <div className="lg:col-span-3">
              <dt className="text-caption text-muted-foreground">
                {t('fields.memberNumber')}
              </dt>
              <dd className="text-body flex items-center gap-2">
                <span className="font-mono text-sm font-medium">
                  {formatMemberNumber(memberNumberPrefix, asMemberNumber(m.memberNumber))}
                </span>
                <CopyButton
                  value={formatMemberNumber(memberNumberPrefix, asMemberNumber(m.memberNumber))}
                  label={t('fields.memberNumberCopy')}
                />
              </dd>
            </div>
```

  Resolve `memberNumberPrefix` near where `planLookup` is resolved (line 94), via the SETTINGS reader dep (mirrors `deps.plans.getPlan`):

```ts
            const memberNumberPrefix = await deps.memberSettings.getPrefix(tenant, /* tx not needed on read path */ );
```

  > If ALLOC's `getPrefix` requires a `tx`, the portal RSC reads via a small read-only `runInTenant` wrapper SETTINGS exposes; coordinate the exact signature with Group ALLOC before writing. Do not open a raw `db` query here (RLS-bypass gotcha). If Group ALLOC is not yet merged (ALLOC precedes this group, so this cannot occur), gate this task behind theirs.

- [ ] **Step 4: Run test, verify pass** — `pnpm typecheck && pnpm lint`
  Expected: PASS — clean typecheck/lint. Then a dev-server check at `/portal/profile` shows `Member Number SCCM-0042` (or `M-0042` with the default prefix) rendered above the `Member ID` UUID row, both with copy buttons. Hand the rendered string to the E2E group for the `@i18n`/badge spec.

- [ ] **Step 5: Commit**
  `git add "src/app/(member)/portal/profile/page.tsx"`
  `git commit -m "feat(portal): show formatted member number above UUID on profile card"`

---

### Task PORTAL-6: Portal dashboard badge near company name

**Files:**
- Modify: `src/app/(member)/portal/page.tsx` (`PageHeader`, lines 41-45 — `MemberPortalHomePage`)
- Modify: `src/i18n/messages/{en,th,sv}.json` (`auth.memberPortal` block — add a `memberNumberBadge` label if a screen-reader prefix is wanted; otherwise reuse `portal.profile.fields.memberNumber`)
- Test: RSC — verified by `pnpm typecheck` + dev check; E2E badge assertion owned by the E2E group.

- [ ] **Step 1: Write the failing test** — the dashboard currently has **no** member lookup (it renders from `user` only, line 36). To show the number near the company name it must resolve the member. The failing gate is `pnpm typecheck` once we add `m.memberNumber` usage. Record the expected DOM for the E2E group: a `<Badge>` reading the formatted number adjacent to the company name in the `PageHeader`.

- [ ] **Step 2: Run test, verify it fails** — `pnpm typecheck`
  Expected: FAIL — `memberNumber`/`formatMemberNumber` unresolved until DOMAIN lands and the member is fetched.

- [ ] **Step 3: Implement** — resolve the member (mirroring the profile page pattern: `deps.memberRepo.findByLinkedUserId`), then render a badge. Add imports + lookup and pass the formatted number into `PageHeader`. Minimal change to keep the dashboard light — fetch only what the badge needs:

```ts
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { formatMemberNumber, asMemberNumber } from '@/modules/members';
```

  In the component body, after `const t = ...`:

```ts
  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);
  const memberRes = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  const memberNumberPrefix = await deps.memberSettings.getPrefix(tenant);
  const memberNumberLabel = memberRes.ok
    ? formatMemberNumber(memberNumberPrefix, asMemberNumber(memberRes.value.memberNumber))
    : null;
```

  Then render it in the `PageHeader` next to the existing version badge (company name shows as the welcome title's `name`; place the member-number badge alongside):

```tsx
      <PageHeader
        title={t('welcome', { name: user.displayName ?? user.email })}
        subtitle={t('intro')}
        badge={
          <span className="flex items-center gap-2">
            {memberNumberLabel ? (
              <Badge variant="outline" className="font-mono">
                {memberNumberLabel}
              </Badge>
            ) : null}
            <Badge variant="secondary">{t('versionBadge')}</Badge>
          </span>
        }
      />
```

  > Coordinate the `getPrefix` signature with Group ALLOC exactly as in PORTAL-5; do not open a raw `db` read. If `PageHeader`'s `badge` prop is single-node-typed, wrap as above (a `<span>` keeps it one node).

- [ ] **Step 4: Run test, verify pass** — `pnpm typecheck && pnpm lint`
  Expected: PASS. Dev check at `/portal` shows the `SCCM-0042` (or `M-0042`) outline badge beside the version badge on the welcome header. Hand the rendered string to the E2E group.

- [ ] **Step 5: Commit**
  `git add "src/app/(member)/portal/page.tsx"`
  `git commit -m "feat(portal): show member number badge on dashboard welcome header"`

---

### Task PORTAL-7: GDPR archive `profile.json` includes `member_number`

**Files:**
- Modify: `src/modules/insights/infrastructure/sources/gdpr-archive-source-adapter.ts` (`gather`, the `profile` object, lines 270-296 — add `member_number: member.memberNumber`)
- Modify: `tests/unit/insights/gdpr-archive-source-adapter.test.ts` (`baseMember()` ~lines 55-79; add an assertion)

- [ ] **Step 1: Write the failing test** — add `memberNumber` to the mock `baseMember()` and a new assertion. Add the field to `baseMember()` (after `memberId`, line 57):

```ts
function baseMember() {
  return {
    memberId: MEMBER,
    memberNumber: 7,
    companyName: 'Acme Co',
    // ...rest unchanged
```

  Add a new `it` block (after the postal-address test, ~line 141):

```ts
  it('profile includes member_number — the subject\'s own display id (GDPR Art.15/20 transparency)', async () => {
    listInvoicesByMemberMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    const data = await gdprArchiveSourceAdapter.gather(CTX, { subjectMemberId: MEMBER });
    expect(data).not.toBeNull();
    expect(data!.profile).toMatchObject({ member_number: 7 });
  });
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm vitest run tests/unit/insights/gdpr-archive-source-adapter.test.ts`
  Expected: FAIL — `expect(data!.profile).toMatchObject({ member_number: 7 })` → `member_number` absent from the profile block.

- [ ] **Step 3: Implement** — add the field to the `profile` object in `gather`, right under `memberId` (line 271), so the subject's display id sits next to its UUID:

```ts
      profile: {
        memberId: member.memberId,
        member_number: member.memberNumber,
        companyName: member.companyName,
        legalEntityType: member.legalEntityType,
        country: member.country,
        taxId: member.taxId,
        turnoverThb: member.turnoverThb,
        addressLine1: member.addressLine1,
        addressLine2: member.addressLine2,
        city: member.city,
        province: member.province,
        postalCode: member.postalCode,
        website: member.website,
        description: member.description,
        foundedYear: member.foundedYear,
        planId: member.planId,
        planYear: member.planYear,
        status: member.status,
        registrationDate: isoOrNull(member.registrationDate),
        registrationFeePaid: member.registrationFeePaid,
        createdAt: isoOrNull(member.createdAt),
        updatedAt: isoOrNull(member.updatedAt),
      },
```

  > `member.memberNumber` is the branded `MemberNumber` (a `number` at runtime) — it JSON-serialises as a plain integer (`7`), no `.toString()`/`.raw` needed (unlike `documentNumber`). Equals the stored integer per CANON. Key name is `member_number` (snake) to match the rest of the GDPR profile camelCase→ this block actually uses camelCase keys (`companyName`, `legalEntityType`); per design §8.3 the GDPR export field is `member_number` equal to `member.memberNumber`. Keep `member_number` snake as the design specifies (it is the subject-facing display field, mirroring the portal/admin `member_number` JSON contract); the surrounding camelCase keys are the existing convention and are left unchanged to avoid a churn diff.

- [ ] **Step 4: Run test, verify pass** — `pnpm vitest run tests/unit/insights/gdpr-archive-source-adapter.test.ts`
  Expected: PASS — all existing tests green + the new `member_number: 7` assertion passes.

- [ ] **Step 5: Commit**
  `git add src/modules/insights/infrastructure/sources/gdpr-archive-source-adapter.ts tests/unit/insights/gdpr-archive-source-adapter.test.ts`
  `git commit -m "feat(insights): GDPR archive profile.json includes member_number"`

---

### Task PORTAL-8: Final group gate — typecheck + lint + i18n + touched suites

**Files:** none (verification only)

- [ ] **Step 1: Write the failing test** — N/A (aggregate gate).
- [ ] **Step 2: Run** — `pnpm typecheck` as the FINAL gate after the last PORTAL edit (per memory: typecheck is not in pre-push; an earlier run misses later edits).
- [ ] **Step 3: Run the full PORTAL surface** —
  `pnpm vitest run tests/unit/members/serialise-member.test.ts tests/contract/members/get-member.test.ts tests/unit/portal/portal-serialise-member.test.ts tests/unit/insights/gdpr-archive-source-adapter.test.ts`
  then `pnpm lint` and `pnpm check:i18n`.
- [ ] **Step 4: Verify pass** — Expected: typecheck clean; all 4 suites green; lint clean; i18n shows `portal.profile.fields.memberNumber` + `.memberNumberCopy` in en/th/sv. Cross-check each AS in design §8.3/§11 maps to a green path (admin contract `member_number`, portal serializer redaction-safe, GDPR `profile.json`, portal card + dashboard badge rendered).
- [ ] **Step 5: Commit** — no code; if any fixup was needed, commit it explicitly: `git add <explicit fixed files>` + `git commit -m "fix(portal): close member-number group verification gaps"`.

---

**PORTAL group dependencies & notes (for the integrator):**
- **Hard dep on Group DOMAIN**: `Member.memberNumber: MemberNumber` + `formatMemberNumber` + `asMemberNumber` exported from `@/modules/members`. PORTAL-1/3/7 unit tests cast/mock the field so they can be authored RED before DOMAIN merges, but they only go GREEN once DOMAIN lands. PORTAL-5/6 (`pnpm typecheck`) hard-fail until DOMAIN exports exist.
- **Dep on Group ALLOC** (precedes this group in the execution order): `deps.memberSettings.getPrefix` supplies the display prefix in PORTAL-5/6, resolved via a read-only `runInTenant` wrapper (Plan corrections §2 — CANON signature `getPrefix(tx, tenantId)`). Never open a raw `db` read on the portal RSC (RLS-bypass gotcha, CLAUDE.md § Gotchas).
- **Grounded file facts**: admin `serialiseMember` lives at `src/app/api/members/_serialise.ts:11`; the route spreads it at `route.ts:85` (no route edit needed). Portal serializer is the narrower struct at `src/app/api/portal/profile/route.ts:21` (redacts `tax_id`/`notes`). GDPR profile block is `gdpr-archive-source-adapter.ts:270-296`. EN portal labels are at `en.json` `portal.profile.fields` (line 4240).
- No new audit events, migrations, or DB reads originate in PORTAL (those are DOMAIN/SETTINGS/MIGRATION groups). PORTAL is read-and-display only.

---

## PDF Group — Invoice/receipt PDF snapshot + template (member number)

**Scope (this group only):** extend the `MemberIdentitySnapshot` value object (interface + zod, same task) so the snapshot can carry `member_number: number | null`; wire the membership write-path adapter (`getForIssue`) to snapshot the real number; confirm the event-invoice draft path needs no change (absent key → `null` via `.default(null)`); render a bilingual `หมายเลขสมาชิก / Member No.` line in the invoice-template buyer block guarded by `!== null`; and pin three golden cases (membership shows, event omits, historical-snapshot omits) for SC-003 determinism.

**Cross-group dependency note:** this group consumes only the snapshot's plain `member_number: number | null` JSONB field. It does **not** import the `MemberNumber` brand, `asMemberNumber`, or `formatMemberNumber` from the members module — the buyer block already gets the *formatted* string-less raw integer and the PDF prints the integer directly with the tenant-agnostic `Member No.` label (the PDF buyer block has no tenant prefix in scope at render time; the snapshot stores the bare number, matching how `tax_id` is stored bare). Tasks below define no members-module names.

---

### Task PDF-1: Extend `MemberIdentitySnapshot` interface + zod schema (same task) with `member_number`

**Files:**
- Modify: `src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts` (interface lines 20-26; `memberIdentitySnapshotSchema` lines 35-59)
- Test: `tests/unit/invoicing/domain/member-identity-snapshot.test.ts` (append to existing `makeMemberIdentitySnapshot` + schema describes)

- [ ] **Step 1: Write the failing test** — append these cases (the strip-regression is the load-bearing one: `z.object` strips undeclared keys, so adding the field to the TS interface but not the zod schema would silently drop it):

```ts
// ── 055-member-number: snapshot carries an optional member_number ──
describe('member_number on memberIdentitySnapshotSchema (055-member-number)', () => {
  it('parses and KEEPS a positive integer member_number (strip-regression — zod must declare the key)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // If the field is on the interface but NOT the schema, z.object strips
      // it → this is `undefined` and the assertion fails. This is the guard.
      expect(result.data.member_number).toBe(42);
    }
  });

  it('defaults a MISSING member_number key to null (historical snapshot)', () => {
    // A pre-feature JSONB snapshot has no key at all → .optional().default(null)
    // resolves to null (NOT undefined), satisfying exactOptionalPropertyTypes.
    const result = memberIdentitySnapshotSchema.safeParse(validSnapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.member_number).toBeNull();
    }
  });

  it('accepts an explicit null member_number (event / non-member buyer)', () => {
    const result = memberIdentitySnapshotSchema.safeParse({
      ...validSnapshot,
      member_number: null,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.member_number).toBeNull();
  });

  it('rejects a zero / negative member_number (positive constraint)', () => {
    expect(memberIdentitySnapshotSchema.safeParse({ ...validSnapshot, member_number: 0 }).success).toBe(false);
    expect(memberIdentitySnapshotSchema.safeParse({ ...validSnapshot, member_number: -1 }).success).toBe(false);
  });

  it('rejects a fractional member_number (integer constraint)', () => {
    expect(memberIdentitySnapshotSchema.safeParse({ ...validSnapshot, member_number: 1.5 }).success).toBe(false);
  });
});

describe('makeMemberIdentitySnapshot member_number (055-member-number)', () => {
  it('keeps member_number 42 through make() (strip-regression at creation)', () => {
    const snap = makeMemberIdentitySnapshot({ ...validSnapshot, member_number: 42 });
    expect(snap.member_number).toBe(42);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it('defaults member_number to null when the caller omits it', () => {
    const snap = makeMemberIdentitySnapshot(validSnapshot);
    expect(snap.member_number).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm vitest run tests/unit/invoicing/domain/member-identity-snapshot.test.ts`
  Expected failure: the strip-regression case reports `expected undefined to be 42` (schema does not declare the key yet); the default-to-null cases report `expected undefined to be null`; and TS may also error that `validSnapshot` (typed `MemberIdentitySnapshot`) lacks `member_number` once the interface is touched — confirm the suite is RED before implementing.

- [ ] **Step 3: Implement** — add the field to BOTH the interface and the schema in the same edit. The `.optional().default(null)` is essential (not just `.nullable()`): a historical snapshot with **no key** must parse to `null`, not `undefined`, to satisfy `exactOptionalPropertyTypes` and avoid a `number|null|undefined` gap at the template.

Interface (lines 20-26) becomes:

```ts
export interface MemberIdentitySnapshot {
  readonly legal_name: string;
  readonly tax_id: string | null;
  readonly address: string;
  readonly primary_contact_name: string;
  readonly primary_contact_email: string;
  /**
   * 055-member-number — the buyer's human-readable per-tenant member number
   * (bare integer; the tenant prefix is a display concern resolved elsewhere).
   * `null` for: event/non-member buyers (no F3 member) AND historical
   * snapshots written before this feature (the JSONB key is absent → zod's
   * `.optional().default(null)` resolves it to null at read time). The PDF
   * template guards with `!== null`, so historical invoices skip the line
   * (SC-003 byte-identical re-render preserved).
   */
  readonly member_number: number | null;
}
```

Schema — insert into the `z.object({ … })` (after `primary_contact_email`, before the closing `})` at line 59):

```ts
  // 055-member-number — additive, optional, defaults to null. `.optional()
  // .default(null)` (NOT a bare `.nullable()`) means a MISSING key parses to
  // null (historical snapshot) rather than undefined; positive int mirrors the
  // DB CHECK (member_number > 0). Declaring it here is mandatory: z.object
  // STRIPS undeclared keys, so an interface-only add silently drops the value
  // at both write and read with no type error.
  member_number: z.number().int().positive().nullable().optional().default(null),
```

- [ ] **Step 4: Run test, verify pass** — `pnpm vitest run tests/unit/invoicing/domain/member-identity-snapshot.test.ts`
  Expected: all cases PASS (existing ~25 + the 7 new). The pre-existing "parses through unknown additional keys" case still passes (schema stays non-`.strict()`).

- [ ] **Step 5: Commit** —
```
git add src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts tests/unit/invoicing/domain/member-identity-snapshot.test.ts
git commit -m "feat(invoicing): snapshot carries optional member_number (interface + zod, default null)"
```

---

### Task PDF-2: Membership write-path — `getForIssue` SELECTs `m.member_number` into the snapshot

**Files:**
- Modify: `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts` (SELECT lists lines 45-69; row type lines 70-85; `makeMemberIdentitySnapshot(...)` call lines 114-129)
- Test: `tests/integration/invoicing/member-identity-member-number.test.ts` (new — live Neon; mirrors `member-identity-address.test.ts`)

> Depends on the members-module migration `0209` having added `members.member_number` (run by the foundation group). This integration test must run AFTER `0209` applies. Per the project gotcha (apply migration + integration before commit), run `pnpm drizzle-kit migrate` first.

- [ ] **Step 1: Write the failing test** — new file. Seed a member with a known `member_number`, then assert `getForIssue` surfaces it on the snapshot. Mirror the existing `member-identity-address.test.ts` seeding helpers (`createTestTenant`, `runInTenant`, raw-SQL member insert). Skeleton (fill seed columns to match the live `members` NOT-NULL set used by the sibling test):

```ts
/**
 * 055-member-number — member-identity adapter surfaces member_number on the
 * snapshot for a membership invoice (write path). Live Neon, RLS-scoped tx.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('055 — memberIdentityAdapter.getForIssue snapshots member_number', () => {
  let tenant: TestTenant;
  const memberId = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant();
    await runInTenant({ tenantId: tenant.tenantId }, async (tx) => {
      // Minimal member row — copy the exact NOT-NULL column set from
      // member-identity-address.test.ts's seed (company_name, country,
      // status, registration_date, registration_fee_paid, plan refs, …)
      // and add member_number = 42 + a primary contact.
      await tx.execute(sql`/* INSERT members (…, member_number) VALUES (…, 42) */`);
      await tx.execute(sql`/* INSERT one is_primary contact for the member */`);
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('puts the member_number on the snapshot', async () => {
    const view = await runInTenant({ tenantId: tenant.tenantId }, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.tenantId, memberId),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.member_number).toBe(42);
  });
});
```

> Ground the seed against the real sibling: open `tests/integration/invoicing/member-identity-address.test.ts` and reuse its exact INSERT column list verbatim, appending `member_number`. Do not invent columns.

- [ ] **Step 2: Run test, verify it fails** — `pnpm test:integration -- tests/integration/invoicing/member-identity-member-number.test.ts`
  Expected failure: `expected null to be 42` — `getForIssue` does not SELECT `m.member_number` yet, so the snapshot field defaults to `null`.

- [ ] **Step 3: Implement** — three edits in `member-identity-adapter.ts`:

(a) Add `m.member_number` to BOTH SELECT branches (the `FOR UPDATE` arm line 48 and the plain arm line 60) — append after `m.registration_fee_paid,`:
```ts
                   m.registration_fee_paid, m.member_number,
```

(b) Add to the cast row type (after `registration_fee_paid: boolean;` line 83):
```ts
      member_number: number | null;
```

(c) Pass it into `makeMemberIdentitySnapshot` (inside the object literal lines 114-129, after `primary_contact_email: …`):
```ts
        // 055-member-number — surface the buyer's member number on the snapshot
        // pinned at issue (FR-038). A live member always has a non-null number
        // post-backfill; the `?? null` is defensive only (pre-backfill window).
        member_number: m.member_number ?? null,
```

- [ ] **Step 4: Run test, verify pass** — `pnpm test:integration -- tests/integration/invoicing/member-identity-member-number.test.ts`
  Expected: PASS (`member_number` === 42). Also run `pnpm typecheck` (last gate before commit) — the row-type addition must line up with the new snapshot field.

- [ ] **Step 5: Commit** —
```
git add src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts tests/integration/invoicing/member-identity-member-number.test.ts
git commit -m "feat(invoicing): getForIssue SELECTs member_number into the buyer snapshot"
```

---

### Task PDF-3: Confirm `create-event-invoice-draft` needs NO new parameter (lock it with a test)

**Files:**
- Modify: none (assertion task — the code path is already correct)
- Test: `tests/unit/invoicing/application/create-event-invoice-draft-member-number.test.ts` (new — pure unit, mocked deps; mirrors the existing event-draft unit test style)

Rationale: the event/non-member buyer snapshot is built from `input.buyer.*` (lines 268-274) which has **no** `member_number` field; `makeMemberIdentitySnapshot` then applies `.default(null)`. So the persisted snapshot's `member_number` is `null` with zero code change. This task pins that — a future "helpfully add member_number to the buyer object" change would break the event/§105-receipt path, and this test catches it.

- [ ] **Step 1: Write the failing test** — assert the snapshot handed to `insertDraft` has `member_number === null` for a non-member buyer. Mock `memberIdentity`, `eventRegistrationLookup` (returns `matchedMemberId: null`), `eventDetailsLookup`, `audit`, and capture the `insertDraft` arg:

```ts
/**
 * 055-member-number — an EVENT (non-member) draft snapshots member_number=null.
 * The buyer object has no member_number field; makeMemberIdentitySnapshot's
 * .default(null) supplies it. Pins that create-event-invoice-draft needs NO new
 * param (a future buyer.member_number add would wrongly leak a number onto the
 * §105 receipt path).
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-event-invoice-draft';

describe('055 — event draft snapshot has member_number=null', () => {
  it('persists a null member_number for a non-member buyer', async () => {
    const insertDraft = vi.fn(async (_tx, args: { memberIdentitySnapshot: unknown }) => {
      return { invoiceId: 'inv', status: 'draft' } as never;
    });
    const deps = {
      invoiceRepo: {
        withTx: (fn: (tx: unknown) => unknown) => fn({}),
        insertDraft,
      },
      eventRegistrationLookup: {
        findById: vi.fn(async () => ({
          ok: true,
          value: {
            matchedMemberId: null,
            pseudonymised: false,
            ticketPriceThb: 1000,
            eventId: 'evt-1',
          },
        })),
      },
      eventDetailsLookup: {
        findById: vi.fn(async () => ({
          ok: true,
          value: { name: 'Gala', startDateIso: '2026-09-10T03:00:00.000Z' },
        })),
      },
      memberIdentity: { getForIssue: vi.fn() },
      audit: { emit: vi.fn() },
      newUuid: () => '00000000-0000-0000-0000-0000000000a1',
    } as never;

    await createEventInvoiceDraft(deps, {
      tenantId: 't1',
      actorUserId: 'u1',
      eventRegistrationId: '00000000-0000-0000-0000-0000000000e9',
      buyer: {
        legal_name: 'Walk-in Guest',
        tax_id: null,
        address: '50 Sukhumvit, Bangkok',
        primary_contact_name: 'Jane',
        primary_contact_email: '',
      },
    } as never);

    expect(insertDraft).toHaveBeenCalledTimes(1);
    const snap = (insertDraft.mock.calls[0]![1] as { memberIdentitySnapshot: { member_number: number | null } }).memberIdentitySnapshot;
    expect(snap.member_number).toBeNull();
  });
});
```

> Ground mock shapes against the real `EventRegistrationLookupPort` / `EventDetailsLookupPort` return types before finalising — adjust field names if the ports differ from the inline shapes above.

- [ ] **Step 2: Run test, verify it fails** — `pnpm vitest run tests/unit/invoicing/application/create-event-invoice-draft-member-number.test.ts`
  Expected failure (RED): this test fails to compile/run **only until Task PDF-1 lands** (the snapshot has no `member_number` field before then) — order PDF-3 after PDF-1. With PDF-1 merged, the test should pass immediately (confirming "no change needed"). If it goes straight to GREEN with PDF-1 present, that is the intended confirmation — note this is a regression-lock, not a red→green cycle, so capture the would-fail state by temporarily asserting `toBe(42)` and confirming `expected null to be 42`, then revert to `toBeNull()`.

- [ ] **Step 3: Implement** — none. The use case is unchanged. (DRY/YAGNI: do not add a `member_number` field to `createEventInvoiceDraftSchema.buyer` — the §105 receipt path must NOT carry a number.)

- [ ] **Step 4: Run test, verify pass** — `pnpm vitest run tests/unit/invoicing/application/create-event-invoice-draft-member-number.test.ts`
  Expected: PASS (`member_number` is `null`).

- [ ] **Step 5: Commit** —
```
git add tests/unit/invoicing/application/create-event-invoice-draft-member-number.test.ts
git commit -m "test(invoicing): lock event-draft buyer snapshot member_number=null (no param change)"
```

---

### Task PDF-4: Invoice-template buyer block renders the bilingual Member No. line (guarded `!== null`)

**Files:**
- Modify: `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` (buyer block lines 272-288; insert after the `tax_id` conditional lines 275-277, before the address `.map` line 278)
- Test: `tests/integration/invoicing/event-invoice-pdf-golden.test.ts` (extend — add the `member` field to the fixture + a new render-input case) **or** the new golden file in PDF-5. Use PDF-5 as the home for the new golden cases; here, add a minimal template-presence assertion to PDF-5's file.

> This task is implementation-only for the template JSX. The render assertions live in Task PDF-5 (golden). Split this way because the template change is a one-liner block and the three golden cases are the real verification.

- [ ] **Step 1: Write the failing test** — covered by Task PDF-5 case (a) (membership invoice with `member_number: 42` → text contains `Member No.` + `42`). Author PDF-5 case (a) first so this task has a red target. (If executing strictly in order, write PDF-5's three `it` blocks now, run, confirm case (a) RED.)

- [ ] **Step 2: Run test, verify it fails** — `pnpm test:integration -- tests/integration/invoicing/member-number-pdf-golden.test.ts`
  Expected failure: case (a) reports the rendered text does NOT contain `Member No.` (template emits no such line yet).

- [ ] **Step 3: Implement** — insert the guarded bilingual line in the buyer `<View>` block. Place it **under the buyer tax_id conditional** (after line 277) and **above** the address `.map` (line 278), matching the seller-block `shapeThai('ไทย') / English:` convention (line 244) and the buyer-contact convention (line 285). Use explicit `!== null` (NOT truthy) — defensive against a future type-widen, and `0` is impossible (DB CHECK `> 0`) but `!== null` is the documented guard:

```tsx
          {input.member.tax_id && (
            <Text style={styles.label}>Tax ID: {input.member.tax_id}</Text>
          )}
          {input.member.member_number !== null && (
            <Text style={styles.label}>
              {shapeThai('หมายเลขสมาชิก')} / Member No.: {input.member.member_number}
            </Text>
          )}
          {input.member.address.split('\n').map((line, i) => (
```

> Note: the seller `Tax ID` line at 244 carries a Thai prefix before `Tax ID:`, while the buyer line at 276 is bare `Tax ID:` — the new Member No. line follows the **prefixed** bilingual form (`หมายเลขสมาชิก / Member No.:`) so it reads correctly in TH and EN, consistent with the §10 i18n decision in the design doc.

- [ ] **Step 4: Run test, verify pass** — `pnpm test:integration -- tests/integration/invoicing/member-number-pdf-golden.test.ts`
  Expected: case (a) PASS (text contains `Member No.` and `42`).

- [ ] **Step 5: Commit** —
```
git add src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx
git commit -m "feat(invoicing): render bilingual Member No. line in invoice buyer block"
```

---

### Task PDF-5: PDF golden — membership shows, event omits, historical snapshot omits (SC-003)

**Files:**
- Test: `tests/integration/invoicing/member-number-pdf-golden.test.ts` (new — render-input → real bytes → pdf-parse text; mirrors `event-invoice-pdf-golden.test.ts` exactly: no DB, `reactPdfRenderAdapter.render`, `PDFParse`)

This is the SC-003 determinism pin: a membership invoice issued post-feature shows the number; an event invoice (member_number `null`) omits it; a historical membership snapshot (no key → parses to `null`) omits it. Models on `event-invoice-pdf-golden.test.ts` (the correct lightweight golden: real bytes, no tenant data).

- [ ] **Step 1: Write the failing test** — new file. The fixture builder mirrors `makeEventRenderInput` but parameterises `member.member_number`. Because the three cases all hinge on the template's `!== null` guard, render real bytes and grep the extracted text:

```ts
/**
 * 055-member-number — invoice PDF golden: the buyer block renders a bilingual
 * "หมายเลขสมาชิก / Member No.: <n>" line ONLY when the snapshot's member_number
 * is non-null.
 *
 *  (a) membership invoice, member_number=42  → line present, shows 42
 *  (b) event invoice,      member_number=null → line ABSENT
 *  (c) historical snapshot (no key → null)    → line ABSENT (SC-003: byte-stable
 *                                               re-render of a pre-feature invoice)
 *
 * Render-input → real bytes → pdf-parse text. No DB. Mirrors
 * event-invoice-pdf-golden.test.ts (the lightweight golden posture).
 */
import { describe, it, expect } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

function makeLine(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000m1'),
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPrice: Money.fromSatangUnsafe(100_000n),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      total: Money.fromSatangUnsafe(100_000n),
      position: 1,
    },
  ];
}

// `member` typed as a plain object with member_number so we can pass null
// AND a key-absent variant (case c) — both must satisfy the snapshot shape
// via the zod default at the write boundary; here we hand the template the
// already-parsed value, so null is the runtime form for both.
function makeRenderInput(memberNumber: number | null): PdfRenderInput {
  const docR = DocumentNumber.of('INV', 2026, 1);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  const member: MemberIdentitySnapshot = {
    legal_name: 'SCCM Member Co., Ltd.',
    tax_id: '0105562000123',
    address: '99/1 Rama IV, Bangkok 10500',
    primary_contact_name: 'Jane Doe',
    primary_contact_email: 'jane@member.example',
    member_number: memberNumber,
  };
  return {
    kind: 'invoice',
    templateVersion: 1,
    documentNumber: docR.value,
    issueDate: '2026-01-15',
    dueDate: '2026-02-15',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member,
    lines: makeLine(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

describe('055 — member-number invoice PDF golden (buyer block, SC-003)', () => {
  it('(a) membership invoice with member_number=42 → buyer block shows Member No.: 42', async () => {
    const { bytes } = await reactPdfRenderAdapter.render(makeRenderInput(42));
    const text = await extractPdfText(bytes);
    expect(text).toMatch(/Member No\.?:?\s*42/);
    // Thai label survives shapeThai (sara-am-free → matches verbatim).
    expect(text).toContain('หมายเลขสมาชิก');
  }, 60_000);

  it('(b) event invoice with member_number=null → NO Member No. line', async () => {
    const { bytes } = await reactPdfRenderAdapter.render(makeRenderInput(null));
    const text = await extractPdfText(bytes);
    expect(text).not.toMatch(/Member No\./i);
    expect(text).not.toContain('หมายเลขสมาชิก');
  }, 60_000);

  it('(c) historical snapshot (member_number=null after default) → NO Member No. line (byte-stable re-render)', async () => {
    // A pre-feature invoice's JSONB had no member_number key; the zod .default(null)
    // resolves it to null at read, so the template MUST omit the line — preserving
    // the determinism/byte-stability guarantee for already-issued tax documents.
    const { bytes } = await reactPdfRenderAdapter.render(makeRenderInput(null));
    const text = await extractPdfText(bytes);
    expect(text).not.toMatch(/Member No\./i);
  }, 60_000);
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm test:integration -- tests/integration/invoicing/member-number-pdf-golden.test.ts`
  Expected failure **before** Task PDF-4's template edit: case (a) fails (`Member No.: 42` not in the rendered text). Cases (b)/(c) pass vacuously even pre-edit (no line is emitted yet) — case (a) is the red target driving PDF-4.

- [ ] **Step 3: Implement** — none here (the template change is Task PDF-4). This task's "implement" is the PDF-4 JSX; if executing PDF-4 and PDF-5 as a pair, PDF-4 Step 3 is the implementation and this file is the test that turns it green.

- [ ] **Step 4: Run test, verify pass** — `pnpm test:integration -- tests/integration/invoicing/member-number-pdf-golden.test.ts`
  Expected: all three cases PASS. Then run the existing PDF goldens to confirm no regression: `pnpm test:integration -- tests/integration/invoicing/event-invoice-pdf-golden.test.ts tests/integration/invoicing/credit-note-pdf-golden.test.ts` — both must stay GREEN (event invoices carry `member_number: null` → omit the line; credit-note + void re-render of a pre-feature invoice → `null` → omit, SC-003 preserved).

- [ ] **Step 5: Commit** —
```
git add tests/integration/invoicing/member-number-pdf-golden.test.ts
git commit -m "test(invoicing): PDF golden — Member No. shows for membership, omits for event/historical (SC-003)"
```

---

**Group exit checks (run before declaring PDF group done):**
- `pnpm typecheck` — the new `member_number` field threads cleanly through interface → adapter row type → render port → template (run as the FINAL gate after the last edit per project convention; an earlier typecheck misses later-edit errors).
- `pnpm vitest run tests/unit/invoicing/domain/member-identity-snapshot.test.ts` — snapshot unit GREEN.
- `pnpm test:integration -- tests/integration/invoicing/member-identity-member-number.test.ts tests/integration/invoicing/member-number-pdf-golden.test.ts tests/integration/invoicing/event-invoice-pdf-golden.test.ts tests/integration/invoicing/credit-note-pdf-golden.test.ts` — write-path + all goldens GREEN, existing goldens un-regressed.

**Out of scope for this group (owned elsewhere):** the `members.member_number` column + migration `0209`/`0210` (foundation group); `formatMemberNumber`/`MemberNumber` brand (members domain group); admin/portal serializers + `REDACT_PATHS` (presentation group). This group only consumes the snapshot's bare `member_number: number | null` integer.

---

## TEST Group — Cross-tenant Isolation + DB Backstop + Audit-count Guard + E2E

---

### Task TEST-1: Tenant-isolation integration test — `tenant_member_sequences` and `tenant_member_settings` (Principle I Review-Gate blocker)

**Files:**
- Create: `tests/integration/members/member-number-tenant-isolation.test.ts`
- Modify (step 3 prerequisite only — the test itself drives the schema): `tests/integration/helpers/test-tenant.ts` (add cleanup for `tenant_member_sequences` and `tenant_member_settings` rows after new tables exist)

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * T-MN-01 — Member-number tenant isolation (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3.
 *
 * Asserts:
 *   (a) tenant A cannot SELECT / UPDATE / INSERT tenant B's
 *       tenant_member_sequences rows via runInTenant.
 *   (b) tenant A cannot SELECT / UPDATE / INSERT tenant B's
 *       tenant_member_settings rows via runInTenant.
 *   (c) directory search exposes member_number only for the session
 *       tenant (RLS hides B members from A context entirely).
 *   (d) formatted string `formatMemberNumber(prefix, n)` equals the
 *       stored integer for the same member row.
 *   (e) INSERT with mismatched tenant_id on tenant_member_sequences
 *       is rejected by RLS WITH CHECK.
 *   (f) unset app.current_tenant → 0 rows on tenant_member_sequences.
 *
 * Uses createTwoTestTenants() (mirrors tenant-isolation.test.ts).
 * The two new tables must exist before this test can run — migration
 * 0209 is the prerequisite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  tenantMemberSequences,
  tenantMemberSettings,
} from '@/modules/members/infrastructure/db/schema-member-sequences';
import { formatMemberNumber, asMemberNumber } from '@/modules/members/domain/value-objects/member-number';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

describe('Member-number tenant isolation — T-MN-01 (REVIEW-GATE BLOCKER)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aMemberId: string;
  let bMemberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed prerequisite rows for both tenants.
    for (const { tenant, prefix } of [
      { tenant: tenantA, prefix: 'mniso-alpha' },
      { tenant: tenantB, prefix: 'mniso-beta' },
    ]) {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: tenant.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 100000n,
          legalNameTh: 'Test TH',
          legalNameEn: 'Test EN',
          taxId: '0000000000000',
          registeredAddressTh: 'Test Address TH',
          registeredAddressEn: 'Test Address EN',
          invoiceNumberPrefix: 'INV',
          creditNoteNumberPrefix: 'CN',
        });
        await tx.insert(membershipPlans).values({
          tenantId: tenant.ctx.slug,
          planId: `${prefix}-plan`,
          planYear: 2026,
          planName: { en: `${prefix} Plan` },
          description: { en: 'Test' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_000_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
      });
    }

    // Seed one member per tenant with a known member_number.
    aMemberId = randomUUID();
    bMemberId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: aMemberId,
        companyName: 'Alpha Co',
        country: 'TH',
        planId: 'mniso-alpha-plan',
        planYear: 2026,
        memberNumber: 1,
      });
      // Seed the sequence counter for tenant A.
      await tx.insert(tenantMemberSequences).values({
        tenantId: tenantA.ctx.slug,
        lastNumber: 1,
      });
      await tx.insert(tenantMemberSettings).values({
        tenantId: tenantA.ctx.slug,
        memberNumberPrefix: 'ALPHA',
      });
    });

    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: bMemberId,
        companyName: 'Beta Co',
        country: 'TH',
        planId: 'mniso-beta-plan',
        planYear: 2026,
        memberNumber: 1,
      });
      await tx.insert(tenantMemberSequences).values({
        tenantId: tenantB.ctx.slug,
        lastNumber: 1,
      });
      await tx.insert(tenantMemberSettings).values({
        tenantId: tenantB.ctx.slug,
        memberNumberPrefix: 'BETA',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // ── (a) tenant_member_sequences SELECT isolation ─────────────────────────

  it('(a1) A context sees only A tenant_member_sequences row', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(tenantMemberSequences),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
  });

  it('(a2) A context: SELECT by B tenant_id on tenant_member_sequences → 0 rows', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  it('(a3) A context: UPDATE on B tenant_member_sequences → 0 rows affected', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(tenantMemberSequences)
        .set({ lastNumber: 9999 })
        .where(eq(tenantMemberSequences.tenantId, tenantB.ctx.slug))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    // Verify B's counter was NOT modified.
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, tenantB.ctx.slug)),
    );
    expect(check[0]!.lastNumber).toBe(1);
  });

  // ── (b) tenant_member_settings SELECT isolation ──────────────────────────

  it('(b1) A context sees only A tenant_member_settings row', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(tenantMemberSettings),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
  });

  it('(b2) A context: SELECT by B tenant_id on tenant_member_settings → 0 rows', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(tenantMemberSettings)
        .where(eq(tenantMemberSettings.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  // ── (c) directory: member_number visible only within own tenant ──────────

  it('(c) A directory SELECT returns A member_number, hides B member entirely', async () => {
    const aRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ memberId: members.memberId, memberNumber: members.memberNumber })
        .from(members),
    );
    const bRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.memberId, bMemberId)),
    );

    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.memberId).toBe(aMemberId);
    expect(aRows[0]!.memberNumber).toBe(1);
    expect(bRows).toHaveLength(0); // B's member is hidden by RLS
  });

  // ── (d) formatted string equals stored integer ───────────────────────────

  it('(d) formatMemberNumber(prefix, storedInt) round-trips via stored member_number', async () => {
    const [row] = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ memberNumber: members.memberNumber })
        .from(members)
        .where(eq(members.memberId, aMemberId)),
    );
    expect(row).toBeDefined();
    const storedInt = row!.memberNumber!;
    const formatted = formatMemberNumber('ALPHA', asMemberNumber(storedInt));
    expect(formatted).toBe('ALPHA-0001');
    // The integer inside the formatted string equals the stored value.
    const parsed = parseInt(formatted.split('-')[1]!, 10);
    expect(parsed).toBe(storedInt);
  });

  // ── (e) INSERT with mismatched tenant_id rejected by RLS WITH CHECK ──────

  it('(e) A context: INSERT tenant_member_sequences with tenant_id=B rejected by RLS WITH CHECK', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(tenantMemberSequences).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED
          lastNumber: 0,
        }),
      ),
    ).rejects.toThrow();
  });

  it('(e2) A context: INSERT tenant_member_settings with tenant_id=B rejected by RLS WITH CHECK', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(tenantMemberSettings).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED
          memberNumberPrefix: 'FORGED',
        }),
      ),
    ).rejects.toThrow();
  });

  // ── (f) unset app.current_tenant → zero rows ────────────────────────────

  it('(f) unset app.current_tenant returns 0 rows on tenant_member_sequences', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      return tx.select().from(tenantMemberSequences);
    });
    expect(rows).toHaveLength(0);
  });

  it('(f2) unset app.current_tenant returns 0 rows on tenant_member_settings', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      return tx.select().from(tenantMemberSettings);
    });
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm vitest run tests/integration/members/member-number-tenant-isolation.test.ts
```

Expected failure: `Cannot find module '@/modules/members/infrastructure/db/schema-member-sequences'` and `Cannot find module '@/modules/members/domain/value-objects/member-number'` (both files do not exist yet — RED phase correct).

- [ ] **Step 3: Implement (schema + domain — minimum to green this test)**

The full implementation lives in the INFRA and DOMAIN groups. This task only drives the test to GREEN. Once `schema-member-sequences.ts`, `member-number.ts`, and migration 0209 are applied (by other groups), this test passes with no further edits here.

Additionally, extend `tests/integration/helpers/test-tenant.ts` cleanup to include the two new tables. Insert **before** the `await db.delete(members)...` line (FK order: sequences/settings have no FK to members, but we clean them before members to be safe):

```typescript
// F-MN cleanup — tenant_member_sequences + tenant_member_settings
// have no outbound FKs; clean before members for logical ordering.
// Import at top of file (add to existing import block):
//   import { tenantMemberSequences, tenantMemberSettings }
//     from '@/modules/members/infrastructure/db/schema-member-sequences';
await db
  .delete(tenantMemberSequences)
  .where(eq(tenantMemberSequences.tenantId, slug));
await db
  .delete(tenantMemberSettings)
  .where(eq(tenantMemberSettings.tenantId, slug));
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm vitest run tests/integration/members/member-number-tenant-isolation.test.ts
```

Expected: all 10 `it` blocks pass (green).

- [ ] **Step 5: Commit**

```
git add tests/integration/members/member-number-tenant-isolation.test.ts tests/integration/helpers/test-tenant.ts
git commit -m "test(members): RED→green member-number tenant isolation (Principle I Review-Gate blocker T-MN-01)"
```

---

### Task TEST-2: DB-backstop integration tests — UNIQUE violation + CHECK violation on `members.member_number`

**Files:**
- Create: `tests/integration/members/member-number-db-backstop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * T-MN-02 — DB-layer backstops for member_number (live Neon).
 *
 * Proves the constraints in migration 0209 work independently of
 * the allocator:
 *   (1) INSERT duplicate (tenant_id, member_number) → UNIQUE violation
 *       (UNIQUE INDEX members_tenant_member_number_uniq).
 *   (2) INSERT member_number = 0 → CHECK violation
 *       (CHECK members_member_number_positive: member_number > 0).
 *   (3) INSERT member_number = -1 → CHECK violation (same constraint).
 *
 * These tests DO NOT go through the application allocator; they hit
 * the DB layer directly via Drizzle inside runInTenant to confirm
 * the DB enforces what the allocator relies on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

const PLAN_ID = 'mn-backstop-plan';

describe('member_number DB backstops — T-MN-02 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: 2026,
        planName: { en: 'Backstop Plan' },
        description: { en: 'Test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('(1) INSERT duplicate (tenant_id, member_number=42) → UNIQUE violation', async () => {
    const firstId = randomUUID();
    // First insert succeeds.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: firstId,
        companyName: 'Unique Test Co A',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        memberNumber: 42,
      }),
    );

    // Second insert with same (tenant_id, member_number=42) must fail.
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(), // different PK — duplicate member_number is what fails
          companyName: 'Unique Test Co B',
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          memberNumber: 42,
        }),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('(2) INSERT member_number = 0 → CHECK violation (member_number > 0)', async () => {
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: 'Zero Number Co',
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          memberNumber: 0,
        }),
      ),
    ).rejects.toThrow(/check|constraint|violat/i);
  });

  it('(3) INSERT member_number = -1 → CHECK violation (member_number > 0)', async () => {
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: 'Negative Number Co',
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          memberNumber: -1,
        }),
      ),
    ).rejects.toThrow(/check|constraint|violat/i);
  });

  it('(4) same member_number=99 in two DIFFERENT tenants is allowed (constraint is per-tenant)', async () => {
    // Control: prove the UNIQUE is scoped to tenant_id, not global.
    const otherTenant = await createTestTenant('test-chamber');
    try {
      await runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: 'Tenant A Member 99',
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          memberNumber: 99,
        }),
      );

      // Must also seed prerequisite plan + invoice settings for otherTenant.
      await runInTenant(otherTenant.ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: otherTenant.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 100000n,
          legalNameTh: 'Test TH',
          legalNameEn: 'Test EN',
          taxId: '0000000000000',
          registeredAddressTh: 'Addr TH',
          registeredAddressEn: 'Addr EN',
          invoiceNumberPrefix: 'INV',
          creditNoteNumberPrefix: 'CN',
        });
        await tx.insert(membershipPlans).values({
          tenantId: otherTenant.ctx.slug,
          planId: PLAN_ID,
          planYear: 2026,
          planName: { en: 'Other Plan' },
          description: { en: 'Test' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_000_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
      });
      // Same member_number=99 in a different tenant — must NOT throw.
      await expect(
        runInTenant(otherTenant.ctx, (tx) =>
          tx.insert(members).values({
            tenantId: otherTenant.ctx.slug,
            memberId: randomUUID(),
            companyName: 'Tenant B Member 99',
            country: 'TH',
            planId: PLAN_ID,
            planYear: 2026,
            memberNumber: 99,
          }),
        ),
      ).resolves.toBeDefined();
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm vitest run tests/integration/members/member-number-db-backstop.test.ts
```

Expected failure: `Cannot find column 'memberNumber' on table 'members'` (column does not exist yet — migration 0209 not applied). All 4 tests fail at the `INSERT` step.

- [ ] **Step 3: Implement**

The implementation prerequisite for this test is migration 0209 (adds `members.member_number`, unique index, and CHECK constraint) applied to the live Neon database. The Drizzle schema (`schema-members.ts`) must declare `memberNumber: integer('member_number')` (nullable first, `.notNull()` after backfill). No code changes in this test file — the test drives the migration author.

After migration 0209 is applied:
```bash
pnpm drizzle-kit migrate
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm vitest run tests/integration/members/member-number-db-backstop.test.ts
```

Expected: all 4 `it` blocks pass (green).

- [ ] **Step 5: Commit**

```
git add tests/integration/members/member-number-db-backstop.test.ts
git commit -m "test(members): RED→green DB-backstop constraints for member_number (unique + check) T-MN-02"
```

---

### Task TEST-3: F3 audit-count guard — add `member_number_assigned` to `check-cross-module-audit-counts.ts`

**Files:**
- Modify: `scripts/check-cross-module-audit-counts.ts` (add F3 check entry, lines 40–57)
- Create: `tests/unit/members/application/audit-port-f3-count.test.ts` (the companion unit test that the script validates against)

**Context:** The `check-cross-module-audit-counts.ts` script currently checks F2 (`F2_AUDIT_EVENT_TYPES` in `src/modules/plans/domain/audit-event.ts`) and F8 (`F8_AUDIT_EVENT_TYPES` in `src/modules/renewals/...`). The F3 audit-port exports a TypeScript union type (`F3AuditEventType`) but no runtime array constant. The script requires an exportable `F3_AUDIT_EVENT_TYPES` array const. The design spec says to add `member_number_assigned` to the F3 union; the count guard must reflect the new total.

- [ ] **Step 1: Write the failing test**

First, count the current F3 union members in `src/modules/members/application/ports/audit-port.ts`. The current union has these members (lines 24–58): `member_created`, `member_updated`, `member_plan_changed`, `member_plan_manually_changed`, `member_primary_contact_changed`, `member_status_changed`, `member_archived`, `member_undeleted`, `contact_created`, `contact_updated`, `contact_removed`, `member_self_updated`, `member_self_update_forbidden`, `member_cross_tenant_probe`, `plan_bundle_changed`, `member_contact_email_changed`, `user_sessions_revoked`, `email_verification_sent`, `email_verification_consumed`, `email_change_notification_sent_to_old_address`, `member_email_change_reverted`, `email_verification_resent`, `email_dispatch_failed`, `invitation_bounced`, `bulk_action_rate_limit_exceeded`, `member_portal_invite_queued`, `contact_linked_to_user`, `member_preferred_locale_changed` = **28 types**. After adding `member_number_assigned` = **29 types**.

```typescript
/**
 * T-MN-03 — F3 audit-event catalogue count guard.
 *
 * Mirrors the F8 pattern in tests/unit/renewals/application/ports.test.ts.
 * Pins `F3_AUDIT_EVENT_TYPES.length` so that adding an event without
 * updating this test AND check-cross-module-audit-counts.ts is a
 * compile+CI failure — not a silent drift.
 *
 * The check-cross-module-audit-counts.ts script reads this file's
 * `.toBe(N)` literal at pre-push time (see CHECKS in that script).
 *
 * Current count: 29 (28 pre-existing + 1 new: member_number_assigned).
 */
import { describe, expect, it } from 'vitest';
import {
  F3_AUDIT_EVENT_TYPES,
  isF3AuditEventType,
} from '@/modules/members/application/ports/audit-port';

describe('F3_AUDIT_EVENT_TYPES catalogue (T-MN-03)', () => {
  it('contains 29 unique event types (+1 member_number_assigned)', () => {
    expect(F3_AUDIT_EVENT_TYPES.length).toBe(29);
    const set = new Set(F3_AUDIT_EVENT_TYPES);
    expect(set.size).toBe(F3_AUDIT_EVENT_TYPES.length);
  });

  it('includes member_number_assigned', () => {
    expect(
      (F3_AUDIT_EVENT_TYPES as readonly string[]).includes('member_number_assigned'),
    ).toBe(true);
  });

  it('isF3AuditEventType — narrows known canonical strings', () => {
    expect(isF3AuditEventType('member_created')).toBe(true);
    expect(isF3AuditEventType('member_number_assigned')).toBe(true);
    expect(isF3AuditEventType('member_cross_tenant_probe')).toBe(true);
  });

  it('isF3AuditEventType — false for unknown / non-string', () => {
    expect(isF3AuditEventType('not_an_f3_event')).toBe(false);
    expect(isF3AuditEventType(42)).toBe(false);
    expect(isF3AuditEventType(undefined)).toBe(false);
    expect(isF3AuditEventType(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm vitest run tests/unit/members/application/audit-port-f3-count.test.ts
```

Expected failure: `SyntaxError: The requested module '@/modules/members/application/ports/audit-port' does not provide an export named 'F3_AUDIT_EVENT_TYPES'` (the array const and type-guard do not exist yet).

- [ ] **Step 3: Implement — add F3_AUDIT_EVENT_TYPES const + isF3AuditEventType + extend check script**

Add at the bottom of `src/modules/members/application/ports/audit-port.ts` (after the `AuditPort` interface, appending new exports without touching existing ones):

```typescript
/**
 * Runtime array of all F3 audit event type strings.
 * Used by `check-cross-module-audit-counts.ts` (CI pre-push guard)
 * and by `isF3AuditEventType` narrowing utility.
 * Add `member_number_assigned` here AND to the `F3AuditEventType` union above.
 */
export const F3_AUDIT_EVENT_TYPES = [
  'member_created',
  'member_updated',
  'member_plan_changed',
  'member_plan_manually_changed',
  'member_primary_contact_changed',
  'member_status_changed',
  'member_archived',
  'member_undeleted',
  'contact_created',
  'contact_updated',
  'contact_removed',
  'member_self_updated',
  'member_self_update_forbidden',
  'member_cross_tenant_probe',
  'plan_bundle_changed',
  'member_contact_email_changed',
  'user_sessions_revoked',
  'email_verification_sent',
  'email_verification_consumed',
  'email_change_notification_sent_to_old_address',
  'member_email_change_reverted',
  'email_verification_resent',
  'email_dispatch_failed',
  'invitation_bounced',
  'bulk_action_rate_limit_exceeded',
  'member_portal_invite_queued',
  'contact_linked_to_user',
  'member_preferred_locale_changed',
  'member_number_assigned',
] as const satisfies readonly F3AuditEventType[];

export function isF3AuditEventType(value: unknown): value is F3AuditEventType {
  return (
    typeof value === 'string' &&
    (F3_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}
```

Also add `'member_number_assigned'` to the `F3AuditEventType` union in that same file (line ~58, after `member_preferred_locale_changed`):

```typescript
  | 'member_preferred_locale_changed'
  | 'member_number_assigned';
```

Then add the F3 entry to `scripts/check-cross-module-audit-counts.ts` CHECKS array (insert after the F8 entry at line ~57):

```typescript
  {
    module: 'F3 members',
    sourceFile: 'src/modules/members/application/ports/audit-port.ts',
    sourceConstName: 'F3_AUDIT_EVENT_TYPES',
    testFile: 'tests/unit/members/application/audit-port-f3-count.test.ts',
    // Match `expect(F3_AUDIT_EVENT_TYPES.length).toBe(N)` — extract N.
    testAssertionPattern: /F3_AUDIT_EVENT_TYPES\.length\)\.toBe\((\d+)\)/,
  },
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm vitest run tests/unit/members/application/audit-port-f3-count.test.ts
```

Then verify the check script agrees:

```
pnpm tsx scripts/check-cross-module-audit-counts.ts
```

Expected: all 3 modules (F2, F8, F3) print `✓ N events (source ↔ test in sync)`.

- [ ] **Step 5: Commit**

```
git add src/modules/members/application/ports/audit-port.ts scripts/check-cross-module-audit-counts.ts tests/unit/members/application/audit-port-f3-count.test.ts
git commit -m "test(members): add F3 audit-count guard for member_number_assigned (T-MN-03)"
```

---

### Task TEST-4: E2E — admin list member-number column CLS-0 + th-TH no-wrap + portal badge

**Files:**
- Create: `tests/e2e/member-number.spec.ts`

**Context:** The current `members-table-skeleton.tsx` has `cols = withSelection ? 10 : 9` (lines 34, 38–40). After adding the member-number column, those become 10 (no-selection) and 11 (with-selection). The skeleton Vitest unit test lives in `tests/unit/members/presentation/members-table-selection.test.tsx` — but the skeleton itself does not have a dedicated unit test for column count. Task TEST-5 covers that skeleton unit test. This task covers the E2E CLS, th-TH, and portal badge checks.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * T-MN-04 — E2E: member-number column CLS, th-TH no-wrap, portal badge.
 *
 * @f-mn @layout @i18n
 *
 * (1) Admin list /admin/members:
 *     - "Member No." column header is visible after data loads
 *       (proves the column was added, not just in the skeleton).
 *     - CLS ≤ 0.01 on the members list page after skeleton→data swap
 *       at 1280px viewport (the breakpoint where th-TH wrapping is
 *       most likely to occur — design spec §10).
 *     - th-TH locale: "เลขสมาชิก" column header renders without line-break
 *       (whitespace-nowrap enforced per design spec §10).
 *
 * (2) Admin member detail /admin/members/:id:
 *     - Formatted member number (e.g. "SCCM-0001") is visible above
 *       the UUID section.
 *     - A copy button is present adjacent to the formatted number.
 *
 * (3) Member portal /portal (dashboard):
 *     - Signed-in member sees a badge containing their formatted
 *       member number on the portal dashboard.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD + E2E_MEMBER_EMAIL/PASSWORD.
 * Serial mode: each test signs in fresh.
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('Member-number column + portal badge @f-mn @layout @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signInAdmin(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  async function setLocale(context: BrowserContext, locale: string): Promise<void> {
    await context.addCookies([
      { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
    ]);
  }

  async function firstMemberId(page: Page): Promise<string | null> {
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const href = await page
      .locator('tbody tr:first-child a')
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (!href) return null;
    return href.match(/\/admin\/members\/([0-9a-f-]+)/)?.[1] ?? null;
  }

  // ── (1a) Member No. column header visible ────────────────────────────────

  test('1a. /admin/members — "Member No." column header is visible after data loads', async ({
    page,
  }) => {
    await signInAdmin(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // The column header text is defined by the i18n key admin.members.directory.columns.memberNumber
    // which resolves to "Member No." in EN locale.
    const header = page.getByText('Member No.', { exact: true });
    await expect(header).toBeVisible({ timeout: 5_000 });
  });

  // ── (1b) CLS ≤ 0.01 at 1280px on skeleton→data swap ────────────────────

  test('1b. /admin/members — CLS ≤ 0.01 at 1280px viewport (skeleton→data swap)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAdmin(page);

    // Instrument CLS observer BEFORE navigation.
    await page.goto('/admin/members');
    await page.evaluate(() => {
      (window as unknown as { __cls?: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as Array<{
          value: number;
          hadRecentInput: boolean;
        }>) {
          if (!entry.hadRecentInput) {
            const w = window as unknown as { __cls?: number };
            w.__cls = (w.__cls ?? 0) + entry.value;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    // Wait for real data to replace skeleton.
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
    // Small settle window for any deferred paint.
    await page.waitForTimeout(300);

    const cls = await page.evaluate(
      () => (window as unknown as { __cls?: number }).__cls ?? 0,
    );
    expect(cls, '/admin/members CLS at 1280px').toBeLessThanOrEqual(0.01);
  });

  // ── (1c) th-TH column header no-wrap at 1280px ──────────────────────────

  test('1c. /admin/members th-TH locale — "เลขสมาชิก" header has no line-break at 1280px', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAdmin(page);
    await setLocale(context, 'th');
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Locate the th-TH member-number column header text.
    const thHeader = page.getByText('เลขสมาชิก', { exact: true });
    await expect(thHeader).toBeVisible({ timeout: 5_000 });

    // Assert it occupies a single line (no wrapping): clientHeight ≤ 1 line.
    // Single-line text in a ~14–16px font has a clientHeight ≤ 24px.
    const headerHeight = await thHeader.evaluate(
      (el) => (el as HTMLElement).clientHeight,
    );
    expect(
      headerHeight,
      'th-TH member-number column header must not wrap (whitespace-nowrap)',
    ).toBeLessThanOrEqual(28); // generous for font scaling
  });

  // ── (2a) Admin detail: formatted number above UUID ───────────────────────

  test('2a. /admin/members/:id — formatted member number visible above UUID section', async ({
    page,
  }) => {
    await signInAdmin(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping detail member-number check');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // The formatted number matches the pattern PREFIX-DDDD.
    const formattedNumber = page.getByText(/^[A-Z][A-Z0-9]{0,7}-\d{4,}$/, { exact: false });
    const isVisible = await formattedNumber.first().isVisible().catch(() => false);
    expect(
      isVisible,
      'Formatted member number (e.g. SCCM-0001) must be visible on member detail',
    ).toBe(true);
  });

  // ── (2b) Admin detail: copy button adjacent to formatted number ──────────

  test('2b. /admin/members/:id — copy button adjacent to formatted member number', async ({
    page,
  }) => {
    await signInAdmin(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping copy-button check');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // The copy button is identified by an accessible label copy/clipboard pattern
    // (FR-030 affordance family, mirrors other CopyButton instances in the codebase).
    const copyButton = page
      .getByRole('button', { name: /copy member number|copy.*sccm|copy number/i })
      .first();
    const isVisible = await copyButton.isVisible().catch(() => false);
    expect(
      isVisible,
      'Copy button for formatted member number must be visible on member detail',
    ).toBe(true);
  });

  // ── (2c) Admin detail: no axe violations after member-number addition ────

  test('2c. /admin/members/:id — no axe violations (member-number section)', async ({
    page,
  }) => {
    await signInAdmin(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping axe scan');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // ── (3) Portal dashboard: member-number badge ────────────────────────────

  test('3. /portal — member-number badge visible on portal dashboard', async ({
    page,
  }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL and E2E_MEMBER_PASSWORD',
    );

    await page.goto('/portal/sign-in');
    await fillField(page.getByLabel(/email/i), MEMBER_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => /^\/portal(\/|$)/.test(new URL(u).pathname),
      { timeout: 15_000 },
    );

    await page.waitForLoadState('networkidle');

    // The portal dashboard badge shows the formatted member number.
    // It may be a <span> with pattern PREFIX-DDDD or a data-testid="member-number-badge".
    // Try both: formatted pattern first, then explicit data-testid.
    const badgeByPattern = page.getByText(/^[A-Z][A-Z0-9]{0,7}-\d{4,}$/, { exact: false });
    const badgeByTestId = page.locator('[data-testid="member-number-badge"]');

    const patternVisible = await badgeByPattern.first().isVisible().catch(() => false);
    const testIdVisible = await badgeByTestId.first().isVisible().catch(() => false);

    expect(
      patternVisible || testIdVisible,
      'Portal dashboard must show member-number badge (PREFIX-NNNN or data-testid="member-number-badge")',
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm test:e2e --grep "@f-mn" --workers=1
```

Expected failures: test 1a fails (`"Member No." column header` not found — column not added yet); test 1b may pass vacuously (CLS guard can't shift on missing column); test 1c fails (`เลขสมาชิก` not found); tests 2a/2b fail (formatted number not present); test 3 fails (badge not present). All `@f-mn` tests are RED.

- [ ] **Step 3: Implement**

The implementation that makes these tests green belongs to the UI/INFRA groups (adding the column to `MembersTable`, updating `members-table-skeleton.tsx` to 10/11 cols, implementing the admin detail display with `CopyButton`, implementing the portal dashboard badge). This test task drives those implementations to their acceptance criteria.

After the UI column, skeleton update, detail page, and portal badge are implemented:

- Confirm `MembersTableSkeleton` `cols` is updated to `withSelection ? 11 : 10` in `src/components/members/members-table-skeleton.tsx`.
- Confirm the admin detail page renders the formatted number using `formatMemberNumber`.
- Confirm the portal dashboard shows the badge.

- [ ] **Step 4: Run test, verify pass**

```
pnpm test:e2e --grep "@f-mn" --workers=1
```

Expected: all 5 tests pass (green). Confirm CLS ≤ 0.01 output in test 1b.

- [ ] **Step 5: Commit**

```
git add tests/e2e/member-number.spec.ts
git commit -m "test(members): E2E member-number column CLS + th-TH no-wrap + portal badge (T-MN-04)"
```

---

### Task TEST-5: Skeleton column-count Vitest unit test (CLS-0 compile-time guard)

**Files:**
- Create: `tests/unit/members/presentation/members-table-skeleton-cols.test.tsx`

**Context:** The design spec §8.1 states: "MUST update `members-table-skeleton.tsx` same commit: cols 9→10 (manager/`withSelection=false`) and 10→11 (admin/`withSelection=true`) + both grid-template strings (CLS-0 blocker per ux-standards §15 — TS/lint won't catch this). A fast Vitest presentation test (10 cells no-selection, 11 with-selection) guards it before the E2E CLS check." This task is that Vitest test.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * T-MN-05 — Skeleton column-count guard (CLS-0 blocker).
 *
 * After the member-number column is added to MembersTable, the
 * skeleton must render 10 cells (no-selection) / 11 cells
 * (with-selection) to avoid a layout shift when real data lands.
 *
 * The count is derived from the header row. ux-standards §2.1 +
 * §15 require exact shape match between skeleton and table.
 *
 * This test fails IMMEDIATELY when someone changes the skeleton
 * column count without updating this assertion — compiler and
 * lint both miss it because `cols` is a plain number literal.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

describe('MembersTableSkeleton column count after member-number addition (T-MN-05)', () => {
  it('renders 10 skeleton cells in the header row when withSelection=false (manager/default)', () => {
    const { container } = render(<MembersTableSkeleton withSelection={false} />);
    // The first child div is the header row.
    const headerRow = container.firstElementChild?.firstElementChild;
    expect(headerRow).toBeDefined();
    const cellCount = headerRow!.children.length;
    expect(
      cellCount,
      'no-selection skeleton must have 10 columns (9 data + member-number)',
    ).toBe(10);
  });

  it('renders 11 skeleton cells in the header row when withSelection=true (admin)', () => {
    const { container } = render(<MembersTableSkeleton withSelection={true} />);
    const headerRow = container.firstElementChild?.firstElementChild;
    expect(headerRow).toBeDefined();
    const cellCount = headerRow!.children.length;
    expect(
      cellCount,
      'with-selection skeleton must have 11 columns (1 select + 9 data + member-number)',
    ).toBe(11);
  });

  it('grid-template for withSelection=false contains repeat(10,...)', () => {
    const { container } = render(<MembersTableSkeleton withSelection={false} />);
    const headerRow = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(headerRow).toBeDefined();
    // The inline style gridTemplateColumns must reference 10 columns.
    const style = headerRow!.getAttribute('style') ?? '';
    // After update: 'repeat(10, minmax(0, 1fr))'
    expect(style).toContain('repeat(10');
  });

  it('grid-template for withSelection=true starts with 40px (select column) + 10 data columns', () => {
    const { container } = render(<MembersTableSkeleton withSelection={true} />);
    const headerRow = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(headerRow).toBeDefined();
    const style = headerRow!.getAttribute('style') ?? '';
    // After update: '40px repeat(10, minmax(0, 1fr))'
    expect(style).toContain('40px');
    expect(style).toContain('repeat(10');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```
pnpm vitest run tests/unit/members/presentation/members-table-skeleton-cols.test.tsx
```

Expected failure: `expect(received).toBe(expected) → Expected: 10, Received: 9` for the no-selection case (current skeleton still has 9 cols pre-implementation).

- [ ] **Step 3: Implement**

Update `src/components/members/members-table-skeleton.tsx` lines 34–40:

```typescript
// Before (current):
const cols = withSelection ? 10 : 9;
const gridTemplate = withSelection
  ? '40px repeat(9, minmax(0, 1fr))'
  : 'repeat(9, minmax(0, 1fr))';

// After (member-number column added):
const cols = withSelection ? 11 : 10;
const gridTemplate = withSelection
  ? '40px repeat(10, minmax(0, 1fr))'
  : 'repeat(10, minmax(0, 1fr))';
```

- [ ] **Step 4: Run test, verify pass**

```
pnpm vitest run tests/unit/members/presentation/members-table-skeleton-cols.test.tsx
```

Expected: all 4 `it` blocks pass (green).

- [ ] **Step 5: Commit**

```
git add tests/unit/members/presentation/members-table-skeleton-cols.test.tsx src/components/members/members-table-skeleton.tsx
git commit -m "test(members): skeleton column-count guard + 9→10/10→11 CLS-0 fix (T-MN-05)"
```

---

**Execution order:** TEST-3 → TEST-5 → TEST-1 → TEST-2 → TEST-4

TEST-3 must come first because it adds `member_number_assigned` to the F3 union (which the INFRA group's `createMember` wiring depends on). TEST-5 must land in the same commit that updates the skeleton (its `beforeAll` migration prerequisite is zero). TEST-1 and TEST-2 both require migration 0209 to be applied before their `Step 4` green runs — they can be authored (Step 1–2 RED commits) before the migration lands. TEST-4 requires the full UI implementation to be green; author the file early, run green only after UI/INFRA groups complete.

---

## Self-review checklist (run before execution)

- [ ] **Spec coverage** — every design § (§4–§11) maps to a task group (table above). ✅ mapped.
- [ ] **Placeholder scan** — no `TODO`/`TBD`/`fill in` in code steps (CI `check:fixme` also guards `tests/`).
- [ ] **Type consistency** — all groups use the CANON names verbatim (`MemberNumber`, `asMemberNumber`, `formatMemberNumber`, `parseMemberNumberQuery`, `MemberNumberAllocatorPort.allocate`, `tenant_member_sequences`, `member_number_assigned`).
- [ ] **Gotchas honored** — allocator inside `runInTenant` tx; apply migration + integration before commit; `.notNull()` only after 0209; typecheck as the LAST gate; explicit `git add` (never `git add .`); F1 audit count stays 32.
