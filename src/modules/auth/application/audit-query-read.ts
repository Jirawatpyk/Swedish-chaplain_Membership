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

/**
 * Decoded keyset cursor — the `(timestamp, id)` of the prior page's last row.
 * `iso` is the FULL-PRECISION `timestamptz` text (microseconds), NOT epoch-ms:
 * `audit_log.timestamp` is written by `defaultNow()` at microsecond precision,
 * so a millisecond-truncated cursor would silently skip rows that share a
 * millisecond with the boundary row but differ in their microsecond fraction.
 */
export interface AuditQueryCursor {
  /** Full-precision `timestamptz` text, e.g. `2026-05-20 10:00:00.123456+00`. */
  readonly iso: string;
  readonly id: string;
}

/**
 * Reader filters. All optional except `limit`. The reader fetches exactly
 * `filters.limit` rows; the `limit + 1` fetch-one-extra trick (to derive
 * `hasMore`) lives in the use-case, not here — the reader honours `limit`
 * verbatim.
 */
export interface AuditQueryReadFilters {
  readonly eventType?: readonly AuditEventType[];
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  /**
   * Full-precision (µs) UTC ISO instant — bound as `${from|to}::timestamptz`
   * (NOT a JS `Date`, which is ms-only and would truncate the µs that
   * `tenantDayEndUtc`'s .999999 day-cap relies on). Same precision contract as
   * the keyset cursor below. (code-review Round 2 — #14)
   */
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: AuditQueryCursor;
  /**
   * Keyset direction relative to the cursor (default `'forward'`):
   *   - `'forward'`  → rows OLDER than the cursor, `(ts,id) DESC` (the Next page).
   *   - `'backward'` → rows NEWER than the cursor, `(ts,id) ASC` (the Previous
   *     page). The reader returns them ASC (closest-newer first); the use-case
   *     reverses to the newest-first display order.
   * Ignored when there is no cursor (the first page is always forward/DESC).
   */
  readonly direction?: 'forward' | 'backward';
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
  /** Full-precision `timestamptz` text (µs) — the value the keyset cursor is built from. */
  readonly occurredAtIso: string;
  readonly requestId: string;
  /** Typed JSONB diff/context, or `null` for F1 rows without a payload. */
  readonly payload: Record<string, unknown> | null;
}

export interface AuditQueryReadPort {
  /**
   * Returns up to `filters.limit` rows for the current tenant, applying the
   * keyset cursor + filters. Forward (default) → newest-first (`timestamp DESC,
   * id DESC`); backward → oldest-first (`timestamp ASC, id ASC`, the rows just
   * newer than the cursor). Throws on a DB read failure — the consuming use-case
   * maps that to its Result channel.
   */
  query(ctx: import('@/modules/tenants').TenantContext, filters: AuditQueryReadFilters): Promise<readonly AuditQueryReadRow[]>;
}
