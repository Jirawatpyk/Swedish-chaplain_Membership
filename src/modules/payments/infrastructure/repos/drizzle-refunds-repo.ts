/**
 * T109 — Drizzle refunds repo (F5 / Phase 6).
 *
 * Implements `RefundsRepo` (Application port). Mirrors the pattern of
 * `drizzle-payments-repo.ts`: every tenant-scoped query runs inside
 * `runInTenant(ctx, fn)` so RLS + FORCE enforces tenant isolation
 * even on paths that forget an explicit WHERE filter.
 *
 * Key design choice — `getRefundContextForUpdate` (E3 win, review
 * 2026-04-26): the previous trio of `countPendingForPayment` +
 * `sumSucceededForPayment` + `nextRefundSeq` collapsed into ONE
 * SELECT inside the FOR UPDATE lock window. Aggregates over the same
 * `(tenant_id, payment_id)` partition (covered by index
 * `refunds_tenant_payment_status_idx` from migration 0034), so a
 * single index scan returns all three values.
 *
 * Domain ↔ Drizzle mapping lives here; Drizzle-inferred row types
 * MUST NOT leak into Application or Domain (Constitution Principle
 * III). The use-case calls these methods only through the port.
 */
import { and, eq, sql } from 'drizzle-orm';
import type {
  RefundsRepo,
  RefundRow as DomainRefundRow,
  RefundStatus,
} from '../../application/ports/refunds-repo';
import { asPaymentId, type PaymentId } from '../../domain/payment';
import { refunds, type RefundRow } from '../schema';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';

function toDomain(row: RefundRow): DomainRefundRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    paymentId: asPaymentId(row.paymentId),
    invoiceId: row.invoiceId,
    amountSatang: BigInt(row.amountSatang as unknown as string),
    status: row.status as RefundStatus,
    processorRefundId: row.processorRefundId,
  };
}

export function makeDrizzleRefundsRepo(tenantId: string): RefundsRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async insert(txUnknown, input): Promise<DomainRefundRow> {
      const tx = txUnknown as TenantTx;
      const [inserted] = await tx
        .insert(refunds)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          paymentId: input.paymentId,
          invoiceId: input.invoiceId,
          amountSatang: input.amountSatang,
          reason: input.reason,
          status: input.status,
          processorRefundId: input.processorRefundId,
          initiatorUserId: input.initiatorUserId,
          correlationId: input.correlationId,
          initiatedAt: input.initiatedAt,
        })
        .returning();
      if (!inserted) {
        // I4: structured pino warn before throw
        // so ops can correlate the failure via correlationId. Full
        // Result-return migration (port signature change) deferred
        // — current callers `withTx` rolls back on throw, which is
        // acceptable for an unexpected-no-row case.
        logger.warn(
          {
            tenantId: input.tenantId,
            paymentId: input.paymentId,
            refundId: input.id,
            correlationId: input.correlationId,
          },
          'drizzle-refunds-repo.insert.no_row_returned',
        );
        throw new Error('drizzle-refunds-repo: insert returned no row');
      }
      return toDomain(inserted as RefundRow);
    },

    async updateStatus(txUnknown, input): Promise<DomainRefundRow> {
      const tx = txUnknown as TenantTx;
      // Typed partial-row so column-name keys are checked against
      // Drizzle's inferred shape (catches typos like `creditNote_id`
      // at compile time). `updatedAt` uses a server-side `now()`
      // SQL expression — built separately and merged below for the
      // same reason as `drizzle-payments-repo.updateStatus`.
      const patch: Partial<typeof refunds.$inferInsert> = {
        status: input.nextStatus,
        completedAt: input.completedAt,
      };
      if (input.processorRefundId !== undefined) {
        patch.processorRefundId = input.processorRefundId;
      }
      if (input.failureReasonCode !== undefined) {
        patch.failureReasonCode = input.failureReasonCode;
      }
      if (input.creditNoteId !== undefined) {
        patch.creditNoteId = input.creditNoteId;
      }

      const [updated] = await tx
        .update(refunds)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(refunds.tenantId, input.tenantId),
            eq(refunds.id, input.refundId),
          ),
        )
        .returning();
      if (!updated) {
        // I4: structured pino warn before throw.
        logger.warn(
          {
            tenantId: input.tenantId,
            refundId: input.refundId,
            nextStatus: input.nextStatus,
          },
          'drizzle-refunds-repo.updateStatus.zero_rows',
        );
        throw new Error(
          `drizzle-refunds-repo: updateStatus matched zero rows for ${input.refundId}`,
        );
      }
      return toDomain(updated as RefundRow);
    },

    async findByProcessorRefundId(
      txUnknown,
      tenantIdArg: string,
      processorRefundId: string,
    ): Promise<DomainRefundRow | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(refunds)
        .where(
          and(
            eq(refunds.tenantId, tenantIdArg),
            eq(refunds.processorRefundId, processorRefundId),
          ),
        )
        .limit(1);
      return row ? toDomain(row as RefundRow) : null;
    },

    async listPendingOlderThan(
      txUnknown,
      tenantIdArg: string,
      cutoff: Date,
    ): Promise<
      ReadonlyArray<{
        readonly id: string;
        readonly paymentId: PaymentId;
        readonly invoiceId: string;
        readonly amountSatang: bigint;
        readonly initiatedAt: Date;
        readonly correlationId: string;
        readonly initiatorUserId: string;
      }>
    > {
      const tx = txUnknown as TenantTx;
      const rows = await tx
        .select({
          id: refunds.id,
          paymentId: refunds.paymentId,
          invoiceId: refunds.invoiceId,
          amountSatang: refunds.amountSatang,
          initiatedAt: refunds.initiatedAt,
          correlationId: refunds.correlationId,
          initiatorUserId: refunds.initiatorUserId,
        })
        .from(refunds)
        .where(
          and(
            eq(refunds.tenantId, tenantIdArg),
            eq(refunds.status, 'pending'),
            sql`${refunds.initiatedAt} < ${cutoff.toISOString()}`,
          ),
        )
        .limit(100); // bounded sweep — repeat call drains the rest
      return rows.map((r) => ({
        id: r.id,
        paymentId: asPaymentId(r.paymentId),
        invoiceId: r.invoiceId,
        amountSatang: BigInt(r.amountSatang as unknown as string),
        initiatedAt: r.initiatedAt,
        correlationId: r.correlationId,
        initiatorUserId: r.initiatorUserId,
      }));
    },

    async getRefundContextForUpdate(
      txUnknown,
      tenantIdArg: string,
      paymentId: PaymentId,
    ): Promise<{
      readonly pendingCount: number;
      readonly succeededSumSatang: bigint;
      readonly nextSeq: number;
    }> {
      const tx = txUnknown as TenantTx;
      // Single index scan over `refunds_tenant_payment_status_idx`
      // returns all three aggregates the use-case needs inside the
      // payment-row FOR UPDATE lock. Saves 2 roundtrips per refund
      // initiation.
      //
      // FILTER (WHERE …) is the standard SQL idiom for conditional
      // aggregates; Postgres optimises this into a single pass.
      // `COALESCE(SUM(...), 0)` guards the empty-partition case
      // where SUM returns NULL.
      // Drizzle + postgres.js returns COUNT/SUM as JS strings (BIGINT-
      // safe). Coerce to Number/BigInt at the boundary; matches the
      // pattern in `drizzle-payments-repo.nextAttemptSeq`.
      const rows = (await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')                      AS pending_count,
          COALESCE(SUM(amount_satang) FILTER (WHERE status = 'succeeded'), 0) AS succeeded_sum_satang,
          COUNT(*)                                                         AS total_count
        FROM refunds
        WHERE tenant_id = ${tenantIdArg}
          AND payment_id = ${paymentId}
      `)) as unknown as Array<{
        pending_count: number | string;
        succeeded_sum_satang: number | string;
        total_count: number | string;
      }>;
      const row = rows[0];
      return {
        pendingCount: Number(row?.pending_count ?? 0),
        succeededSumSatang: BigInt(row?.succeeded_sum_satang ?? 0),
        nextSeq: Number(row?.total_count ?? 0) + 1,
      };
    },
  };
}

/**
 * Convenience for callers that wrap their own `runInTenant` — the
 * `withTx` callback receives the tx that this repo accepts as
 * `txUnknown`. Use cases own the tx boundary; the repo never opens
 * its own. This re-exports the tenant-scoped `runInTenant` for
 * tests + composition roots that need to drive the repo directly.
 */
export { runInTenant as _runInTenantForRefundsRepo };
