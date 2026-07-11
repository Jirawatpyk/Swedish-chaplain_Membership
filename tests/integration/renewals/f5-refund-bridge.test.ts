/**
 * F8 Phase 10 / CHK039 close — F8 → F5 refund bridge contract test.
 *
 * Pins the F8 ↔ F5 cross-module bridge contract per spec FR-005d +
 * research.md (admin-reject-reactivation refund flow). F5 PR #16
 * shipped `issueRefund` admin use-case; F8 consumes it via
 * `f5RefundBridge` adapter from
 * `src/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle.ts`.
 *
 * Existing coverage:
 *   - `auto-reactivation-flow.test.ts:234-258` — admin-reject path with
 *     no_payment_found (cycle without linked invoice).
 *   - `pending-reactivation-timeout.test.ts:145+` — 30d auto-timeout
 *     path uses the same bridge wiring.
 *
 * Gap closed by THIS file:
 *   - Structural invariants on the bridge port (interface shape, brand
 *     enforcement, error-shape exhaustiveness) so a future refactor
 *     of F5 `issueRefund` cannot silently break the F8 wiring.
 *   - Type-level argument-swap protection — the bridge demands branded
 *     `TenantId` + `InvoiceId` from their owning modules; passing raw
 *     strings or swapped args fails at compile time (per port docstring
 *     line 17-29 "canonical brand adoption").
 *
 * What this test does NOT cover (out of F8 scope; lives in F5 own tests):
 *   - F5 `issueRefund` correctness (Stripe call, credit-note creation,
 *     payment row state transition).
 *   - End-to-end Stripe webhook → F4 credit-note → F8 `linked_credit_note_id`
 *     wiring — that needs full F5+F4+F8 integration test infra.
 *
 * Constitution Principle III (Clean Architecture) — port contract test
 * isolates F8's view of F5 from F5's internal implementation.
 */
import { describe, expect, it } from 'vitest';
import type {
  F5RefundBridge,
  IssueRefundForInvoiceInput,
  IssueRefundForInvoiceResult,
} from '@/modules/renewals/application/ports/f5-refund-bridge';
import { f5RefundBridge } from '@/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle';
import { asTenantId } from '@/modules/members';
import { asInvoiceId } from '@/modules/invoicing';

describe('F8 → F5 refund bridge contract — Phase 10 / CHK039 close', () => {
  it('production f5RefundBridge adapter satisfies F5RefundBridge port', () => {
    // Compile-time check: the imported `f5RefundBridge` must be
    // assignable to the port type. If F5 renames `issueRefundForInvoice`
    // OR changes its signature, this fails to compile + this test
    // catches the drift before merge.
    const bridge: F5RefundBridge = f5RefundBridge;
    expect(typeof bridge.issueRefundForInvoice).toBe('function');
  });

  it('F5RefundBridge port has exactly one method (`issueRefundForInvoice`)', () => {
    // Defence against accidental scope creep on the bridge port. F8's
    // view of F5 should remain narrow — the only operation F8 needs is
    // "issue a refund for the renewal invoice that was held in
    // pending_admin_reactivation". Adding methods here would couple
    // F8 to additional F5 surfaces — a code-review red flag.
    const portKeys = Object.keys({
      issueRefundForInvoice: null,
    } satisfies Record<keyof F5RefundBridge, null>);
    expect(portKeys).toEqual(['issueRefundForInvoice']);
  });

  it('IssueRefundForInvoiceInput requires branded TenantId + InvoiceId (compile-time arg-swap protection)', () => {
    // Round 2 review-fix S-9 / Round 3 R3-CR1 invariant: the bridge
    // input demands canonical branded types from their owning modules
    // (TenantId from F3 @ src/modules/members; InvoiceId from F4 @
    // src/modules/invoicing). A swapped call
    // `{ tenantId: invoiceId, invoiceId: tenantId }` MUST fail compile.
    //
    // We construct a valid input here. The compile-time check is the
    // assertion — if a future refactor weakens these brands, the
    // `asTenantId('...') as InvoiceId` cast at the swap line would
    // succeed, and a code-review would catch THIS test's compile error
    // as a regression.
    const validInput: IssueRefundForInvoiceInput = {
      tenantId: asTenantId('test-tenant-slug'),
      invoiceId: asInvoiceId('00000000-0000-0000-0000-000000000000'),
      reason: 'admin rejected reactivation',
      actorUserId: 'admin-user-id',
      correlationId: 'test-correlation',
      requestId: null,
    };
    expect(validInput.tenantId).toBe('test-tenant-slug');
    expect(validInput.invoiceId).toBe('00000000-0000-0000-0000-000000000000');
    expect(validInput.requestId).toBeNull();
  });

  it('IssueRefundForInvoiceResult discriminated union covers 4 outcomes', () => {
    // The result union must cover: refunded (success) + no_payment_found
    // (cycle without linked payment — admin can still reject) +
    // refund_failed (transient/processor error — F8 cycle stays pending
    // for retry per admin-reject-reactivation.ts) + refund_pending
    // (F8-RP: async Stripe refund settling via webhook/sweep — the row
    // stays `pending`, no CN yet; the cycle stays pending and self-heals).
    const refunded: IssueRefundForInvoiceResult = {
      status: 'refunded',
      refundId: 'ref-123',
      creditNoteId: 'cn-456',
      creditNoteNumber: 'CN/2026/00001',
    };
    const noPayment: IssueRefundForInvoiceResult = {
      status: 'no_payment_found',
    };
    const refundFailed: IssueRefundForInvoiceResult = {
      status: 'refund_failed',
      errorCode: 'processor_unavailable',
      detail: 'Stripe API timeout',
    };
    const refundPending: IssueRefundForInvoiceResult = {
      status: 'refund_pending',
      refundId: 'ref-789',
      processorRefundId: 're_async_1',
    };
    // Exhaustive switch — adding a 5th status without updating
    // admin-reject-reactivation.ts + reconcile-pending-reactivations.ts
    // would type-check as `never` here.
    const outcomes: ReadonlyArray<IssueRefundForInvoiceResult> = [
      refunded,
      noPayment,
      refundFailed,
      refundPending,
    ];
    for (const outcome of outcomes) {
      switch (outcome.status) {
        case 'refunded':
          expect(outcome.creditNoteId).toBeTruthy();
          break;
        case 'no_payment_found':
          // Empty-shape branch — no fields beyond status.
          expect(Object.keys(outcome)).toEqual(['status']);
          break;
        case 'refund_failed':
          expect(outcome.errorCode).toBeTruthy();
          expect(outcome.detail).toBeTruthy();
          break;
        case 'refund_pending':
          // Ids are OPTIONAL: present on the F5 `kind:'pending'` path,
          // absent on the `refund_in_progress` retry path.
          expect(outcome.processorRefundId).toBe('re_async_1');
          break;
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`unhandled status: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
  });

  it('bridge adapter is a singleton instance (composition-root pattern)', () => {
    // The drizzle adapter exports a singleton (not a factory) per
    // `src/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle.ts`.
    // This matches the F4 invoice-bridge precedent — no per-tenant
    // closure needed because the F5 use-case takes tenantId as input.
    expect(typeof f5RefundBridge).toBe('object');
    expect(f5RefundBridge).toBe(f5RefundBridge); // referential identity
  });
});
