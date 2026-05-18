# Data Model: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Branch**: `014-email-broadcast-advance` | **Date**: 2026-05-17 (split to F7.1a 2026-05-18)
**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **F7.1b backlog**: [f71b-backlog.md](./f71b-backlog.md)

This document catalogues every entity F7.1a adds or extends, the corresponding Drizzle schema + SQL migration, RLS+FORCE+CHECK constraint policies, audit-event taxonomy, and the broadcast state machine evolution.

---

## 1. Entities (overview)

| # | Entity | Status | Module | Notes |
|---|--------|--------|--------|-------|
| 1 | **Broadcast** | EXTEND | broadcasts | F7 MVP table + 4 new columns + state-machine additions + `started_from_template_id` FK to BroadcastTemplate |
| 2 | **BatchManifest** | NEW | broadcasts | One row per dispatch batch under a broadcast (US1) |
| 3 | **TenantImageSourceAllowlist** | NEW | broadcasts | Per-tenant `<img src>` hostname allowlist (US2) |
| 4 | **BroadcastTemplate** | NEW | broadcasts | Tenant-scoped admin-authored template library (US7); seeded with 5 starters per tenant at ship |
| 5 | **TenantBroadcastSettings** | EXTEND | broadcasts | F7 MVP table + 1 new column (`dispatch_concurrency_cap`) |

**5 entities total** (US7 added back per maintainer decision; was 4 in 2-US scope, 9 in original 8-US scope). 3 NEW tables + 2 EXTENDed F7-MVP-era tables. No cross-module changes in F7.1a (the F3 contacts mutation that was in original F7.1's data-model is deferred to F7.1b — see `f71b-backlog.md` § US3).

---

## 2. Entity definitions

### 2.1 Broadcast (EXTEND F7 MVP)

```typescript
// Drizzle schema fragment — src/modules/broadcasts/infrastructure/schema.ts
export const broadcasts = pgTable('broadcasts', {
  // ...existing F7 MVP columns...

  // F7.1a EXTENSIONS:
  manualRetryCount: integer('manual_retry_count').notNull().default(0),
  partialDeliveryAcceptedAt: timestamp('partial_delivery_accepted_at', { withTimezone: true }),
  partialDeliveryAcceptedByUserId: uuid('partial_delivery_accepted_by_user_id'),
  startedFromTemplateId: uuid('started_from_template_id').references(() => broadcastTemplates.id, { onDelete: 'set null' }), // FR-022 (US7)
  templateNameSnapshot: text('template_name_snapshot'), // FR-019 / critique P9 — denormalised template name at snapshot time; survives template deletion for forensic audit
}, (table) => ({
  // existing F7 MVP constraints + new:
  manualRetryCountCheck: check('broadcasts_manual_retry_count_check', sql`${table.manualRetryCount} BETWEEN 0 AND 3`),
}));
```

**State machine extensions** (FR-008a..d):
- New states: `partially_sent` (non-terminal until retry budget exhausted or admin accepts), `partial_delivery_accepted` (terminal)
- `retrying` is an Application-layer transient state — NOT persisted to `broadcasts.status` enum (per research.md § 3 / critique M1 clarification)
- New transitions:
  - `sending → partially_sent` when ≥1 batch failed after exhausting per-batch retry budget
  - `partially_sent → (retry use-case bracketed by tx; observers see `partially_sent` → `sent` if all success, or `partially_sent` → `partially_sent` with incremented `manual_retry_count`)`
  - `partially_sent → partial_delivery_accepted` on admin "Accept partial delivery" action

### 2.2 BatchManifest (NEW — US1)

```typescript
export const broadcastBatchManifests = pgTable('broadcast_batch_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(), // RLS-enforced
  broadcastId: uuid('broadcast_id').notNull().references(() => broadcasts.id, { onDelete: 'cascade' }),
  batchIndex: integer('batch_index').notNull(), // 0-based
  recipientCount: integer('recipient_count').notNull(),
  recipientRangeStart: integer('recipient_range_start').notNull(), // 0-based inclusive
  recipientRangeEnd: integer('recipient_range_end').notNull(), // 0-based inclusive
  status: text('status', { enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'] }).notNull().default('pending'), // 'cancelled' added per analyze round 2 N1 — set by cancelBroadcast use-case (T163) when admin halts mid-dispatch broadcast per FR-004
  providerAudienceId: text('provider_audience_id'), // Resend audience id; null before send
  idempotencyKey: text('idempotency_key').notNull(),
  retryCount: integer('retry_count').notNull().default(0),
  deliveredCount: integer('delivered_count').notNull().default(0),
  bouncedCount: integer('bounced_count').notNull().default(0),
  complainedCount: integer('complained_count').notNull().default(0),
  unsubscribedCount: integer('unsubscribed_count').notNull().default(0),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantBroadcastBatchUnique: unique().on(table.tenantId, table.broadcastId, table.batchIndex),
  idempotencyKeyUnique: unique('broadcast_batch_idempotency_key_uniq').on(table.tenantId, table.idempotencyKey),
  recipientRangeCheck: check('broadcast_batch_recipient_range_check', sql`${table.recipientRangeEnd} >= ${table.recipientRangeStart}`),
  retryCountCheck: check('broadcast_batch_retry_count_check', sql`${table.retryCount} >= 0 AND ${table.retryCount} <= 5`), // per-batch automatic retries (separate from broadcast-level manual retries)
  recipientCountCheck: check('broadcast_batch_recipient_count_check', sql`${table.recipientCount} <= 10000`), // Resend per-audience cap
}));
```

### 2.3 TenantImageSourceAllowlist (NEW — US2)

```typescript
export const tenantImageSourceAllowlist = pgTable('tenant_image_source_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(), // RLS-enforced
  hostname: text('hostname').notNull(), // exact match, no wildcards (FR-010)
  isDefault: boolean('is_default').notNull().default(false), // defaults cannot be removed (research.md § 4)
  createdByUserId: uuid('created_by_user_id'), // null for system-seeded defaults
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantHostnameUnique: unique('tenant_image_allowlist_hostname_uniq').on(table.tenantId, table.hostname),
  hostnameFormatCheck: check('tenant_image_allowlist_hostname_format_check', sql`${table.hostname} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'`), // RFC 1035 hostname format; explicit no-wildcard
}));
```

### 2.4 BroadcastTemplate (NEW — US7)

**Locale semantics (per critique E3)**: `broadcast_templates.locale` represents the **content** locale (the language the body is written in), NOT the **send** locale. Broadcasts themselves do not carry a locale column — they have body content in whatever language the member composed. The picker filter (`contracts/broadcast-template.md § 3`) is a UX convenience for showing templates in the user's preferred locale first; it is NOT a tenant-isolation invariant. Cross-locale template authoring is permitted (e.g., a Thai admin can create an English template for sponsorship thank-yous).


```typescript
export const broadcastTemplates = pgTable('broadcast_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(), // RLS-enforced
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  bodyHtml: text('body_html').notNull(), // sanitized at save time per FR-017
  locale: text('locale', { enum: ['en', 'th', 'sv'] }).notNull().default('en'), // primary locale; each starter template has 3 rows (one per locale)
  startedFromCount: integer('started_from_count').notNull().default(0), // denormalised for FR-023 forensic visibility
  isSeeded: boolean('is_seeded').notNull().default(false), // TRUE for the 5 starters per FR-020; FALSE for admin-authored
  createdByUserId: uuid('created_by_user_id'), // null for seeded starters
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // soft-delete to preserve audit-trail
}, (table) => ({
  tenantNameLocaleUnique: unique('broadcast_templates_tenant_name_locale_uniq').on(table.tenantId, table.name, table.locale),
  nameLengthCheck: check('broadcast_templates_name_length_check', sql`length(${table.name}) > 0 AND length(${table.name}) <= 100`),
  subjectLengthCheck: check('broadcast_templates_subject_length_check', sql`length(${table.subject}) > 0 AND length(${table.subject}) <= 200`),
  bodyLengthCheck: check('broadcast_templates_body_length_check', sql`length(${table.bodyHtml}) <= 204800`), // 200 KB matching F7 MVP body cap
}));
```

### 2.5 TenantBroadcastSettings (EXTEND F7 MVP)

```typescript
// F7 MVP table + F7.1a columns:
dispatchConcurrencyCap: integer('dispatch_concurrency_cap').notNull().default(4),
// CHECK:
dispatchConcurrencyCapCheck: check('tenant_broadcast_dispatch_concurrency_cap_check', sql`${table.dispatchConcurrencyCap} BETWEEN 1 AND 8`),
```

---

## 3. Migrations

**Numbering**: F8 PR #24 occupied migrations **0124–0126** on `main` (verified via `ls drizzle/migrations/`). F7.1a therefore starts at **0127**. The 6 deferred migrations from original F7.1 (those serving US3-US8) are preserved in `f71b-backlog.md` for re-numbering at F7.1b promotion time.

| # | File | Purpose |
|---|------|---------|
| 0127 | `0127_f71a_broadcast_templates.sql` | CREATE `broadcast_templates` + indexes + CHECK (must precede 0128 since broadcasts.started_from_template_id references it) |
| 0128 | `0128_f71a_broadcast_extensions.sql` | Add 4 new columns to `broadcasts` (manual_retry_count + partial_delivery_* + started_from_template_id FK) |
| 0129 | `0129_f71a_broadcast_batch_manifests.sql` | CREATE `broadcast_batch_manifests` + indexes + CHECK |
| 0130 | `0130_f71a_tenant_image_source_allowlist.sql` | CREATE `tenant_image_source_allowlist` + indexes + CHECK + system-seed defaults per existing tenant |
| 0131 | `0131_f71a_tenant_broadcast_settings_ext.sql` | Add `dispatch_concurrency_cap` column |
| 0132 | `0132_f71a_rls_policies.sql` | RLS + FORCE on 3 new tables; policy = `tenant_id = current_setting('app.current_tenant')::uuid` |
| 0133 | `0133_f71a_audit_event_grants.sql` | 10 new audit event types at 5-year retention |
| 0134 | `0134_f71a_default_template_seed.sql` | Seed 5 starter templates × 3 locales = 15 rows per tenant (Monthly Newsletter, Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You × EN+TH+SV); skip if same-name template exists (FR-020) |

**Migration ordering invariants**:
- 0127 (templates) MUST precede 0128 (broadcasts FK to broadcast_templates.id)
- 0128 (broadcasts ext) MUST precede 0129 (batch manifests FK to broadcasts.id)
- 0130 (image allowlist) MUST precede the seed step within itself (single transaction)
- 0132 (RLS) MUST run AFTER all 3 new tables exist (0127, 0129, 0130)
- 0134 (template seed) MUST run AFTER 0127 (template table exists) + 0132 (RLS active — seed insert via `runInTenant()` per tenant)

**8 migrations total** (up from 6 in 2-US scope due to US7; down from 12 in original 8-US scope). All F7.1a migrations are non-destructive — none touch existing F7 MVP rows.

---

## 4. Application use-cases (catalogue)

| # | Use-case | US | Domain entity | Audit event(s) emitted |
|---|----------|----|---------------|----|
| 1 | `splitBroadcastIntoBatches` | US1 | BatchManifest | `broadcast_dispatched_in_batches` |
| 2 | `dispatchBroadcastBatch` | US1 | BatchManifest | (per-batch; carries `batch_index` in event payload) |
| 3 | `retryFailedBatches` | US1 | Broadcast (state) | `broadcast_retry_initiated`, `broadcast_retry_completed` |
| 4 | `acceptPartialDelivery` | US1 | Broadcast (state) | `broadcast_partial_delivery_accepted` |
| 5 | `validateImageSourceAllowlist` | US2 | ImageSourceAllowlist | `broadcast_body_image_source_unsafe` |
| 6 | `uploadInlineImage` | US2 | (transient) | `broadcast_image_too_large` (on cap exceed) |
| 7 | `scanInlineImageForVirus` | US2 | (transient) | `broadcast_image_unsafe` (on infected; absorbed into existing F7 MVP submit audit) |
| 8 | `manageImageAllowlist` | US2 | ImageSourceAllowlist | `broadcast_image_allowlist_updated` |
| 9 | `createBroadcastTemplate` | US7 | BroadcastTemplate | `broadcast_template_created` |
| 10 | `updateBroadcastTemplate` | US7 | BroadcastTemplate | `broadcast_template_updated` |
| 11 | `deleteBroadcastTemplate` | US7 | BroadcastTemplate | `broadcast_template_deleted` |
| 12 | `snapshotTemplateToDraft` | US7 | (transient) | (no event — captured by existing broadcast_draft_started with extended `started_from_template_id`) |

**12 use-cases total** (up from 8 in 2-US scope due to US7; down from 26 in original 8-US scope). Each has ≥1 contract test in `tests/contract/broadcasts/` per plan.md § Project Structure.

---

## 5. RLS + FORCE policies (Principle I sub-clause 2)

Both new tables ship with:

```sql
ALTER TABLE broadcast_batch_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_batch_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcast_batch_manifests_tenant_isolation ON broadcast_batch_manifests
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```

…and identical pattern for `tenant_image_source_allowlist` AND `broadcast_templates`. Total = **3 new RLS policies** (up from 2 in 2-US scope due to US7; down from 6 in original 8-US scope).

The existing F7 MVP RLS on `broadcasts`, `broadcast_deliveries`, `marketing_unsubscribes`, `recipient_segments` carries forward unchanged.

---

## 6. Cross-tenant probe test pattern (per US — Principle I sub-clause 3)

Each of the 3 user stories ships ≥1 cross-tenant probe integration test:
- `tests/integration/broadcasts/pagination-cross-tenant-probe.test.ts` (US1)
- `tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts` (US2)
- `tests/integration/broadcasts/template-cross-tenant-probe.test.ts` (US7)

Common pattern (same as original F7.1 — preserved):

```typescript
describe('<US> cross-tenant probe', () => {
  it('tenant B cannot READ tenant A entity by id', async () => {/* ... */});
  it('tenant B cannot UPDATE tenant A entity', async () => {/* ... */});
  it('tenant B cannot DELETE tenant A entity', async () => {/* ... */});
  it('emits broadcast_cross_tenant_probe audit event on attempted access', async () => {/* ... */});
});
```

---

## 7. Audit event taxonomy (canonical catalogue — F7.1a only)

| # | Event type | Severity | Retention (years) | US |
|---|-----------|----------|-------------------|----|
| 1 | `broadcast_dispatched_in_batches` | INFO | 5 | US1 |
| 2 | `broadcast_retry_initiated` | INFO | 5 | US1 |
| 3 | `broadcast_retry_completed` | INFO | 5 | US1 |
| 4 | `broadcast_partial_delivery_accepted` | INFO | 5 | US1 |
| 5 | `broadcast_body_image_source_unsafe` | WARN | 5 | US2 |
| 6 | `broadcast_image_too_large` | INFO | 5 | US2 |
| 7 | `broadcast_image_allowlist_updated` | INFO | 5 | US2 |
| 8 | `broadcast_template_created` | INFO | 5 | US7 |
| 9 | `broadcast_template_updated` | INFO | 5 | US7 |
| 10 | `broadcast_template_deleted` | INFO | 5 | US7 |
| — | `broadcast_template_seed_skipped_existing_name` | INFO | 5 | US7 (FR-020; operator audit signal — emitted from migration 0134, NOT runtime use-case) |
| — | `broadcast_template_seed_tenant_failed` | WARN | 5 | US7 / critique E4 — emitted when per-tenant seed atomicity check fails (e.g., CHECK constraint violation on body length) so operator can rollforward without blocking other tenants |
| — | `broadcast_cross_tenant_probe` | CRITICAL | 5 | cross-cutting Principle I sub-clause 4 |

**10 NEW unique event types** (up from 7 in 2-US scope; down from 23 in original 8-US scope). The 13 deferred event types are preserved in `f71b-backlog.md` for re-spec.

---

## 8. State machine summary (Broadcast aggregate)

```
draft
  ↓ submit
submitted
  ↓ approve                                ↘ reject
approved → scheduled?                       rejected (terminal)
  ↓                                         ↓ recompose
sending                                     draft
  ↓ all batches success → sent (terminal)
  ↓ ≥1 batch failed   → partially_sent (NEW non-terminal)
                          ↓ admin: Retry failed batches → [bracketed by tx + advisory lock]
                          │                                  ├─ all success → sent
                          │                                  └─ still failed → partially_sent (manual_retry_count++)
                          ↓ admin: Accept partial delivery → partial_delivery_accepted (NEW terminal)
                          ↓ all 3 retries exhausted + idle → (UI banner alerts admin; same state)
  ↓ admin or member: cancel → cancelled (terminal)
```

**Persisted `broadcasts.status` enum**: `draft` | `submitted` | `approved` | `scheduled` | `sending` | `sent` | `partially_sent` | `partial_delivery_accepted` | `cancelled` | `failed` | `rejected` (10 values).

**`retrying` is NOT in the enum** — exists only as an Application-layer in-transaction state per research.md § 3.

State invariants:
- `manual_retry_count ∈ [0, 3]` enforced by CHECK constraint
- `partially_sent` is non-terminal iff `manual_retry_count < 3 AND partial_delivery_accepted_at IS NULL`
- Concurrent retry attempts blocked by `broadcasts-retry:` advisory lock per FR-008d
- Transitions enforced by the broadcast aggregate's `transitionTo()` method (Domain layer) — invalid transitions raise `BroadcastStateError`

---

## 9. Validation rules summary (F7.1a-applicable)

| Rule | Source | Layer |
|------|--------|-------|
| Image URL `src` host must be in tenant's allowlist | FR-009, FR-011 | Application + Domain (sanitiser pure function) |
| Image upload size ≤5 MB | FR-012 / Clarifications Q4 | Application + Infrastructure (Vercel Blob upload) |
| Image MIME-type allowlist (image/png, image/jpeg, image/webp, image/gif) | FR-013 derived | Application |
| Image filename sanitised at upload boundary | FR-013 + critique E6 | Application |
| ClamAV scan REQUIRED before image bind to draft | FR-013 | Application |
| Per-batch concurrency cap ∈ [1, 8] | FR-002 / Clarifications Q1 | Domain CHECK + Application |
| Manual retry budget ∈ [0, 3] | FR-008a / Clarifications Q3 | Domain CHECK + Application |
| Image-source allowlist exact hostnames only (no wildcards) | FR-010 | Infrastructure CHECK + Application |
| Image-source allowlist defaults non-removable | FR-010 | Application |
| Per-broadcast retry serialised via `broadcasts-retry:` advisory lock | FR-008d / critique E4 | Application |

---

## 10. Index strategy

| Index | Table | Purpose | Query pattern |
|-------|-------|---------|---------------|
| `broadcast_batch_idempotency_key_uniq` | batch_manifests | dispatch idempotency | INSERT on retry |
| `tenant_image_allowlist_hostname_uniq` | image_allowlist | allowlist lookup | per-image validate |

Both indexes are tenant-scoped + ID-keyed. No additional indexes needed for F7.1a.

---

## 11. Dependency on F7 MVP schema (compatibility)

F7.1a makes NO breaking changes to F7 MVP schema:
- `broadcasts` table gains 3 new columns (all default-valued or nullable) — F7 MVP queries see no change
- `tenant_broadcast_settings` gains 1 new column (default-valued) — F7 MVP queries see no change
- F7 MVP RLS policies unchanged
- F7 MVP audit-event types unchanged (F7.1a adds NEW types only)
- F7 MVP cron coordinators unchanged (F7.1a ADDs NO new cron — engagement-event-purge was F7.1b US5, deferred; ClamAV signature refresh runs `freshclam` in Fly.io container, NOT a Vercel cron)

F7.1a + F7 MVP can co-exist in the schema; the F7.1a feature-flag matrix (research.md § 5) governs which paths execute. Existing F7 MVP broadcasts are unaffected by F7.1a ship.
