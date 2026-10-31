/**
 * #50 — the two repo statements the orphan arm of the stale-pending sweep
 * adds: the pending list now joins the parent payment for its payment intent,
 * and the orphan's closing UPDATE refuses a row that has gained a processor
 * id. Both carry a bound `tenant_id` predicate on every tenant table (D-029).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const { SHAPE_TENANT: T, gateViolations, tenantScopedTables } = await import(
  '../../../helpers/tenant-sql-shape'
);
const { makeDrizzleRefundsRepo } = await import(
  '@/modules/payments/infrastructure/repos/drizzle-refunds-repo'
);
const { proveNoProcessorRefund } = await import(
  '@/modules/payments/domain/settlement/money-moved'
);

describe('refunds repo — orphan sweep statements are tenant-fenced (#50)', () => {
  it('listPendingOlderThan joins payments for the payment intent, fenced on both tables', async () => {
    rec.statements.length = 0;
    const rows = await makeDrizzleRefundsRepo(T).listPendingOlderThan(
      rec.db,
      T,
      new Date('2026-05-14T03:14:22.456Z'),
    );
    expect(rows).toEqual([]);
    expect(rec.statements).toHaveLength(1);
    const sql = rec.statements[0]!.sql;
    expect(sql).toMatch(/from "refunds"/i);
    expect(sql).toMatch(/join "payments"/i);
    expect(sql).toMatch(/"payments"\."processor_payment_intent_id"/i);
    // The environment the payment was taken in, checked against the current
    // settings before Stripe's answer can close the row.
    expect(sql).toMatch(/"payments"\."processor_environment"/i);
    const { blind, violations } = gateViolations(rec.statements, tenantScopedTables());
    expect(blind).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('updateStatus with expectProcessorRefundIdNull adds `processor_refund_id is null`', async () => {
    rec.statements.length = 0;
    await makeDrizzleRefundsRepo(T)
      .updateStatus(rec.db, {
        refundId: 'rfnd_orphan',
        tenantId: T,
        nextStatus: 'failed',
        rejectionProof: proveNoProcessorRefund({
          complete: true,
          matchCount: 0,
          unmarkedCount: 0,
          rowAgeMs: 24 * 60 * 60 * 1000,
        })!,
        failureReasonCode: 'no_processor_refund',
        completedAt: new Date('2026-05-14T03:14:22.456Z'),
        expectedCurrentStatus: 'pending',
        expectProcessorRefundIdNull: true,
      })
      .catch(() => null);
    const sql = rec.statements[0]!.sql;
    expect(sql).toMatch(/^update "refunds"/i);
    expect(sql).toMatch(/"refunds"\."processor_refund_id" is null/i);
    const { blind, violations } = gateViolations(rec.statements, tenantScopedTables());
    expect(blind).toEqual([]);
    expect(violations).toEqual([]);
  });
});
