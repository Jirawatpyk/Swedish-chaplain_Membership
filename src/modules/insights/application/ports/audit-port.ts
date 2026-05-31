/**
 * F9 `InsightsAuditPort` Application port (T013).
 *
 * 15 audit event types (data-model.md § 7) as a const tuple + a discriminated
 * union so callers cannot emit an unknown `event_type`. Mirrors the F5/F7
 * audit-port pattern but ALL F9 events default to **5-year retention** — F9 is
 * a read-/oversight layer with no tax-document or financial-settlement records
 * of its own (the GDPR archive bundles existing F4 PDFs; it does not create new
 * tax records).
 *
 * F9 events are written to F1's shared `audit_log` table (the Postgres
 * `audit_event_type` enum was extended with these 15 values: migration 0191 (14)
 * + migration 0193 (`member_timeline_viewed`)).
 * The Infrastructure adapter (`insights-audit-adapter.ts`) inserts the row with
 * the `retention_years` column, mirroring the F5 raw-SQL adapter.
 *
 * `record` vs `recordInTx` (contracts/application-ports.md):
 *   - `recordInTx(tx, event)` — atomic path: the audit row commits with the
 *     caller's tenant-scoped transaction (e.g. `dismissInsight`,
 *     `requestDataExport`, `updateDirectoryListing`).
 *   - `record(event)` — best-effort / read-side / probe path: auto-commit write
 *     that must survive (or precede) the primary operation (e.g.
 *     `dashboard_viewed`, `member_benefit_viewed`, `insights_cross_tenant_probe`).
 *     Failures are logged + metered, never masking the primary Result.
 *
 * Pure interface — no framework/ORM imports (Constitution Principle III). The
 * `tx` handle is `unknown`; the Infrastructure adapter narrows it.
 *
 * Forbidden-data hygiene (research R12 / CHK032): payloads carry only
 * bounded internal identifiers (job ids, member ids, insight keys, counts) —
 * never member PII (names, emails, raw bodies).
 */

import type { InsightKey } from '../../domain/smart-insight';

export const F9_AUDIT_EVENT_TYPES = [
  // PII-read context — staff opens the operations dashboard (US1).
  'dashboard_viewed',
  // Staff runs an audit-viewer query / export (US2). Read-only over audit_log.
  'audit_log_queried',
  'audit_log_exported',
  // PII read — staff opens a member's benefit view (US4, FR-036).
  'member_benefit_viewed',
  // PII read — staff opens a member's unified timeline (US3, FR-036). The
  // timeline is the highest-PII surface (all invoices/payments/events), so a
  // staff read is audited; member self-views are NOT (not third-party access).
  'member_timeline_viewed',
  // An insight is dismissed (US1).
  'smart_insight_dismissed',
  // Member changes directory visibility / field exposure / logo (US5).
  'directory_listing_updated',
  // Directory artefacts produced (US5).
  'directory_ebook_generated',
  'directory_json_exported',
  // GDPR self-service / admin-on-behalf export lifecycle (US6).
  'data_export_requested',
  'data_export_generated',
  'data_export_downloaded',
  'data_export_failed',
  'data_export_expired',
  // High-severity cross-tenant access attempt (Principle I § 4).
  'insights_cross_tenant_probe',
] as const;

export type F9AuditEventType = (typeof F9_AUDIT_EVENT_TYPES)[number];

/**
 * Typed payload shape per event type. Bounded identifiers + counts only — no
 * member PII (FR-036 / research R12). `changed_fields` carries field *names*,
 * never values.
 */
export interface F9AuditPayloadByType {
  dashboard_viewed: {
    readonly actor_role: 'admin' | 'manager';
  };
  audit_log_queried: {
    /** Filter field names that were applied (not their values). */
    readonly applied_filters: ReadonlyArray<string>;
    readonly result_count: number;
  };
  audit_log_exported: {
    readonly applied_filters: ReadonlyArray<string>;
    readonly row_count: number;
    /** `sync` for streamed exports under the cap; `async` when routed to a job. */
    readonly delivery: 'sync' | 'async';
  };
  member_benefit_viewed: {
    readonly subject_member_id: string;
    readonly membership_year: number;
  };
  member_timeline_viewed: {
    readonly subject_member_id: string;
    /** Whether any source/actor/date filter was applied on the viewed page. */
    readonly filter_applied: boolean;
  };
  smart_insight_dismissed: {
    /** Post-validation insight key (narrowed by `isInsightKey` at the emit site). */
    readonly insight_key: InsightKey;
    readonly scope_ref: string;
    readonly cycle_key: string;
  };
  directory_listing_updated: {
    readonly subject_member_id: string;
    readonly listed: boolean;
    readonly changed_fields: ReadonlyArray<string>;
    readonly logo_action?: 'set' | 'removed';
  };
  directory_ebook_generated: {
    readonly job_id: string;
  };
  directory_json_exported: {
    readonly job_id: string;
  };
  data_export_requested: {
    readonly job_id: string;
    readonly subject_member_id: string;
    /** true when an admin produces the export on a member's behalf (FR-031). */
    readonly on_behalf: boolean;
  };
  data_export_generated: {
    readonly job_id: string;
    readonly subject_member_id: string;
  };
  data_export_downloaded: {
    readonly job_id: string;
    readonly subject_member_id: string;
  };
  data_export_failed: {
    readonly job_id: string;
    readonly error_code: string;
  };
  data_export_expired: {
    readonly job_id: string;
  };
  insights_cross_tenant_probe: {
    readonly acting_tenant_id?: string;
    readonly subject_tenant_id?: string;
    readonly probing_actor_id: string;
    readonly target_entity: string;
    readonly target_id?: string;
  };
}

/**
 * Discriminated union over `F9AuditEventType`: `payload` narrows automatically
 * from the `eventType` literal at the emit site (compile-time field validation).
 */
export type F9AuditEvent = {
  [T in F9AuditEventType]: {
    readonly tenantId: string | null;
    readonly requestId: string | null;
    readonly eventType: T;
    /** Actor user id, or a `system:*` / `anonymous` sentinel. */
    readonly actorUserId: string;
    /** Short, PII-free human-readable description (≤ 500 chars). */
    readonly summary: string;
    readonly payload: F9AuditPayloadByType[T];
    readonly retentionYears: 5;
  };
}[F9AuditEventType];

export interface InsightsAuditPort {
  /**
   * Atomic emit — the audit row commits with the caller's tenant-scoped
   * transaction. `tx` is `unknown` (Application stays ORM-free per Principle
   * III); the Infrastructure adapter narrows it to a Drizzle `TenantTx`.
   */
  recordInTx(tx: unknown, event: F9AuditEvent): Promise<void>;
  /**
   * Best-effort / read-side / probe emit — auto-commit write that survives the
   * caller's tx rollback. Failures are logged + metered, never thrown to the
   * caller (must not mask the primary Result).
   */
  record(event: F9AuditEvent): Promise<void>;
}

/**
 * Retention-year mapping — single source of truth. All F9 events are 5-year
 * (PDPA default); no tax-document overlap. Adding a new `F9AuditEventType`
 * forces this map to grow in lockstep (Record exhaustiveness).
 */
export const F9_AUDIT_RETENTION_YEARS: Record<F9AuditEventType, 5> = {
  dashboard_viewed: 5,
  audit_log_queried: 5,
  audit_log_exported: 5,
  member_benefit_viewed: 5,
  member_timeline_viewed: 5,
  smart_insight_dismissed: 5,
  directory_listing_updated: 5,
  directory_ebook_generated: 5,
  directory_json_exported: 5,
  data_export_requested: 5,
  data_export_generated: 5,
  data_export_downloaded: 5,
  data_export_failed: 5,
  data_export_expired: 5,
  insights_cross_tenant_probe: 5,
};

/** Returns the canonical retention. Use at every emit site (no hardcoded `5`). */
export function f9RetentionFor(_eventType: F9AuditEventType): 5 {
  return F9_AUDIT_RETENTION_YEARS[_eventType];
}

export function isF9AuditEventType(value: string): value is F9AuditEventType {
  return (F9_AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}
