/**
 * Route-level error-code → { message, messageThai } lookup for F5 payment
 * endpoints. Kept as a const table (not i18n keys) because these envelopes
 * are route-internal bilingual strings — adding them to the global i18n
 * JSON would inflate `pnpm check:i18n` surface by 60+ keys for strings
 * that have exactly one call site each (the route). The portal UI shows
 * the localised version via its OWN i18n keys driven by the `error.code`
 * discriminator.
 *
 * EVERY error response carries BOTH `message` (request-locale resolved
 * to EN for the route layer) AND `messageThai` (always present so an
 * EN-locale member viewing a Thai-language receipt still sees TH text).
 * Spec: specs/009-online-payment/contracts/payments-api.md intro +
 * T041 contract test "error responses carry a messageThai field".
 */

export type F5RouteErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden_role'
  // Collapsed resource-accessibility codes (PCI F-02 / Threat OQ-1 /
  // Constitution Principle I). Both "invoice exists in a different
  // tenant" and "invoice does not exist anywhere" return the SAME
  // opaque 403 payload so the client cannot distinguish cross-tenant
  // existence (enumeration defence). The audit log still receives the
  // distinct `payment_cross_tenant_probe` event on the cross-tenant
  // branch from the use-case — the collapse is strictly at the HTTP
  // response boundary.
  | 'invoice_not_accessible'
  | 'payment_not_accessible'
  | 'invoice_not_payable'
  | 'online_payment_disabled'
  | 'method_not_enabled'
  | 'payment_not_cancelable'
  | 'tenant_settings_incomplete'
  // #7 (F5R3v3 H-1) — F4 bridge flagged a corrupt/negative invoice
  // total; distinct from `tenant_settings_incomplete` so ops can tell
  // "misconfigured tenant" apart from "corrupted invoice data" at a
  // glance in logs/alerts even though both currently map to 422.
  | 'invoice_data_corrupt'
  | 'rate_limited'
  | 'processor_unavailable'
  | 'internal_error'
  | 'missing_header'
  | 'bad_signature'
  // F5 Phase 6 / US4 refund-specific codes (T111).
  | 'payment_not_found'
  | 'payment_not_refundable'
  | 'refund_exceeds_remaining'
  | 'refund_in_progress'
  // F4 credit-note issuance failure during the refund flow (Phase 6 T111
  // + simplify Q3). Distinct from `processor_unavailable` so monitoring
  // can route F4 alerts to the F4 on-call channel instead of paging the
  // payments team for a CN-PDF / Blob / sequence-allocator issue.
  | 'f4_bridge_error'
  // B.1 review Fix#1 — the PRE-FLIGHT F4 credited-total read failed BEFORE any
  // Stripe call. Money did NOT move, the refund is safe to retry, and NO
  // orphaned refund exists. DISTINCT from `f4_bridge_error` (Stripe DID
  // succeed → out-of-band-refund runbook) so on-call does not chase a
  // non-existent refund. Both currently map to 502.
  | 'f4_preflight_read_error'
  // I1 (Task 7) — the credit-gate axes could not be DERIVED (a code/shape
  // fault). Distinct from `f4_preflight_read_error` because that copy says to
  // retry, which is false here: no retry can compute a verdict the code cannot
  // compute. Money did not move on either.
  | 'f4_preflight_gate_underivable'
  // F-4 (money-remediation Task 7) — the refund was refused in Phase A
  // because F4's credit-note gates would decline it. Money did NOT move.
  // All three are 409, and DELIBERATELY not collapsed into one code: the
  // operator response differs per axis (fix the invoice / permanent, use a
  // different instrument / just wait for the receipt render).
  | 'f4_preflight_invalid_status'
  | 'f4_preflight_not_creditable'
  | 'f4_preflight_receipt_not_rendered'
  // Money-remediation F-3 — the refund SETTLED at the processor; only the
  // credit note is outstanding, and the stale-pending sweep retries it. MUST
  // stay distinct from `f4_bridge_error`, whose copy ("issuance failed") reads
  // as retryable. That read is the click F-3 needed: the old code also marked
  // the row `failed`, so the retry minted a fresh idempotency key and refunded
  // the customer twice. Nothing is expected of the admin here.
  | 'f4_bridge_deferred'
  // Money-remediation F-3 backstop — this payment carries a refund row left
  // in the F-3 casualty state (settled at Stripe, recorded `failed`). The
  // refundable-remainder maths cannot see that money, so further refunds are
  // blocked until a human reconciles.
  | 'refund_needs_reconciliation'
  // CF-2 — the "mark failed auto-refund as reconciled" surface found NO
  // `auto_refund_failed_needs_manual_reconcile` forensic for the invoice, so
  // there is nothing to reconcile (409 conflict; the alert only offers the
  // action when a failure exists, so this is a race / stale-page path).
  | 'no_failed_auto_refund';

interface Bilingual {
  readonly message: string;
  readonly messageThai: string;
}

export const F5_ERROR_MESSAGES: Record<F5RouteErrorCode, Bilingual> = {
  invalid_input: {
    message: 'Invalid request payload.',
    messageThai: 'ข้อมูลคำขอไม่ถูกต้อง',
  },
  unauthorized: {
    message: 'Authentication required.',
    messageThai: 'กรุณาเข้าสู่ระบบ',
  },
  forbidden_role: {
    message: 'Your account role cannot perform this action.',
    messageThai: 'สิทธิ์ของบัญชีไม่สามารถดำเนินการนี้ได้',
  },
  // Collapsed opaque messages for enumeration defence (PCI F-02 /
  // Threat OQ-1). "Cannot be accessed" does not commit to whether
  // the resource exists elsewhere (cross-tenant) or nowhere.
  invoice_not_accessible: {
    message: 'Invoice is not available or cannot be accessed.',
    messageThai: 'ไม่สามารถเข้าถึงใบแจ้งหนี้นี้ได้',
  },
  payment_not_accessible: {
    message: 'Payment is not available or cannot be accessed.',
    messageThai: 'ไม่สามารถเข้าถึงรายการชำระเงินนี้ได้',
  },
  invoice_not_payable: {
    message: 'This invoice is not currently payable.',
    messageThai: 'ใบแจ้งหนี้นี้ไม่สามารถชำระเงินได้ในขณะนี้',
  },
  online_payment_disabled: {
    message: 'Online payment is disabled for this tenant.',
    messageThai: 'การชำระเงินออนไลน์ถูกปิดใช้งานชั่วคราว',
  },
  method_not_enabled: {
    message: 'This payment method is not enabled.',
    messageThai: 'ช่องทางการชำระเงินนี้ไม่ได้เปิดใช้งาน',
  },
  payment_not_cancelable: {
    message: 'This payment can no longer be canceled.',
    messageThai: 'ไม่สามารถยกเลิกรายการชำระเงินนี้ได้',
  },
  tenant_settings_incomplete: {
    message: 'Payment settings are incomplete. Please contact support.',
    messageThai: 'การตั้งค่าการชำระเงินไม่สมบูรณ์ กรุณาติดต่อฝ่ายสนับสนุน',
  },
  invoice_data_corrupt: {
    message: 'Invoice data is corrupt. Please contact your administrator.',
    messageThai: 'ข้อมูลใบแจ้งหนี้ผิดพลาด กรุณาติดต่อผู้ดูแลระบบ',
  },
  rate_limited: {
    message: 'Too many requests. Please try again shortly.',
    messageThai: 'มีคำขอมากเกินไป กรุณาลองอีกครั้งในอีกสักครู่',
  },
  processor_unavailable: {
    message: 'Payment processor is temporarily unavailable. Please retry.',
    messageThai: 'ระบบชำระเงินไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง',
  },
  internal_error: {
    message: 'An unexpected error occurred. Support has been notified.',
    messageThai: 'เกิดข้อผิดพลาดที่ไม่คาดคิด ทีมสนับสนุนได้รับแจ้งแล้ว',
  },
  missing_header: {
    message: 'Required header is missing.',
    messageThai: 'ไม่พบส่วนหัวคำขอที่จำเป็น',
  },
  bad_signature: {
    message: 'Webhook signature verification failed.',
    messageThai: 'การตรวจสอบลายเซ็นเว็บฮุกล้มเหลว',
  },
  // ---------------------------------------------------------------------
  // F5 Phase 6 / US4 refund-specific codes (T111).
  //
  // Per `contracts/payments-api.md` § 3, refund errors do NOT collapse
  // not-found ↔ cross-tenant the way the member-facing initiate-payment
  // route does — refund is an admin-only surface, so an admin trying
  // to refund a payment that does not exist simply gets a 404. The
  // cross-tenant defence is the RLS policy on `payments` (FORCE) plus
  // the use-case's tenant-scoped `lockForUpdate(tenantId)` guard.
  // ---------------------------------------------------------------------
  payment_not_found: {
    message: 'Payment not found.',
    messageThai: 'ไม่พบรายการชำระเงิน',
  },
  payment_not_refundable: {
    message: 'This payment is not in a refundable state.',
    messageThai: 'รายการชำระเงินนี้ไม่สามารถคืนเงินได้',
  },
  refund_exceeds_remaining: {
    message: 'Refund amount exceeds the remaining refundable balance.',
    messageThai: 'จำนวนเงินคืนเกินยอดที่สามารถคืนได้',
  },
  refund_in_progress: {
    message: 'Another refund is currently in progress for this payment. Please retry shortly.',
    messageThai: 'กำลังดำเนินการคืนเงินรายการอื่นอยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่',
  },
  f4_bridge_error: {
    message: 'Credit-note issuance failed. Operations have been notified.',
    messageThai: 'การออกใบลดหนี้ล้มเหลว ทีมงานได้รับแจ้งแล้วและจะติดต่อกลับโดยเร็ว',
  },
  f4_preflight_read_error: {
    message: 'Could not verify the refundable balance right now. No money was moved — please retry.',
    messageThai: 'ไม่สามารถตรวจสอบยอดที่คืนได้ในขณะนี้ ยังไม่มีการเคลื่อนไหวของเงิน กรุณาลองใหม่อีกครั้ง',
  },
  f4_preflight_invalid_status: {
    // Explicitly states that no money moved. The admin's next step is the
    // invoice, not the refund screen or the payment processor.
    message:
      "This invoice can no longer be credited, so it cannot be refunded. No money was moved. Check the invoice — it may have been voided or already fully credited.",
    messageThai:
      'ใบแจ้งหนี้นี้ไม่สามารถออกใบลดหนี้ได้แล้ว จึงไม่สามารถคืนเงินได้ ยังไม่มีการเคลื่อนไหวของเงิน กรุณาตรวจสอบใบแจ้งหนี้ อาจถูกยกเลิกหรือออกใบลดหนี้เต็มจำนวนไปแล้ว',
  },
  f4_preflight_gate_underivable: {
    // Deliberately does NOT say "retry". The verdict could not be computed at
    // all, so an identical retry fails identically — the same
    // retryable-looking-but-permanent copy this remediation removes elsewhere.
    message:
      'Could not determine whether this payment can be credited, so the refund was not attempted. No money was moved. This needs a fix on our side — please contact support.',
    messageThai:
      'ระบบไม่สามารถระบุได้ว่าการชำระเงินนี้ออกใบลดหนี้ได้หรือไม่ จึงยังไม่ได้ดำเนินการคืนเงิน ยังไม่มีการเคลื่อนไหวของเงิน กรณีนี้ต้องแก้ไขที่ระบบ กรุณาติดต่อฝ่ายสนับสนุน',
  },
  f4_preflight_not_creditable: {
    // Permanent by law, so the copy must not imply retrying: a §105
    // ใบเสร็จรับเงิน has no ใบกำกับภาษี number and date for a §86/10 ใบลดหนี้
    // to cite (§86/10 วรรคสอง). Seller-side rule — not "the buyer has no
    // input VAT to reverse", which would wrongly implicate the membership
    // path's non-registrant buyers, who ARE creditable under the 066 relax.
    message:
      'This payment was receipted without a tax invoice, so no credit note can be issued against it. No money was moved. Refunding it requires a manual process — please contact finance.',
    messageThai:
      'การชำระเงินนี้ออกเป็นใบเสร็จรับเงิน ไม่ใช่ใบกำกับภาษี จึงออกใบลดหนี้ไม่ได้ ยังไม่มีการเคลื่อนไหวของเงิน การคืนเงินต้องดำเนินการด้วยกระบวนการพิเศษ กรุณาติดต่อฝ่ายการเงิน',
  },
  f4_preflight_receipt_not_rendered: {
    // The only one of the three that clears itself. Say "wait", not
    // "escalate" — an admin told to escalate a self-healing state files a
    // ticket that resolves before anyone reads it.
    message:
      'The receipt for this payment is still being generated. No money was moved — please try the refund again in a few minutes.',
    messageThai:
      'ระบบกำลังสร้างใบเสร็จสำหรับการชำระเงินนี้ ยังไม่มีการเคลื่อนไหวของเงิน กรุณาลองคืนเงินอีกครั้งในอีกสักครู่',
  },
  f4_bridge_deferred: {
    // Deliberately reassuring and explicitly non-actionable. The admin has
    // just been told a refund "failed" by every previous version of this
    // screen, and acted on it by clicking again.
    message:
      'Refund sent — the credit note is still being issued. No action needed; it completes automatically.',
    messageThai:
      'ส่งคำสั่งคืนเงินเรียบร้อยแล้ว กำลังออกใบลดหนี้ ไม่ต้องดำเนินการใดๆ ระบบจะทำให้เสร็จโดยอัตโนมัติ',
  },
  refund_needs_reconciliation: {
    message:
      'This payment has a refund awaiting manual reconciliation. Further refunds are blocked until it is resolved.',
    messageThai:
      'การชำระเงินนี้มีรายการคืนเงินที่รอการกระทบยอดด้วยเจ้าหน้าที่ ไม่สามารถคืนเงินเพิ่มได้จนกว่าจะดำเนินการเสร็จ',
  },
  no_failed_auto_refund: {
    message: 'There is no failed auto-refund to reconcile for this invoice.',
    messageThai: 'ไม่มีการคืนเงินอัตโนมัติที่ล้มเหลวให้กระทบยอดสำหรับใบแจ้งหนี้นี้',
  },
};

export function messagesFor(code: F5RouteErrorCode): Bilingual {
  return F5_ERROR_MESSAGES[code];
}
