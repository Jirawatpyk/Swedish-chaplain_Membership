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
  readonly paymentMethod: F4OfflinePaymentMethod;
  readonly paymentReference: string;
  /** YYYY-MM-DD Bangkok-local. */
  readonly paymentDate: string;
  readonly actorUserId: string;
  /** Optional caller-owned tx for atomic state+payment+cycle flip. */
  readonly externalTx?: unknown;
  /**
   * Cross-module on-paid hook fired inside `recordPayment`'s tx.
   * The F8 use-case wires its `markCompletedOfflineInTx(tx, …)` here
   * so the cycle update lands inside the same atomic boundary.
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
    // Defensive narrowing — `paidAt` is set on success per the
    // `recordPayment` contract.
    const paidAtRaw =
      (paid.value as { paidAt?: string | Date | null }).paidAt ??
      new Date().toISOString();
    const paidAtIso =
      paidAtRaw instanceof Date ? paidAtRaw.toISOString() : String(paidAtRaw);

    return ok({
      invoiceId,
      paidAt: paidAtIso,
    });
  },
};
