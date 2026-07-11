/**
 * Drizzle payments repo (F5).
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
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { asSatang, type Satang } from '@/lib/money';
import type { PaymentsRepo, RefundActivityDto } from '../../application/ports/payments-repo';
import {
  asPaymentId,
  PAYMENT_STATUSES,
  type Payment,
  type PaymentId,
  type PaymentStatus,
  type CardMetadata,
} from '../../domain/payment';
import {
  PAYMENT_METHODS,
  type PaymentMethod,
} from '../../domain/value-objects/payment-method';
import { REFUND_STATUSES, type RefundStatus } from '../../domain/refund';
import { payments, refunds, type PaymentRow, type RefundRow } from '../schema';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

// H-9 (review 2026-04-27): narrow guards before mapping DB enums into
// Domain. A migration gap, manual SQL patch, or test fixture typo
// returning an out-of-band value would otherwise silently advance the
// Payment state machine. Throwing here is intentional — it surfaces
// the data corruption at read time instead of leaving the aggregate
// in an unrepresentable state.
function assertPaymentStatus(s: string, rowId: string): PaymentStatus {
  if ((PAYMENT_STATUSES as readonly string[]).includes(s)) return s as PaymentStatus;
  throw new Error(`drizzle-payments-repo: unknown payment status '${s}' on row ${rowId}`);
}

function assertPaymentMethod(s: string, rowId: string): PaymentMethod {
  if ((PAYMENT_METHODS as readonly string[]).includes(s)) return s as PaymentMethod;
  throw new Error(`drizzle-payments-repo: unknown payment method '${s}' on row ${rowId}`);
}

function assertProcessorEnv(s: string, rowId: string): 'test' | 'live' {
  if (s === 'test' || s === 'live') return s;
  throw new Error(`drizzle-payments-repo: unknown processor env '${s}' on row ${rowId}`);
}

function assertRefundStatus(s: string, rowId: string): RefundStatus {
  if ((REFUND_STATUSES as readonly string[]).includes(s)) return s as RefundStatus;
  throw new Error(`drizzle-payments-repo: unknown refund status '${s}' on row ${rowId}`);
}

// H-10 (review 2026-04-27): explicit runtime check for `bigint` mode.
// Drizzle's `bigint('mode': 'bigint')` should return native bigint, but
// pg drivers historically returned strings; the previous double-cast
// silently truncated values >2^53 if the driver returned `number`.
//
// F5R3 H-5 (2026-05-16) — return type tightened to branded `Satang`.
// `asSatang` validates non-negative at the DB→Domain boundary; if
// the DB ever returns a negative money value (impossible per
// invariants) the trap is here, not propagated upstream.
function toBigintSatang(raw: unknown, rowId: string): Satang {
  let value: bigint;
  if (typeof raw === 'bigint') value = raw;
  else if (typeof raw === 'string' || typeof raw === 'number') value = BigInt(raw);
  else {
    throw new Error(
      `drizzle-payments-repo: unexpected amount_satang type '${typeof raw}' on row ${rowId}`,
    );
  }
  return asSatang(value);
}

function rowToRefundActivity(row: RefundRow): RefundActivityDto {
  return {
    refundId: row.id,
    paymentId: row.paymentId,
    invoiceId: row.invoiceId,
    status: assertRefundStatus(row.status, row.id),
    amountSatang: toBigintSatang(row.amountSatang, row.id),
    reason: row.reason,
    initiatedAt: row.initiatedAt,
    completedAt: row.completedAt,
    initiatorUserId: row.initiatorUserId,
    processorRefundId: row.processorRefundId,
    failureReasonCode: row.failureReasonCode,
    creditNoteId: row.creditNoteId,
  };
}

function toDomain(row: PaymentRow): Payment {
  // Card metadata triage:
  //   - method='promptpay' → card MUST be null
  //   - method='card' + all four NULL → pre-webhook pending; card=null
  //   - method='card' + any set → all four MUST be set (DB CHECK guarantees)
  const method = assertPaymentMethod(row.method, row.id);
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
    status: assertPaymentStatus(row.status, row.id),
    amountSatang: toBigintSatang(row.amountSatang, row.id),
    currency: 'THB',
    processorPaymentIntentId: row.processorPaymentIntentId,
    processorChargeId: row.processorChargeId,
    processorEnvironment: assertProcessorEnv(row.processorEnvironment, row.id),
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

    async acquireInitiateLock(
      txUnknown,
      tenantIdArg: string,
      invoiceId: string,
    ): Promise<void> {
      const tx = txUnknown as TenantTx;
      // pg_advisory_xact_lock(bigint) auto-releases at tx end.
      // hashtextextended is deterministic; using
      // `payments:{tenantId}:{invoiceId}` namespace prefix (R3 M-3 rel
      // 2026-04-28) produces a per-(tenant,invoice) lock channel
      // without colliding with future advisory locks (e.g. F4's
      // `invoicing:` prefix, post-MVP `members:` etc.).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('payments:' || ${tenantIdArg} || ':' || ${invoiceId}, 0))`,
      );
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
      tenantIdArg: string,
    ): Promise<Payment | null> {
      // CR-2 + R3 M-4 (2026-04-27/28): explicit `tenantId` parameter on
      // the port (was factory-closure-bound only). Constitution
      // Principle I requires two-layer isolation; making the contract
      // explicit at the type level surfaces the requirement to all
      // implementers (mocks, future repos). At runtime the factory
      // closure `tenantId` is also asserted equal to the arg as a
      // defence-in-depth check.
      if (tenantIdArg !== tenantId) {
        throw new Error(
          `drizzle-payments-repo.lockForUpdateByPaymentIntentId: tenantId arg ('${tenantIdArg}') does not match factory tenantId — RLS context drift`,
        );
      }
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, tenantIdArg),
            eq(payments.processorPaymentIntentId, paymentIntentId),
          ),
        )
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

    async updateStatus(txUnknown, input): Promise<Payment | null> {
      const tx = txUnknown as TenantTx;
      // Audit 2026-04-25 finding #4: typed partial-row instead of
      // `Record<string, unknown>` so column-name keys are type-checked
      // against Drizzle's inferred shape. Catches typos like
      // `cardLast` (missing 4) at compile time. `updatedAt` uses a
      // server-side `now()` SQL expression — drizzle-orm allows
      // `SQL<unknown>` as a value at the update site, but the inferred
      // insert type has the column typed as `Date`, so the value is
      // built separately and merged below.
      const patch: Partial<typeof payments.$inferInsert> = {
        status: input.nextStatus,
        completedAt: input.completedAt,
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

      // F5R2-CRIT-1 defence-in-depth: when the caller passes
      // `expectedCurrentStatus`, append a `status = expected` predicate
      // to the WHERE so a concurrent webhook flip (e.g., pending →
      // succeeded between the caller's lockForUpdate and this update)
      // makes the UPDATE match zero rows. The adapter returns `null`
      // and the caller decides the recovery path (idempotent ack /
      // forensic audit / retry). When omitted, throw-on-zero is kept
      // for backward compatibility with sites that re-check under
      // their own lock.
      const whereClauses = [
        eq(payments.tenantId, input.tenantId),
        eq(payments.id, input.paymentId),
      ];
      if (input.expectedCurrentStatus !== undefined) {
        whereClauses.push(eq(payments.status, input.expectedCurrentStatus));
      }
      const [updated] = await tx
        .update(payments)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(and(...whereClauses))
        .returning();
      if (!updated) {
        if (input.expectedCurrentStatus !== undefined) {
          // Race detected — caller will resolve.
          return null;
        }
        throw new Error(
          `drizzle-payments-repo: updateStatus matched zero rows for ${input.paymentId}`,
        );
      }
      return toDomain(updated as PaymentRow);
    },

    /**
     * A.13 (#3 / CRITICAL-2) — flip a stuck-pending payment to the
     * terminal `auto_refunded` status + durable marker, guarded on the
     * row still being `pending`. See the port docstring for the full
     * contract. Threads the caller's `tx` (never the pool-global `db`)
     * so the flip commits atomically with the caller's audit +
     * markProcessed under the same RLS context.
     *
     * The `WHERE status = 'pending'` predicate is the
     * `expectedCurrentStatus`-style guard: zero rows matched → a
     * concurrent writer already terminalised the row → return `null`
     * (mirrors `updateStatus`'s null-return). `completed_at` is set to
     * satisfy `payments_completed_at_iff_not_pending` (migration 0033);
     * card metadata is deliberately left NULL-safe (migration 0240
     * relaxed the card CHECK for `auto_refunded`).
     */
    async markAutoRefunded(txUnknown, input): Promise<Payment | null> {
      const tx = txUnknown as TenantTx;
      const [updated] = await tx
        .update(payments)
        .set({
          status: 'auto_refunded',
          completedAt: input.completedAt,
          autoRefundProcessorRefundId: input.processorRefundId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(payments.tenantId, input.tenantId),
            eq(payments.id, input.paymentId),
            eq(payments.status, 'pending'),
          ),
        )
        .returning();
      // Guard miss (row already terminalised by a concurrent writer) →
      // null. Unlike `updateStatus`, there is no throw-on-zero fallback:
      // this method is ALWAYS the guarded form (the pending→auto_refunded
      // edge is only ever driven from a Phase-A-observed pending row).
      return updated ? toDomain(updated as PaymentRow) : null;
    },

    /**
     * A.15 (#8 resume-race) — status-PRESERVING durable marker write on a
     * terminal `failed` row. See the port docstring for the full contract
     * + F-9 rationale. Threads the caller's `tx` (never the pool-global
     * `db`) so the marker commits atomically with the caller's forensic
     * audit + markProcessed under the same RLS context.
     *
     * Guard `status = 'failed' AND auto_refund_processor_refund_id IS NULL`:
     * `status` is left untouched (no `failed → auto_refunded` edge — F-9),
     * `completed_at` is untouched (the failed row already satisfies migration
     * 0033's `payments_completed_at_iff_not_pending`), and the `IS NULL`
     * predicate makes a Stripe retry a no-op. Zero rows matched → `null`
     * (concurrent status change OR marker already present).
     */
    async attachAutoRefundMarkerOnFailed(txUnknown, input): Promise<Payment | null> {
      const tx = txUnknown as TenantTx;
      const [updated] = await tx
        .update(payments)
        .set({
          autoRefundProcessorRefundId: input.processorRefundId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(payments.tenantId, input.tenantId),
            eq(payments.id, input.paymentId),
            eq(payments.status, 'failed'),
            isNull(payments.autoRefundProcessorRefundId),
          ),
        )
        .returning();
      return updated ? toDomain(updated as PaymentRow) : null;
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
      // R3 M-3 (2026-04-28): assertPaymentStatus on every status read
      // — consistent with the H-9 boundary-guard design at line ~39.
      // A corrupted status string would otherwise pass directly to
      // `enforceOneSucceededPerInvoice` without detection.
      return rows.map((r) => assertPaymentStatus(r.status, 'sibling'));
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
      `)) as unknown as Array<{ max_seq: number | string }>;
      // Drizzle + postgres.js normally returns `int` columns as JS numbers,
      // but defensive `Number()` cast guards against the bigint/string
      // fallback path some driver versions emit (Drizzle-reviewer
      // follow-up #4, 2026-04-24) — without this, a string "0" would
      // silently concatenate with `+ 1` to become "01" (JS string semantics).
      const current = Number(rows[0]?.max_seq ?? 0);
      return current + 1;
    },

    async listInvoiceActivity(
      tenantIdArg: string,
      invoiceId: string,
    ): Promise<{
      readonly payments: readonly Payment[];
      readonly refunds: readonly RefundActivityDto[];
    }> {
      return runInTenant(ctx, async (tx) => {
        const paymentRows = (await tx
          .select()
          .from(payments)
          .where(
            and(
              eq(payments.tenantId, tenantIdArg),
              eq(payments.invoiceId, invoiceId),
            ),
          )
          .orderBy(asc(payments.initiatedAt))) as PaymentRow[];

        const paymentIds = paymentRows.map((r) => r.id);
        let refundRows: RefundRow[] = [];
        if (paymentIds.length > 0) {
          refundRows = (await tx
            .select()
            .from(refunds)
            .where(
              and(
                eq(refunds.tenantId, tenantIdArg),
                eq(refunds.invoiceId, invoiceId),
              ),
            )
            .orderBy(asc(refunds.initiatedAt))) as RefundRow[];
        }

        return {
          payments: paymentRows.map((r) => toDomain(r)),
          refunds: refundRows.map((r) => rowToRefundActivity(r)),
        };
      });
    },

    async listSucceededMethodByInvoiceIds(
      tenantIdArg: string,
      invoiceIds: readonly string[],
    ): Promise<ReadonlyMap<string, PaymentMethod>> {
      if (invoiceIds.length === 0) {
        return new Map<string, PaymentMethod>();
      }
      return runInTenant(ctx, async (tx) => {
        // DISTINCT ON (invoice_id) ORDER BY completed_at DESC picks the
        // latest succeeded payment per invoice. The
        // one-succeeded-per-invoice invariant typically guarantees
        // single-row, but this ordering survives historical lineage
        // (refund + re-attempt). Tenant scoping comes from RLS first;
        // the explicit `tenant_id =` clause is defence-in-depth.
        const rows = (await tx.execute(sql`
          SELECT DISTINCT ON (invoice_id) invoice_id, method
            FROM payments
           WHERE tenant_id = ${tenantIdArg}
             AND status = 'succeeded'
             AND invoice_id IN (${sql.join(
               invoiceIds.map((id) => sql`${id}`),
               sql`, `,
             )})
           ORDER BY invoice_id, completed_at DESC
        `)) as unknown as Array<{ invoice_id: string; method: PaymentMethod }>;
        const result = new Map<string, PaymentMethod>();
        for (const row of rows) {
          result.set(row.invoice_id, row.method);
        }
        return result;
      });
    },

    /**
     * H-8 — read the most-recent auto-refund audit row for this
     * invoice (member-portal display lookup, keyed by invoiceId).
     * Tenant scoping comes from the factory-bound `ctx` (RLS+FORCE) —
     * defence-in-depth WHERE on `tenant_id` mirrors
     * `lockForUpdateByPaymentIntentId` (line 188).
     *
     * PERMANENT — retained for its live caller (member-portal invoice
     * detail page). See the port docstring
     * (`src/modules/payments/application/ports/payments-repo.ts`) for
     * why this is not superseded by `findAutoRefundByProcessorRefundId`
     * below.
     */
    async findStaleInvoiceAutoRefund(
      invoiceId: string,
    ): Promise<{ readonly processorRefundId: string | null } | null> {
      return runInTenant(ctx, async (tx) => {
        const result = await tx.execute(sql`
          SELECT payload->>'processor_refund_id' AS processor_refund_id
            FROM audit_log
           WHERE tenant_id = ${tenantId}
             AND event_type = 'payment_auto_refunded_stale_invoice'
             AND payload->>'invoice_id' = ${invoiceId}
           ORDER BY timestamp DESC
           LIMIT 1
        `);
        const rows = Array.from(
          result as unknown as Iterable<{ processor_refund_id: string | null }>,
        );
        if (rows.length === 0) return null;
        return { processorRefundId: rows[0]!.processor_refund_id };
      });
    },

    /**
     * A.6 — durable auto-refund lookup (migration 0240 column) for
     * the webhook reconcile path, keyed by `processorRefundId`. See
     * the port docstring for why this is a separate, permanent lookup
     * from `findStaleInvoiceAutoRefund` above rather than a
     * replacement for it (different key, different purpose). Explicit
     * `tx` param — callers run this inside their own
     * webhook-reconciliation tx. Defence-in-depth `tenant_id =` WHERE
     * mirrors the rest of this file; RLS is the primary backstop.
     */
    async findAutoRefundByProcessorRefundId(
      txUnknown,
      tenantIdArg: string,
      processorRefundId: string,
    ): Promise<{ readonly paymentId: PaymentId; readonly invoiceId: string } | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select({ id: payments.id, invoiceId: payments.invoiceId })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, tenantIdArg),
            eq(payments.autoRefundProcessorRefundId, processorRefundId),
          ),
        )
        .limit(1);
      return row ? { paymentId: asPaymentId(row.id), invoiceId: row.invoiceId } : null;
    },
  };
}
