/**
 * T061 — Drizzle payments repo (F5).
 *
 * Implements `PaymentsRepo` (Application port). Mirrors F4's
 * `drizzle-invoice-repo.ts` shape: every tenant-scoped query runs
 * inside `runInTenant(ctx, fn)` so RLS + FORCE enforces tenant
 * isolation even on paths that forget an explicit WHERE filter.
 *
 * D-01 (2026-04-24): `findPendingByInvoiceAndActor` accepts an
 * optional `tx` so `initiatePayment` can run the resume-lookup
 * inside its serializable snapshot. Without the tx arg, this repo
 * opens its own `runInTenant` read tx (safe — still under RLS).
 *
 * Domain ↔ Drizzle mapping lives here; Drizzle-inferred row types
 * MUST NOT leak into Application or Domain (Constitution Principle
 * III). The `toDomain` helper owns the card-metadata null triage
 * (promptpay → null; card+pending+all-NULL → null; otherwise full VO).
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PaymentsRepo } from '../../application/ports/payments-repo';
import {
  asPaymentId,
  type Payment,
  type PaymentId,
  type PaymentStatus,
  type CardMetadata,
} from '../../domain/payment';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';
import { payments, type PaymentRow } from '../schema';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function toDomain(row: PaymentRow): Payment {
  // Card metadata triage:
  //   - method='promptpay' → card MUST be null
  //   - method='card' + all four NULL → pre-webhook pending; card=null
  //   - method='card' + any set → all four MUST be set (DB CHECK guarantees)
  const method = row.method as PaymentMethod;
  let card: CardMetadata | null = null;
  if (method === 'card') {
    const hasAny =
      row.cardBrand !== null ||
      row.cardLast4 !== null ||
      row.cardExpMonth !== null ||
      row.cardExpYear !== null;
    if (hasAny) {
      if (
        row.cardBrand === null ||
        row.cardLast4 === null ||
        row.cardExpMonth === null ||
        row.cardExpYear === null
      ) {
        throw new Error(
          `drizzle-payments-repo: partial card metadata on row ${row.id}`,
        );
      }
      card = {
        brand: row.cardBrand,
        last4: row.cardLast4,
        expMonth: row.cardExpMonth,
        expYear: row.cardExpYear,
      };
    }
  }

  return {
    id: asPaymentId(row.id),
    tenantId: row.tenantId,
    invoiceId: row.invoiceId,
    memberId: row.memberId,
    method,
    status: row.status as PaymentStatus,
    amountSatang: BigInt(row.amountSatang as unknown as string),
    currency: 'THB',
    processorPaymentIntentId: row.processorPaymentIntentId,
    processorChargeId: row.processorChargeId,
    processorEnvironment: row.processorEnvironment as 'test' | 'live',
    attemptSeq: row.attemptSeq,
    card,
    failureReasonCode: row.failureReasonCode,
    initiatedAt: row.initiatedAt,
    completedAt: row.completedAt,
    actorUserId: row.actorUserId,
    correlationId: row.correlationId,
  };
}

export function makeDrizzlePaymentsRepo(tenantId: string): PaymentsRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return runInTenant(ctx, async (tx) => fn(tx));
    },

    async lockForUpdate(
      txUnknown,
      paymentId: PaymentId,
      tenantIdArg: string,
    ): Promise<Payment | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, tenantIdArg), eq(payments.id, paymentId)))
        .for('update')
        .limit(1);
      return row ? toDomain(row as PaymentRow) : null;
    },

    async lockForUpdateByPaymentIntentId(
      txUnknown,
      paymentIntentId: string,
    ): Promise<Payment | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(payments)
        .where(eq(payments.processorPaymentIntentId, paymentIntentId))
        .for('update')
        .limit(1);
      return row ? toDomain(row as PaymentRow) : null;
    },

    async insert(txUnknown, input): Promise<Payment> {
      const tx = txUnknown as TenantTx;
      const [inserted] = await tx
        .insert(payments)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          memberId: input.memberId,
          method: input.method,
          status: 'pending',
          amountSatang: input.amountSatang,
          currency: 'THB',
          processorPaymentIntentId: input.processorPaymentIntentId,
          processorEnvironment: input.processorEnvironment,
          attemptSeq: input.attemptSeq,
          initiatedAt: input.initiatedAt,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
        })
        .returning();
      if (!inserted) throw new Error('drizzle-payments-repo: insert returned no row');
      return toDomain(inserted as PaymentRow);
    },

    async updateStatus(txUnknown, input): Promise<Payment> {
      const tx = txUnknown as TenantTx;
      const patch: Record<string, unknown> = {
        status: input.nextStatus,
        completedAt: input.completedAt,
        updatedAt: sql`now()`,
      };
      if (input.processorChargeId !== undefined) {
        patch.processorChargeId = input.processorChargeId;
      }
      if (input.failureReasonCode !== undefined) {
        patch.failureReasonCode = input.failureReasonCode;
      }
      if (input.card !== undefined) {
        if (input.card === null) {
          patch.cardBrand = null;
          patch.cardLast4 = null;
          patch.cardExpMonth = null;
          patch.cardExpYear = null;
        } else {
          patch.cardBrand = input.card.brand;
          patch.cardLast4 = input.card.last4;
          patch.cardExpMonth = input.card.expMonth;
          patch.cardExpYear = input.card.expYear;
        }
      }

      const [updated] = await tx
        .update(payments)
        .set(patch)
        .where(
          and(
            eq(payments.tenantId, input.tenantId),
            eq(payments.id, input.paymentId),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error(
          `drizzle-payments-repo: updateStatus matched zero rows for ${input.paymentId}`,
        );
      }
      return toDomain(updated as PaymentRow);
    },

    async findPendingByInvoiceAndActor(
      tenantIdArg: string,
      invoiceId: string,
      actorUserId: string,
      txUnknown?: unknown,
    ): Promise<Payment | null> {
      const query = async (tx: TenantTx): Promise<Payment | null> => {
        const [row] = await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.tenantId, tenantIdArg),
              eq(payments.invoiceId, invoiceId),
              eq(payments.actorUserId, actorUserId),
              eq(payments.status, 'pending'),
            ),
          )
          .limit(1);
        return row ? toDomain(row as PaymentRow) : null;
      };

      if (txUnknown !== undefined) {
        return query(txUnknown as TenantTx);
      }
      return runInTenant(ctx, query);
    },

    async listSiblingStatusesForInvariant(
      txUnknown,
      tenantIdArg: string,
      invoiceId: string,
      excludePaymentId: PaymentId,
    ): Promise<readonly PaymentStatus[]> {
      const tx = txUnknown as TenantTx;
      const rows = await tx
        .select({ status: payments.status })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, tenantIdArg),
            eq(payments.invoiceId, invoiceId),
            ne(payments.id, excludePaymentId),
          ),
        );
      return rows.map((r) => r.status as PaymentStatus);
    },

    async nextAttemptSeq(
      txUnknown,
      tenantIdArg: string,
      invoiceId: string,
    ): Promise<number> {
      const tx = txUnknown as TenantTx;
      const rows = (await tx.execute(sql`
        SELECT COALESCE(MAX(attempt_seq), 0)::int AS max_seq
          FROM payments
         WHERE tenant_id = ${tenantIdArg}
           AND invoice_id = ${invoiceId}
      `)) as unknown as Array<{ max_seq: number }>;
      const current = rows[0]?.max_seq ?? 0;
      return current + 1;
    },
  };
}
