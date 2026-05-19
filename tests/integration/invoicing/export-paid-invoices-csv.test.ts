/**
 * Phase 3 of the F4 receipt-surface plan — integration test for
 * `exportPaidInvoicesCsv` against live Neon Singapore.
 *
 * Covers the wire-level concerns that the unit test cannot:
 *   • The `invoices_csv_exported` row really lands in `audit_log`
 *     (the SQL enum accepts the new value — proves migration 0149 +
 *     `auditEventTypeEnum` are in sync at HEAD).
 *   • `audit_log.retention_years = 5` matches `F4_AUDIT_RETENTION_YEARS`
 *     (operational class, 5y per Constitution VIII).
 *   • The audit payload shape (`from / to / row_count / actor_user_id /
 *     route`) survives the round-trip through `f4AuditAdapter` →
 *     Postgres jsonb → SELECT.
 *
 * The richer filtering + escaping assertions live in the unit test
 * (`tests/unit/invoicing/export-paid-invoices-csv.test.ts`) — this
 * file only proves the live-DB wiring + audit contract holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { exportPaidInvoicesCsv } from '@/modules/invoicing';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import type { ExportPaidInvoicesCsvDeps } from '@/modules/invoicing';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('exportPaidInvoicesCsv — integration (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    user = await createActiveTestUser('admin');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('emits invoices_csv_exported with retention_years=5 + correct payload', async () => {
    const requestId = `int-csv-${randomUUID()}`;
    const deps: ExportPaidInvoicesCsvDeps = {
      invoiceRepo: makeDrizzleInvoiceRepo(tenant.ctx.slug),
      audit: f4AuditAdapter,
      paymentMethodLookup: async () =>
        new Map<string, 'card' | 'promptpay'>(),
    };

    const result = await runInTenant(tenant.ctx, async () =>
      exportPaidInvoicesCsv(deps, {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId,
        // Empty tenant → 0 paid invoices in range — proves the use-case
        // tolerates an empty result without throwing, AND that the
        // audit emit still lands (row_count=0 case).
        from: '2026-05-01',
        to: '2026-05-31',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(0);
    // BOM + header line present even on empty result.
    expect(result.value.csv.charCodeAt(0)).toBe(0xfeff);
    expect(result.value.csv).toContain('Issue Date,Invoice No.,Receipt No.');
    expect(result.value.filename).toBe(
      'invoices-paid-2026-05-01-to-2026-05-31.csv',
    );

    // --- Audit row lands with 5y retention + correct payload ---
    // `audit_log.retention_years` (added in migration 0039) is NOT
    // mapped on the Drizzle schema yet, so we read it via raw SQL.
    const rawRows = await db.execute<{
      retention_years: number;
      actor_user_id: string;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT retention_years, actor_user_id, payload
      FROM audit_log
      WHERE tenant_id = ${tenant.ctx.slug}
        AND event_type = 'invoices_csv_exported'::audit_event_type
        AND request_id = ${requestId}
    `);
    // Drizzle's `db.execute` returns a `QueryResult`-like with `.rows`
    // on neon-http; coerce defensively.
    const rows = Array.isArray(rawRows)
      ? rawRows
      : (rawRows as { rows: typeof rawRows }).rows;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.retention_years).toBe(5);
    expect(row.actor_user_id).toBe(user.userId);
    expect(row.payload.from).toBe('2026-05-01');
    expect(row.payload.to).toBe('2026-05-31');
    expect(row.payload.row_count).toBe(0);
    expect(row.payload.actor_user_id).toBe(user.userId);
    expect(row.payload.route).toBe('export-paid-invoices-csv');
  }, 60_000);
});
