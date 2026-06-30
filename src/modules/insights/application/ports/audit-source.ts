/**
 * F9 US2 — `AuditEventSource` port (insights-owned).
 *
 * The insights `auditQuery` / `auditExport` use-cases read `audit_log` through
 * this port; the Infrastructure adapter (`sources/audit-source-adapter.ts`)
 * binds it to the auth-owned reader (`auditQueryReadAdapter`, exposed on the
 * auth public barrel). Mirrors the `ActivityFeedSource` split — the Application
 * layer stays free of cross-module imports (Principle III); the adapter does
 * the `@/modules/auth` call.
 *
 * Pure types — no framework/ORM imports. The reader returns the FULL payload;
 * role-based redaction (FR-011) is applied by the use-case via `audit-redaction`.
 */
import type { TenantContext } from '@/modules/tenants';

/**
 * An `audit_event_type` code, intentionally `string` (not the auth `AuditEventType`
 * union) at this boundary: the code arrives untyped from a query string and the
 * insights module must not couple to auth's domain union (Principle III). It is
 * an OPAQUE label here — never validated; an unknown value simply matches no
 * rows in the reader's `inArray` predicate.
 */
export type AuditEventCode = string;

/** Decoded keyset cursor — full-precision `timestamptz` text (µs) + id of the
 *  prior page's last row (ms-truncation would drop same-ms boundary rows). */
export interface AuditSourceCursor {
  readonly iso: string;
  readonly id: string;
}

export interface AuditSourceFilters {
  readonly eventType?: readonly AuditEventCode[];
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  /** Full-precision (µs) UTC ISO instant; cast to `::timestamptz` by the reader. */
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: AuditSourceCursor;
  /**
   * Keyset direction (default `'forward'`): `'forward'` = older rows / DESC,
   * `'backward'` = newer rows / ASC (the Previous page). Ignored without a cursor.
   */
  readonly direction?: 'forward' | 'backward';
  /** Reader fetches exactly this many rows (the use-case passes `limit + 1`). */
  readonly limit: number;
}

export interface AuditSourceRow {
  readonly id: string;
  readonly eventType: AuditEventCode;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly summary: string;
  readonly occurredAt: Date;
  /** Full-precision `timestamptz` text (µs) — the keyset cursor source. */
  readonly occurredAtIso: string;
  readonly requestId: string;
  readonly payload: Record<string, unknown> | null;
}

export interface AuditEventSource {
  query(ctx: TenantContext, filters: AuditSourceFilters): Promise<readonly AuditSourceRow[]>;
}
