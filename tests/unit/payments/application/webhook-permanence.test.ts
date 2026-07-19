/**
 * money-remediation Task 5 — webhook dispatch permanence classification.
 *
 * ## What this replaces
 *
 * `PERMANENT_SUB_USE_CASE_DETAILS`, a six-entry `Set<string>` keyed on
 * `result.error.code`. Two of its six entries (`invoice_shape_invalid`,
 * `payment_method_unsupported`) named codes that exist nowhere in `src/` —
 * it had drifted away from the unions it claimed to classify.
 *
 * The set's live effect was worse than the drift: across both reachable
 * sub-use-case error unions, `result.error.code` is only ever
 * `bridge_error`, `processor_unavailable`, or
 * `invariant_auto_refunded_missing_invoice_id`. Because `bridge_error` was
 * IN the set, **every F4 decline classified permanent** — a transient PDF
 * render failure or Blob outage was 200-acked to Stripe and never retried.
 * The F4 sub-code that distinguishes them (`confirm-payment.ts`
 * `detail: bridgeResult.error.code`) was accepted by `subUseCaseErr` and
 * discarded.
 *
 * ## Why this test is table-driven over a (code, subDetail) PAIR
 *
 * The old snapshot test (`R2-M1: PERMANENT_SUB_USE_CASE_DETAILS membership
 * snapshot`) pinned six synthetic strings. It could not express the only
 * mutation that matters here, because its inputs were not the values the
 * production code passes around.
 *
 * The mutation this table DOES express: collapse the predicate to key on
 * `code` alone (the pre-Task-5 behaviour). Every `bridge_error` row then
 * lands on one verdict, so `pdf_render_failed` (transient) and
 * `legacy_no_tin_event_needs_remediation` (permanent) go RED
 * simultaneously — no single-verdict collapse can satisfy both. That
 * simultaneous failure is what proves the sub-detail is actually plumbed
 * through, rather than the predicate merely being correct in isolation.
 *
 * Each row cites the source site that produces it. When a row's verdict is
 * disputed, read that site — not this table.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDispatchPermanence,
  type DispatchPermanence,
} from '@/modules/payments/application/use-cases/process-webhook-event';

interface Row {
  readonly code: string;
  readonly subDetail: string | null;
  readonly expected: DispatchPermanence;
  /** Source site that produces this pair — the authority for the verdict. */
  readonly source: string;
  readonly why: string;
}

/**
 * The two non-`bridge_error` codes reachable from a sub-use-case Result.
 *
 * NOT here, deliberately:
 *   - `illegal_transition` (declared on `FailPaymentError`, and the sole
 *     union member of `HandleCancelEventError`) is DEAD. The arm that would
 *     produce it in `fail-payment.ts` returns `ok({kind:'already_terminal'})`
 *     after an `emitTerminalStateAck`; `handleCancelEvent` acks every error
 *     case for the same reason (see the `v8 ignore` block on the dispatcher's
 *     cancel branch). Neither value can reach the classifier.
 */
const NON_BRIDGE_ROWS: readonly Row[] = [
  {
    code: 'processor_unavailable',
    subDetail: null,
    expected: 'transient',
    source: 'confirm-payment.ts retrieve-fail sites; fail-payment.ts retrieve-fail site',
    why: 'Stripe API outage — recovers inside the 72h retry window.',
  },
  {
    code: 'invariant_auto_refunded_missing_invoice_id',
    subDetail: null,
    expected: 'permanent',
    source: 'process-webhook-event.ts auto_refunded_stale_invoice guard (literal)',
    why: 'confirmPayment contract violation — a code bug does not self-heal by retrying.',
  },
];

/**
 * `bridge_error` sub-details. All but the first arrive as
 * `RecordPaymentError['code']` values, laundered through
 * `summariseF4Error` (which keys on `code`, NOT `detail` — for every F4
 * variant except pdf/blob the `detail` field falls through to
 * `unknown_f4_error_shape (code=…)`).
 */
const BRIDGE_ROWS: readonly Row[] = [
  {
    code: 'bridge_error',
    subDetail: 'tenant_settings_missing',
    expected: 'permanent',
    source: 'confirm-payment.ts + fail-payment.ts pre-tx settings guard',
    why:
      'F5 is not configured for this tenant. PERMANENCE IS A DOCUMENTED PRIOR FIX ' +
      '(F5R2-CRIT-2) — flipping it to transient re-creates 72h of retries against ' +
      'a config gap tenants hit during onboarding. Do not "simplify" this row away.',
  },
  {
    code: 'bridge_error',
    subDetail: 'settings_missing',
    expected: 'permanent',
    source: 'record-payment.ts:333',
    why: "F4's own tenant-invoice-settings gap — same admin-action class as above.",
  },
  {
    code: 'bridge_error',
    subDetail: 'legacy_no_tin_event_needs_remediation',
    expected: 'permanent',
    source: 'record-payment.ts:594',
    why: 'Legacy no-TIN event row needs the operator remediation runbook, not a retry.',
  },
  {
    code: 'bridge_error',
    subDetail: 'legacy_invoice_needs_reissue',
    expected: 'permanent',
    source: 'record-payment.ts:610',
    why: 'Invoice must be voided + re-issued by an admin before it can be paid.',
  },
  {
    code: 'bridge_error',
    subDetail: 'new_flow_bill_requires_flag_on',
    expected: 'permanent',
    source: 'record-payment.ts:635',
    why: 'FEATURE_088_TAX_AT_PAYMENT rolled back OFF — needs an env flip, not a retry.',
  },
  {
    code: 'bridge_error',
    subDetail: 'no_snapshot_on_invoice',
    expected: 'permanent',
    source: 'record-payment.ts:467, :523',
    why: 'Missing buyer identity snapshot — a data repair, not a transient.',
  },
  {
    code: 'bridge_error',
    subDetail: 'invoice_not_found',
    expected: 'permanent',
    source: 'record-payment.ts:426, :432, :457',
    why: 'Invoice deleted while the payment was in flight — retrying cannot resurrect it.',
  },
  {
    code: 'bridge_error',
    subDetail: 'overflow',
    expected: 'permanent',
    source: 'record-payment.ts:773',
    why: '§87 sequence exhausted for the fiscal year — operator must extend the range.',
  },
  {
    code: 'bridge_error',
    subDetail: 'pdf_render_failed',
    expected: 'transient',
    source: 'record-payment.ts:883 (RecordPaymentInternalError factory)',
    why:
      'THE ROW THE OLD SET GOT WRONG. @react-pdf render failure is retryable; ' +
      'under the old code this 200-acked and the money silently stranded.',
  },
  {
    code: 'bridge_error',
    subDetail: 'blob_upload_failed',
    expected: 'transient',
    source: 'record-payment.ts:883 (RecordPaymentInternalError factory)',
    why: 'Vercel Blob outage — recovers well inside the 72h Stripe retry window.',
  },
  {
    code: 'bridge_error',
    subDetail: 'concurrent_state_change',
    expected: 'transient',
    source: 'record-payment.ts:954 (InvoiceApplyConflictError → internal error)',
    why: 'Lost an optimistic-status race; the retry re-reads and settles cleanly.',
  },
  {
    code: 'bridge_error',
    subDetail: 'invalid_status',
    expected: 'transient',
    source: 'record-payment.ts:453',
    why:
      'JUDGEMENT CALL, and reversible. It cannot be discriminated from the code ' +
      "alone: summariseF4Error's scalar whitelist accepts only code/kind/detail/ " +
      'reason and DROPS the `status` field this site attaches, so a lost race ' +
      '(retryable) and a genuinely wrong status (not) are indistinguishable here. ' +
      'Applying the plan bias — a transient mislabelled permanent recreates F-1 ' +
      '(silent stranded money); a permanent mislabelled transient is a bounded, ' +
      'logged, ceiling-capped retry storm. Choose the loud failure. Widening ' +
      "summariseF4Error's whitelist to carry `status` is what would let us do better.",
  },
  {
    code: 'bridge_error',
    subDetail: 'f4_error',
    expected: 'transient',
    source: 'invoicing-bridge.ts summariseF4Error code fallback',
    why:
      'Unrecognised F4 error shape. Also bumps the f4BridgeUnknownErrorShape ' +
      'counter, which is noisy by construction (summariseF4Error produces a ' +
      'meaningful `detail` for pdf/blob ONLY; every other variant falls through ' +
      'to `unknown_f4_error_shape (code=…)`). Transient + the retry ceiling is ' +
      'the safe default for a shape we cannot read.',
  },
];

/**
 * Rows the old plan wrongly listed as reachable. Kept as executable
 * documentation: they are classified (the F4 map is exhaustive over
 * `RecordPaymentError['code']`, so a new F4 code fails the build) but
 * cannot arrive on this rail today.
 *
 *   - `membership_terminated` + `payment_date_out_of_range` sit behind
 *     `isAdminDialogRail` (record-payment.ts:357-359), and
 *     `markPaidFromProcessor` hardcodes `triggeredBy: 'webhook'`.
 *   - `credit_exceeds_remainder` / `receipt_not_creditable` are
 *     `IssueCreditNoteError` values on the refund path, not this one.
 */
const UNREACHABLE_BUT_CLASSIFIED_ROWS: readonly Row[] = [
  {
    code: 'bridge_error',
    subDetail: 'membership_terminated',
    expected: 'permanent',
    source: 'record-payment.ts:398, gated by isAdminDialogRail',
    why: 'Business state requiring a renewal — unreachable via webhook, but never retryable.',
  },
  {
    code: 'bridge_error',
    subDetail: 'payment_date_out_of_range',
    expected: 'permanent',
    source: 'record-payment.ts:490, gated by isAdminDialogRail',
    why: 'Deterministic input rejection — unreachable via webhook, and identical on retry.',
  },
];

describe('classifyDispatchPermanence (money-remediation Task 5)', () => {
  describe.each([
    ['non-bridge codes', NON_BRIDGE_ROWS],
    ['bridge_error sub-details', BRIDGE_ROWS],
    ['classified but webhook-unreachable', UNREACHABLE_BUT_CLASSIFIED_ROWS],
  ] as const)('%s', (_group, rows) => {
    it.each(rows.map((r) => [r.code, r.subDetail ?? '<null>', r.expected, r] as const))(
      'code=%s subDetail=%s → %s',
      (_code, _sub, _expected, row) => {
        expect(classifyDispatchPermanence(row.code, row.subDetail)).toBe(row.expected);
      },
    );
  });

  /**
   * CONTROL — must stay green under every mutation applied to the table
   * rows above. If a mutation reddens this too, the mutation was broader
   * than intended and the table's evidence is void.
   */
  it('control: an unrecognised code defaults transient (loud over silent)', () => {
    expect(classifyDispatchPermanence('some_future_code', null)).toBe('transient');
    expect(classifyDispatchPermanence('some_future_code', 'whatever')).toBe('transient');
  });

  it('bridge_error with a null sub-detail defaults transient, not permanent', () => {
    // The pre-Task-5 code classified bare `bridge_error` as PERMANENT. A
    // bridge error we cannot resolve to a sub-code is exactly the case
    // where we want Stripe to retry (bounded by the ceiling) rather than
    // silently strand the payment.
    expect(classifyDispatchPermanence('bridge_error', null)).toBe('transient');
  });

  it('an unrecognised bridge sub-detail defaults transient', () => {
    expect(classifyDispatchPermanence('bridge_error', 'not_a_real_f4_code')).toBe(
      'transient',
    );
  });

  /**
   * Guards the drift that killed the old set: it listed
   * `invoice_shape_invalid` and `payment_method_unsupported`, neither of
   * which exists in `src/`. Their presence made the set look
   * authoritative while it classified nothing.
   */
  it('does not resurrect the two codes that never existed', () => {
    expect(classifyDispatchPermanence('bridge_error', 'invoice_shape_invalid')).toBe(
      'transient',
    );
    expect(
      classifyDispatchPermanence('bridge_error', 'payment_method_unsupported'),
    ).toBe('transient');
  });

  it('classifies at least one bridge sub-detail each way (mutation tripwire)', () => {
    // A collapse to code-only keying makes these two agree, which is the
    // single assertion that cannot be satisfied by any one-verdict rule.
    const transient = classifyDispatchPermanence('bridge_error', 'pdf_render_failed');
    const permanent = classifyDispatchPermanence(
      'bridge_error',
      'legacy_no_tin_event_needs_remediation',
    );
    expect(transient).toBe('transient');
    expect(permanent).toBe('permanent');
    expect(transient).not.toBe(permanent);
  });
});
