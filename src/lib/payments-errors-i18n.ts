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
  | 'f4_bridge_error';

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
};

export function messagesFor(code: F5RouteErrorCode): Bilingual {
  return F5_ERROR_MESSAGES[code];
}
