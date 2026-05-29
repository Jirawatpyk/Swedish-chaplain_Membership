/**
 * F9 insights — Drizzle schema (T015).
 *
 * The 4 F9 tables: `dashboard_metrics_cache`, `smart_insight_dismissals`,
 * `directory_listings`, `export_jobs`. Mirrors the applied hand-authored
 * migrations 0185–0188 exactly.
 *
 * **RLS+FORCE policies, CHECK constraints, the composite FK to `members`, and
 * the `chamber_app` GRANTs are NOT expressed here** — drizzle-kit cannot emit
 * them and they live in the raw-SQL migrations (0185–0188). This mirrors the
 * F3 members-schema convention. Columns + PKs + indexes + enums below are kept
 * byte-faithful to the DDL so `drizzle-kit generate` does not emit spurious
 * DROP/ALTER for tables it would otherwise not see (this file IS registered in
 * `drizzle.config.ts`). Tenant isolation is enforced at the DB layer by the
 * migration RLS policies; all access threads `tx` via `runInTenant`.
 */

import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// --- Enums (created by migration 0188) ---------------------------------------

export const exportKindEnum = pgEnum('export_kind', [
  'gdpr_member_archive',
  'directory_ebook',
  'directory_json',
  'audit_export',
]);

export const exportStatusEnum = pgEnum('export_status', [
  'requested',
  'processing',
  'ready',
  'delivered',
  'expired',
  'failed',
]);

// --- dashboard_metrics_cache (migration 0185) --------------------------------

export const dashboardMetricsCache = pgTable('dashboard_metrics_cache', {
  tenantId: text('tenant_id').primaryKey(),
  // Typed `DashboardSnapshot` projection (counts, YTD revenue, needs-attention,
  // under-delivered-benefit count, top insights). Derived — safe to rebuild.
  metrics: jsonb('metrics').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  stale: boolean('stale').notNull().default(false),
  // Claim marker so cold-start lazy compute + cron never double-compute.
  refreshStartedAt: timestamp('refresh_started_at', { withTimezone: true }),
});

// --- smart_insight_dismissals (migration 0186) -------------------------------

export const smartInsightDismissals = pgTable(
  'smart_insight_dismissals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    // CHECK ∈ ('unused_eblast_quota','underused_event_tickets','at_risk_followup')
    // enforced at the DB layer (migration 0186).
    insightKey: text('insight_key').notNull(),
    // '' sentinel (NOT NULL) for tenant-wide insights so the unique index dedupes.
    scopeRef: text('scope_ref').notNull().default(''),
    dismissedBy: uuid('dismissed_by').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Per-insight suppression window (membership year | ISO week).
    cycleKey: text('cycle_key').notNull(),
  },
  (table) => [
    uniqueIndex('smart_insight_dismissals_idempotent_uniq').on(
      table.tenantId,
      table.insightKey,
      table.scopeRef,
      table.cycleKey,
    ),
  ],
);

// --- directory_listings (migration 0187) -------------------------------------

export const directoryListings = pgTable(
  'directory_listings',
  {
    tenantId: text('tenant_id').notNull(),
    // Composite FK (tenant_id, member_id) → members; expressed in migration 0187.
    memberId: uuid('member_id').notNull(),
    listed: boolean('listed').notNull().default(false),
    // Per-field toggle for the fixed field set (email default-hidden).
    fieldVisibility: jsonb('field_visibility').notNull().default({}),
    industry: text('industry'),
    // Length-capped + website scheme-restricted via CHECKs in migration 0187.
    description: text('description'),
    website: text('website'),
    logoBlobKey: text('logo_blob_key'),
    locationCity: text('location_city'),
    locationCountry: text('location_country'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'directory_listings_pkey',
      columns: [table.tenantId, table.memberId],
    }),
  ],
);

// --- export_jobs (migration 0188) --------------------------------------------

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    kind: exportKindEnum('kind').notNull(),
    // Data subject (GDPR); null for directory-wide artefacts.
    subjectMemberId: uuid('subject_member_id'),
    requestedBy: uuid('requested_by').notNull(),
    requestedForPeriod: text('requested_for_period'),
    // FR-029 (US6) — requester's locale captured at request time so the async
    // worker renders the GDPR README in it (EN fallback). Null for non-GDPR kinds.
    requesterLocale: text('requester_locale'),
    status: exportStatusEnum('status').notNull().default('requested'),
    idempotencyKey: text('idempotency_key').notNull(),
    blobKey: text('blob_key'),
    downloadTokenHash: text('download_token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('export_jobs_tenant_idempotency_uniq').on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index('export_jobs_tenant_status_idx').on(table.tenantId, table.status),
  ],
);

// --- Inferred row types (Infrastructure → Application translation) -----------

export type DashboardMetricsCacheRow = typeof dashboardMetricsCache.$inferSelect;
export type DashboardMetricsCacheInsert = typeof dashboardMetricsCache.$inferInsert;
export type SmartInsightDismissalRow = typeof smartInsightDismissals.$inferSelect;
export type SmartInsightDismissalInsert = typeof smartInsightDismissals.$inferInsert;
export type DirectoryListingRow = typeof directoryListings.$inferSelect;
export type DirectoryListingInsert = typeof directoryListings.$inferInsert;
export type ExportJobRow = typeof exportJobs.$inferSelect;
export type ExportJobInsert = typeof exportJobs.$inferInsert;
