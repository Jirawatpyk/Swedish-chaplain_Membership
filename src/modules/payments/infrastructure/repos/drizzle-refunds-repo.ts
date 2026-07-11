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
import { asSatang, type Satang } from '@/lib/money';
import type {
  RefundsRepo,
  RefundRow as DomainRefundRow,
  RefundStatus,
} from '../../application/ports/refunds-repo';
import { asPaymentId, type PaymentId } from '../../domain/payment';
import { asRefundId, REFUND_STATUSES, type Refund } from '../../domain/refund';
import { refunds, type RefundRow } from '../schema';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';

// H-9 / H-10 (review 2026-04-27): defensive boundary guards mirroring
// `drizzle-payments-repo.ts`. Out-of-band enum values throw at the
// mapping seam rather than silently producing an invalid aggregate.
function assertRefundStatus(s: string, rowId: string): RefundStatus {
  if ((REFUND_STATUSES as readonly string[]).includes(s)) return s as RefundStatus;
  throw new Error(`drizzle-refunds-repo: unknown refund status '${s}' on row ${rowId}`);
}

// F5R3 H-5 (2026-05-16) — return `Satang` brand at DB→Domain boundary.
function toBigintSatang(raw: unknown, rowId: string): Satang {
  let value: bigint;
  if (typeof raw === 'bigint') value = raw;
  else if (typeof raw === 'string' || typeof raw === 'number') value = BigInt(raw);
  else {
    throw new Error(
      `drizzle-refunds-repo: unexpected amount_satang type '${typeof raw}' on row ${rowId}`,
    );
  }
  return asSatang(value);
}

function toDomain(row: RefundRow): DomainRefundRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    paymentId: asPaymentId(row.paymentId),
    invoiceId: row.invoiceId,
    amountSatang: toBigintSatang(row.amountSatang, row.id),
    status: assertRefundStatus(row.status, row.id),
    processorRefundId: row.processorRefundId,
  };
}

// A.6 — full Domain `Refund` aggregate mapping (distinct from the
// port's slim `RefundRow` DTO above). Used by
// `lockForUpdateByProcessorRefundId`, whose caller (the webhook
// reconcile use-case) needs every state-machine-relevant field.
function toRefundDomain(row: RefundRow): Refund {
  return {
    id: asRefundId(row.id),
    tenantId: row.tenantId,
    paymentId: asPaymentId(row.paymentId),
    invoiceId: row.invoiceId,
    amountSatang: toBigintSatang(row.amountSatang, row.id),
    reason: row.reason,
    status: assertRefundStatus(row.status, row.id),
    processorRefundId: row.processorRefundId,
    failureReasonCode: row.failureReasonCode,
    creditNoteId: row.creditNoteId,
    initiatedAt: row.initiatedAt,
    completedAt: row.completedAt,
    initiatorUserId: row.initiatorUserId,
    correlationId: row.correlationId,
  };
}

export function makeDrizzleRefundsRepo(_tenantId: string): RefundsRepo {
  // tenantId currently unused — every method receives `tx` from its
  // caller's `runInTenant` scope, RLS+FORCE handles isolation. Kept
  // in the factory signature for symmetry with `makeDrizzlePaymentsRepo`
  // (DI wiring stays uniform). Reintroduce `asTenantContext(tenantId)`
  // when a standalone read path is added.
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

    async updateStatus(txUnknown, input): Promise<DomainRefundRow | null> {
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

      const whereClauses = [
        eq(refunds.tenantId, input.tenantId),
        eq(refunds.id, input.refundId),
      ];
      // Optimistic concurrency guard (RR-1 / H-b) — when the caller
      // passes `expectedCurrentStatus` (e.g. the sweep's `'pending'`),
      // append a `status = expected` predicate so a row already
      // finalised by a different writer (delayed webhook charge.refunded
      // / issueRefund Phase B) matches ZERO rows. In that case the
      // adapter returns `null` (mirrors `drizzle-payments-repo.updateStatus`)
      // and the caller decides the recovery path — the sweep re-throws a
      // sentinel so its per-row tx rolls back and NO
      // `stale_pending_refund_detected` audit commits. When
      // `expectedCurrentStatus` is omitted, throw-on-zero is preserved
      // for callers that re-check under their own lock.
      if (input.expectedCurrentStatus !== undefined) {
        whereClauses.push(eq(refunds.status, input.expectedCurrentStatus));
      }
      const [updated] = await tx
        .update(refunds)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(and(...whereClauses))
        .returning();
      if (!updated) {
        if (input.expectedCurrentStatus !== undefined) {
          // Optimistic-concurrency race — the row is no longer in the
          // expected status. Return null so the caller resolves it
          // (idempotent skip / forensic audit / retry). No warn: this
          // is an expected, benign lost-race outcome, not a fault.
          return null;
        }
        // I4: structured pino warn before throw (unexpected zero-match
        // on a plain update — a genuine invariant breach worth alerting).
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

    async attachProcessorRefundId(txUnknown, input): Promise<void> {
      const tx = txUnknown as TenantTx;
      // Narrow write — ONLY `processor_refund_id` changes; `status`
      // and `completed_at` are untouched, which is why this method
      // does not accept `nextStatus`/`completedAt` inputs the way
      // `updateStatus` does. See the port docstring for the
      // CHECK-safety argument (refunds_succeeded_iff_complete stays
      // false=false while status remains 'pending').
      const [updated] = await tx
        .update(refunds)
        .set({ processorRefundId: input.processorRefundId, updatedAt: sql`now()` })
        .where(and(eq(refunds.tenantId, input.tenantId), eq(refunds.id, input.refundId)))
        .returning({ id: refunds.id });
      if (!updated) {
        logger.warn(
          { tenantId: input.tenantId, refundId: input.refundId },
          'drizzle-refunds-repo.attachProcessorRefundId.zero_rows',
        );
        throw new Error(
          `drizzle-refunds-repo: attachProcessorRefundId matched zero rows for ${input.refundId}`,
        );
      }
    },

    async lockForUpdateByProcessorRefundId(
      txUnknown,
      tenantIdArg: string,
      processorRefundId: string,
    ): Promise<Refund | null> {
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
        // A.18 fix — `FOR NO KEY UPDATE`, NOT `FOR UPDATE`. Both webhook
        // callers (`processRefundUpdated`, `sweepStalePendingRefunds`) hold this
        // lock across `finalizeSucceededRefund`, whose F4 bridge
        // (`issueCreditNoteFromRefund`) runs in a SEPARATE tx/connection and
        // INSERTs a `credit_notes` row with `source_refund_id → refunds.id`.
        // That FK check acquires `FOR KEY SHARE` on THIS row — which conflicts
        // with `FOR UPDATE` but NOT with `FOR NO KEY UPDATE`. Under `FOR UPDATE`
        // the CN insert blocked on the lock held by the caller's own idle-in-tx
        // connection: an undetectable cross-connection hang (Postgres deadlock
        // detection can't see it — the lock holder isn't waiting on a DB lock),
        // so the async refund never got a credit note. `FOR NO KEY UPDATE` still
        // conflicts with itself + `FOR UPDATE` + `FOR SHARE` + DELETE, so
        // concurrent reconcilers still serialise (the intended guarantee); it is
        // the correct strength because the reconciler mutates only non-key
        // columns (status / credit_note_id / processor_refund_id / completed_at),
        // never the PK. (Live-Neon repro: A.18 diagnostic; see task report.)
        .for('no key update')
        .limit(1);
      return row ? toRefundDomain(row as RefundRow) : null;
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
        readonly amountSatang: Satang;
        readonly initiatedAt: Date;
        readonly correlationId: string;
        readonly initiatorUserId: string;
        readonly processorRefundId: string | null;
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
          // A.14 — Stripe `re_…` id (nullable) so the sweep can
          // `retrieveRefund` the real outcome instead of blind-failing.
          processorRefundId: refunds.processorRefundId,
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
      // Surface cap-hit so ops can manually re-trigger via
      // `?olderThanHours=N` for faster drain when a real outage
      // produces > 100 stale rows in one tenant.
      if (rows.length === 100) {
        logger.warn(
          { tenantId: tenantIdArg, cap: 100 },
          'refunds.list_pending_older_than.cap_hit',
        );
      }
      return rows.map((r) => ({
        id: r.id,
        paymentId: asPaymentId(r.paymentId),
        invoiceId: r.invoiceId,
        amountSatang: toBigintSatang(r.amountSatang, r.id),
        initiatedAt: r.initiatedAt,
        correlationId: r.correlationId,
        initiatorUserId: r.initiatorUserId,
        processorRefundId: r.processorRefundId,
      }));
    },

    async getRefundContextForUpdate(
      txUnknown,
      tenantIdArg: string,
      paymentId: PaymentId,
    ): Promise<{
      readonly pendingCount: number;
      readonly succeededSumSatang: Satang;
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
        succeededSumSatang: asSatang(BigInt(row?.succeeded_sum_satang ?? 0)),
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
