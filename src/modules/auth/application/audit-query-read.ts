/**
 * Auth-owned audit-log READER contract (F9 US2 / T044).
 *
 * `audit_log` is owned by the `auth` module (it owns the table + the Postgres
 * `audit_event_type` enum), so the keyset-paginated, filterable reader that
 * backs the F9 audit viewer lives here — the insights `auditQuery` use-case
 * consumes it through the auth public barrel (mirrors how `activityFeedQuery`
 * consumes `listRecentAuditEvents` + `auditReadAdapter`).
 *
 * This file is the PORT + row contract only (pure types — no framework/ORM
 * imports, Principle III). The Drizzle implementation is
 * `infrastructure/db/audit-query-repo.ts`.
 *
 * The reader returns the FULL payload — role-based redaction (FR-011) is the
 * consuming use-case's concern, not the reader's. The reader only enforces
 * tenant isolation (Principle I): an explicit `tenant_id = ctx.slug` predicate
 * (the app-layer half) on top of the permissive RLS policy (the db-layer half),
 * which also excludes legacy null-tenant_id F1 rows from a tenant's viewer.
 */
import type { AuditEventType } from '../domain/audit-event';

/** Decoded keyset cursor — the `(timestamp, id)` of the last row of the prior page. */
export interface AuditQueryCursor {
  /** `timestamp` as epoch-ms (the column is `timestamptz`). */
  readonly ts: number;
  readonly id: string;
}

/**
 * Reader filters. All optional except `limit`. The caller (use-case) clamps
 * `limit` and passes `limit + 1` is NOT done here — the reader fetches exactly
 * `limit` rows; the use-case asks for `limit + 1` to derive `hasMore`.
 */
export interface AuditQueryReadFilters {
  readonly eventType?: readonly AuditEventType[];
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly cursor?: AuditQueryCursor;
  readonly limit: number;
}

/** One audit row as read from `audit_log` (full, unredacted). */
export interface AuditQueryReadRow {
  readonly id: string;
  readonly eventType: AuditEventType;
  /** Actor identity (UUID or a `system:*`/`anonymous` sentinel). */
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly summary: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  /** Typed JSONB diff/context, or `null` for F1 rows without a payload. */
  readonly payload: Record<string, unknown> | null;
}

export interface AuditQueryReadPort {
  /**
   * Returns up to `filters.limit` rows for the current tenant, newest-first
   * (`timestamp DESC, id DESC`), applying the keyset cursor + filters. Throws on
   * a DB read failure — the consuming use-case maps that to its Result channel.
   */
  query(ctx: import('@/modules/tenants').TenantContext, filters: AuditQueryReadFilters): Promise<readonly AuditQueryReadRow[]>;
}
