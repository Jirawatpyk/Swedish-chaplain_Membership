/**
 * F8 Phase 3 Wave H1 · T061 — F8 → F4 cross-module bridge.
 *
 * Composes the F4 barrel exports (`createInvoiceDraft` →
 * `issueInvoice` → `recordPayment`) into a single `issueAndMarkPaid`
 * call surface for F8's `mark-paid-offline` use-case.
 *
 * Atomicity boundary (research.md R12 + Wave A T008 + plan.md):
 *   - `createInvoiceDraft` and `issueInvoice` open their own internal
 *     `withTx` transactions — they must commit BEFORE we can record
 *     a payment against the resulting invoice id.
 *   - `recordPayment` is the atomic frontier: it accepts an
 *     `externalTx` via `makeRecordPaymentDeps(tenantId, externalTx,
 *     onPaidCallbacks)`. The caller (F8 use-case) opens an outer
 *     `runInTenant(ctx, tx => …)` block and threads `tx` into the
 *     bridge so the F4 invoice flip `issued → paid` AND the F8
 *     callback that flips `renewal_cycles.status='completed'` commit
 *     atomically — Constitution Principle VIII.
 *
 * Error propagation:
 *   - All three F4 calls return `Result<…, …>` discriminated unions.
 *   - The bridge maps each F4 error variant into a single
 *     `F4BridgeError` union so the F8 use-case can branch on a flat
 *     error space without coupling to F4's internal codes.
 *
 * Pattern mirror: F7 → F2 `plans-bridge.ts`.
 *
 * Pure Infrastructure-layer composition — only F4 barrel imports +
 * F4 dep factories from the invoicing module's public surface.
 */
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { parseThbDecimalToSatang } from '@/lib/money';
import {
  createInvoiceDraft,
  issueInvoice,
  recordPayment,
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeRecordPaymentDeps,
  type F4InvoicePaidEvent,
} from '@/modules/invoicing';

export type F4OfflinePaymentMethod = 'bank_transfer' | 'cash' | 'cheque';

export interface IssueAndMarkPaidInput {
  readonly tenantId: string;
  readonly memberId: string;
  readonly planId: string;
  readonly planYear: number;
  /**
   * FR-022 — the cycle's FROZEN membership price as a `decimal(12,2)` THB
   * string (e.g. `'50000.50'`), server-sourced from the renewal cycle row.
   * NEVER a request body — a renewal §86/4 (ใบกำกับภาษี) is a price-
   * tampering surface on a tax document. The bridge converts it to
   * VAT-exclusive satang via the shared integer-only `parseThbDecimalToSatang`
   * (NO `parseFloat` — float drift charges the wrong amount) and threads it
   * as `renewalSignal` into `createInvoiceDraft` so the membership line bills
   * the frozen price, not the live F2 catalogue price, AND the one-off
   * `registration_fee` re-bill is suppressed. Mirrors the online path
   * (`f4-invoicing-for-renewal-bridge-drizzle.ts`).
   */
  readonly frozenPlanPriceThb: string;
  readonly paymentMethod: F4OfflinePaymentMethod;
  readonly paymentReference: string;
  /** YYYY-MM-DD Bangkok-local. */
  readonly paymentDate: string;
  readonly actorUserId: string;
  /** Optional caller-owned tx for atomic state+payment+cycle flip. */
  readonly externalTx?: unknown;
  /**
   * Cross-module on-paid hook fired inside `recordPayment`'s tx.
   * `mark-paid-offline.ts` wires an inline closure here that, on the same
   * `externalTx`, transitions the cycle `→ completed` (closedReason
   * `completed_offline`), emits a `renewal_cycle_completed_offline` audit,
   * and calls `createNextCycleOnPaidInTx` to advance the renewal loop —
   * all inside the same atomic boundary as `recordPayment`.
   */
  readonly onPaid?: (evt: F4InvoicePaidEvent) => Promise<void>;
  readonly requestId?: string | null;
}

export interface IssueAndMarkPaidResult {
  readonly invoiceId: string;
  /** ISO 8601 UTC. */
  readonly paidAt: string;
}

export type F4BridgeError =
  | { readonly kind: 'create_invoice_failed'; readonly reason: string }
  | { readonly kind: 'issue_invoice_failed'; readonly reason: string }
  /**
   * Step 3 (recordPayment) failed AFTER step 1+2 successfully committed
   * an issued invoice with a §87 sequence number. This is recoverable
   * but the admin MUST be told to resume from the F4 invoice list (NOT
   * retry mark-paid-offline) — otherwise step 1+2 will create a duplicate
   * invoice on retry, burning another §87 number. The orphan invoice id
   * is surfaced so the route can render an actionable error message.
   */
  | {
      readonly kind: 'record_payment_failed';
      readonly reason: string;
      readonly orphanInvoiceId: string;
    };

export interface F4InvoiceBridge {
  issueAndMarkPaid(
    input: IssueAndMarkPaidInput,
  ): Promise<Result<IssueAndMarkPaidResult, F4BridgeError>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const f4InvoiceBridge: F4InvoiceBridge = {
  async issueAndMarkPaid(
    input: IssueAndMarkPaidInput,
  ): Promise<Result<IssueAndMarkPaidResult, F4BridgeError>> {
    // --- Step 1: Create draft invoice (own tx) ---------------------------
    // FR-022 — convert the cycle's frozen `decimal(12,2)` THB string to
    // VAT-EXCLUSIVE satang via the shared integer-only parser (NO
    // `parseFloat` — float drift charges the wrong amount on a tax
    // document) and pass it as the renewal signal so the membership line
    // bills the FROZEN price, not the live F2 catalogue price, AND the
    // one-off registration_fee is NOT re-billed. Mirrors the online
    // confirm-renewal path (f4-invoicing-for-renewal-bridge-drizzle.ts).
    const frozenUnitPriceSatang = parseThbDecimalToSatang(
      input.frozenPlanPriceThb,
    );
    const createDeps = makeCreateInvoiceDraftDeps(input.tenantId);
    const created = await createInvoiceDraft(createDeps, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId ?? null,
      memberId: input.memberId,
      planId: input.planId,
      planYear: input.planYear,
      // F8 path is admin offline — auto-email is unwanted (admin already
      // has a printed receipt or out-of-band acknowledgement).
      autoEmailOnIssue: false,
      renewalSignal: { unitPriceSatang: frozenUnitPriceSatang },
    });
    if (!created.ok) {
      return err({
        kind: 'create_invoice_failed',
        reason: created.error.code,
      });
    }
    const invoiceId = created.value.invoiceId;

    // --- Step 2: Issue invoice (allocates §87 sequence, own tx) ----------
    const issueDeps = makeIssueInvoiceDeps(input.tenantId);
    const issued = await issueInvoice(issueDeps, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId ?? null,
      invoiceId,
    });
    if (!issued.ok) {
      return err({
        kind: 'issue_invoice_failed',
        reason: issued.error.code,
      });
    }

    // --- Step 3: Record payment (atomic with caller's externalTx) --------
    // makeRecordPaymentDeps threads externalTx into the invoice repo so
    // F4's internal `withTx` reuses our outer tx — the cycle-flip
    // callback below runs inside the SAME atomic boundary.
    const onPaidCallbacks = input.onPaid ? [input.onPaid] : undefined;
    const recordDeps = makeRecordPaymentDeps(
      input.tenantId,
      input.externalTx,
      onPaidCallbacks,
    );
    const paid = await recordPayment(recordDeps, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId ?? null,
      invoiceId,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference,
      paymentDate: input.paymentDate,
      // F8 surface — distinct from webhook + admin_manual paths.
      triggeredBy: 'admin_offline_mark',
      // Deterministic idempotency key — derives from stable inputs so
      // a retry of the same logical action produces the same key + F4
      // recognises the duplicate. paymentReference is admin-entered and
      // stable across retries (e.g. "BT-2026-0042"); invoiceId is fixed
      // once createInvoiceDraft commits. F5 precedent: `inv-{id}-attempt-{n}`.
      idempotencyKey: `f8-offline-${invoiceId}-${input.paymentReference}`,
    });
    if (!paid.ok) {
      // Steps 1+2 already committed — invoice exists in 'issued' state
      // with a consumed §87 sequence number. Loud-log so support can
      // find the orphan + surface the invoice id to the route handler.
      logger.error(
        {
          orphanInvoiceId: invoiceId,
          tenantId: input.tenantId,
          memberId: input.memberId,
          recordPaymentError: paid.error.code,
          requestId: input.requestId ?? null,
        },
        'f4-invoice-bridge: record_payment_failed AFTER invoice issued — orphan §87 invoice requires admin resume from F4 list, NOT retry mark-paid-offline',
      );
      return err({
        kind: 'record_payment_failed',
        reason: paid.error.code,
        orphanInvoiceId: invoiceId,
      });
    }

    // F4's `Invoice` carries a `paidAt` ISO string when status=paid.
    // Round 5 W-07 — drop the silent `new Date()` fallback. If F4's
    // contract changes the field name or removes it, falling back to
    // "now" would silently mis-stamp the audit + cycle.closedAt
    // relative to F4's internal `paid_at`. Throw with cycle context so
    // the outer runInTenant rolls back loudly + Sentry captures the
    // contract drift instead of letting it propagate as a stale
    // timestamp.
    const paidAtField = (paid.value as { paidAt?: string | Date | null })
      .paidAt;
    if (paidAtField == null) {
      throw new Error(
        `f4-invoice-bridge: F4 recordPayment returned ok but value.paidAt is ` +
          `null/undefined for invoiceId=${invoiceId} — F4 contract regression`,
      );
    }
    const paidAtIso =
      paidAtField instanceof Date ? paidAtField.toISOString() : String(paidAtField);

    return ok({
      invoiceId,
      paidAt: paidAtIso,
    });
  },
};
