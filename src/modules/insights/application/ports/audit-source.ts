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

/** Decoded keyset cursor — `(timestamp epoch-ms, id)` of the prior page's last row. */
export interface AuditSourceCursor {
  readonly ts: number;
  readonly id: string;
}

export interface AuditSourceFilters {
  readonly eventType?: readonly string[];
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly cursor?: AuditSourceCursor;
  /** Reader fetches exactly this many rows (the use-case passes `limit + 1`). */
  readonly limit: number;
}

export interface AuditSourceRow {
  readonly id: string;
  readonly eventType: string;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly summary: string;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly payload: Record<string, unknown> | null;
}

export interface AuditEventSource {
  query(ctx: TenantContext, filters: AuditSourceFilters): Promise<readonly AuditSourceRow[]>;
}
