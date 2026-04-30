/**
 * Shared response-shape helpers for F7 broadcast route handlers.
 *
 * Mirrors `payments-route-helpers.ts` (F5) — every F7 route emits the
 * same envelope:
 *
 *     {
 *       error: { code, message, messageThai, fieldErrors?, details? },
 *       correlationId
 *     }
 *
 * Headers contract:
 *   - `X-Correlation-Id`     — always echoed
 *   - `Cache-Control`        — `no-store, private` (broadcast responses
 *                              carry tenant/member-scoped data; never
 *                              cache at edge or shared proxy)
 *   - `Retry-After`          — only on 429 `broadcast_rate_limit_exceeded`
 *
 * Bilingual message map covers every Application/Submit error code
 * surfaced by `submitBroadcast`, `saveDraft`, and `computeQuotaCounter`.
 */
import { NextResponse } from 'next/server';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';

/**
 * Closed union of every F7 route error code. Mirrors the union of
 * Application use-case errors plus a few HTTP-only codes for invalid
 * input + auth + kill-switch.
 */
export type F7RouteErrorCode =
  // Submit preconditions (FR-002 a–k + FR-016a)
  | 'broadcast_member_halted_pending_review'
  | 'broadcast_rate_limit_exceeded'
  | 'broadcast_not_in_plan'
  | 'broadcast_quota_blocked'
  | 'broadcast_member_missing_primary_contact_email'
  | 'broadcast_subject_too_long'
  | 'broadcast_subject_empty'
  | 'broadcast_body_too_large'
  | 'broadcast_body_unsafe_html'
  | 'broadcast_custom_recipient_unknown'
  | 'broadcast_custom_recipient_invalid_format'
  | 'broadcast_custom_recipient_empty'
  | 'broadcast_custom_recipient_too_many'
  | 'broadcast_empty_segment_blocked'
  | 'broadcast_audience_too_large'
  // State-machine + lifecycle
  | 'broadcast_immutable_after_submit'
  | 'broadcast_not_found'
  // US2 lifecycle (admin review)
  | 'broadcast_invalid_state_transition'
  | 'broadcast_concurrent_action_blocked'
  | 'broadcast_cancel_too_late'
  | 'broadcast_schedule_too_soon'
  | 'broadcast_rejection_reason_required'
  | 'broadcast_rejection_reason_too_long'
  | 'broadcast_cancel_reason_too_long'
  | 'broadcast_member_not_found'
  // Generic HTTP-shape codes
  | 'invalid_body'
  | 'forbidden'
  | 'feature_disabled'
  | 'internal_error';

interface BilingualMessage {
  readonly message: string;
  readonly messageThai: string;
}

const F7_ERROR_MESSAGES: Record<F7RouteErrorCode, BilingualMessage> = {
  broadcast_member_halted_pending_review: {
    message:
      'Your broadcast privileges are paused pending admin review. Contact your administrator.',
    messageThai:
      'สิทธิ์การส่ง E-Blast ของคุณถูกพักไว้รออดมินตรวจสอบ กรุณาติดต่อผู้ดูแล',
  },
  broadcast_rate_limit_exceeded: {
    message: 'Too many submissions. Please try again later.',
    messageThai: 'ส่งบ่อยเกินไป กรุณาลองใหม่ภายหลัง',
  },
  broadcast_not_in_plan: {
    message: 'Your membership plan does not include the E-Blast benefit.',
    messageThai: 'แพ็กเกจของคุณยังไม่รวมสิทธิ์ส่ง E-Blast',
  },
  broadcast_quota_blocked: {
    message: 'You have used all of your E-Blast quota for the year.',
    messageThai: 'โควตา E-Blast ของปีนี้ถูกใช้หมดแล้ว',
  },
  broadcast_member_missing_primary_contact_email: {
    message:
      'Your member profile is missing a primary contact email — please update it before submitting.',
    messageThai:
      'โปรไฟล์ของคุณยังไม่มีอีเมลผู้ติดต่อหลัก กรุณาอัปเดตก่อนส่ง',
  },
  broadcast_subject_too_long: {
    message: 'Subject must be 200 characters or fewer.',
    messageThai: 'หัวข้อต้องมีไม่เกิน 200 ตัวอักษร',
  },
  broadcast_subject_empty: {
    message: 'Subject is required.',
    messageThai: 'กรุณากรอกหัวข้อ',
  },
  broadcast_body_too_large: {
    message: 'Message body exceeds the 200 KB size limit.',
    messageThai: 'เนื้อหามีขนาดเกิน 200 KB',
  },
  broadcast_body_unsafe_html: {
    message: 'Message body contains forbidden HTML — please remove unsupported elements.',
    messageThai: 'เนื้อหามี HTML ที่ไม่อนุญาต กรุณาลบองค์ประกอบที่ไม่รองรับ',
  },
  broadcast_custom_recipient_unknown: {
    message: 'Some custom recipients are not in your tenant directory.',
    messageThai: 'อีเมลในรายการกำหนดเองบางรายการไม่อยู่ในไดเรกทอรีของคุณ',
  },
  broadcast_custom_recipient_invalid_format: {
    message: 'Some custom recipients are not valid email addresses.',
    messageThai: 'อีเมลบางรายการไม่ถูกต้องตามรูปแบบ',
  },
  broadcast_custom_recipient_empty: {
    message: 'Custom recipient list cannot be empty.',
    messageThai: 'กรุณาเพิ่มอีเมลในรายการกำหนดเอง',
  },
  broadcast_custom_recipient_too_many: {
    message: 'Custom recipient list is limited to 100 entries.',
    messageThai: 'รายการกำหนดเองจำกัดที่ 100 รายการ',
  },
  broadcast_empty_segment_blocked: {
    message: 'No eligible recipients found for this segment.',
    messageThai: 'ไม่พบผู้รับที่ตรงกับเงื่อนไขที่เลือก',
  },
  broadcast_audience_too_large: {
    message: 'Audience exceeds the 5,000 recipient limit.',
    messageThai: 'จำนวนผู้รับเกินขีดจำกัด 5,000 ราย',
  },
  broadcast_immutable_after_submit: {
    message: 'This broadcast has been submitted and can no longer be edited.',
    messageThai: 'E-Blast นี้ถูกส่งแล้วและแก้ไขไม่ได้',
  },
  broadcast_not_found: {
    message: 'Broadcast not found.',
    messageThai: 'ไม่พบ E-Blast',
  },
  broadcast_invalid_state_transition: {
    message:
      'This broadcast is not in a state that allows that action — it may have been processed by another admin.',
    messageThai:
      'สถานะของ E-Blast ไม่อนุญาตให้ดำเนินการนี้ — อาจถูกอนุมัติหรือปฏิเสธโดยอดมินคนอื่นแล้ว',
  },
  broadcast_concurrent_action_blocked: {
    message: 'Another admin acted on this broadcast at the same time. Please refresh and try again.',
    messageThai: 'อดมินคนอื่นกำลังดำเนินการกับ E-Blast นี้พร้อมกัน กรุณารีเฟรชแล้วลองใหม่',
  },
  broadcast_cancel_too_late: {
    message:
      'This broadcast can no longer be cancelled — it has already started sending or completed.',
    messageThai:
      'ยกเลิก E-Blast นี้ไม่ได้แล้ว — ส่งไปแล้วหรือดำเนินการเสร็จสิ้น',
  },
  broadcast_schedule_too_soon: {
    message: 'Scheduled time must be at least 5 minutes in the future.',
    messageThai: 'เวลานัดหมายต้องอยู่ในอนาคตอย่างน้อย 5 นาที',
  },
  broadcast_rejection_reason_required: {
    message: 'A non-empty rejection reason is required.',
    messageThai: 'กรุณากรอกเหตุผลในการปฏิเสธ',
  },
  broadcast_rejection_reason_too_long: {
    message: 'Rejection reason must be 2,000 characters or fewer.',
    messageThai: 'เหตุผลในการปฏิเสธต้องมีไม่เกิน 2,000 ตัวอักษร',
  },
  broadcast_cancel_reason_too_long: {
    message: 'Cancellation reason must be 500 characters or fewer.',
    messageThai: 'เหตุผลในการยกเลิกต้องมีไม่เกิน 500 ตัวอักษร',
  },
  broadcast_member_not_found: {
    message: 'Member not found in this tenant.',
    messageThai: 'ไม่พบสมาชิกในผู้เช่ารายนี้',
  },
  invalid_body: {
    message: 'Request body is invalid.',
    messageThai: 'ข้อมูลคำขอไม่ถูกต้อง',
  },
  forbidden: {
    message: 'You do not have permission to perform this action.',
    messageThai: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
  },
  feature_disabled: {
    message: 'Email broadcasts are temporarily unavailable.',
    messageThai: 'ระบบ E-Blast ปิดใช้งานชั่วคราว',
  },
  internal_error: {
    message: 'An unexpected error occurred. Please try again.',
    messageThai: 'เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง',
  },
};

export function messagesFor(code: F7RouteErrorCode): BilingualMessage {
  return F7_ERROR_MESSAGES[code];
}

export function baseHeaders(
  correlationId: string,
  extra?: Record<string, string>,
): HeadersInit {
  return {
    'Cache-Control': 'no-store, private',
    'X-Correlation-Id': correlationId,
    ...(extra ?? {}),
  };
}

export interface ErrorResponseExtra {
  /** Seconds before client may retry. Used on 429 broadcast_rate_limit_exceeded. */
  readonly retryAfterSeconds?: number;
  /** Per-field zod validation messages. Used on 400 invalid_body. */
  readonly fieldErrors?: Record<string, string[]>;
  /** Code-specific structured details (matches contracts/broadcasts-api.md § 1.3). */
  readonly details?: Record<string, unknown>;
}

export function errorResponse(
  status: number,
  code: F7RouteErrorCode,
  correlationId: string,
  extra?: ErrorResponseExtra,
): NextResponse {
  const { message, messageThai } = messagesFor(code);
  const body: Record<string, unknown> = {
    error: {
      code,
      message,
      messageThai,
      ...(extra?.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}),
      ...(extra?.details ? { details: extra.details } : {}),
    },
    correlationId,
  };
  const extraHeaders: Record<string, string> = {};
  if (extra?.retryAfterSeconds !== undefined) {
    extraHeaders['Retry-After'] = String(extra.retryAfterSeconds);
  }
  return NextResponse.json(body, {
    status,
    headers: baseHeaders(correlationId, extraHeaders),
  });
}

/**
 * Resolve the tenant's display name for the broadcast `from_name` field.
 *
 * F4 tenant_invoice_settings carries the canonical legal name per tenant
 * (e.g., "Swedish Chamber of Commerce" rather than the internal slug
 * "swecham"). When the settings row is missing or the legal name is
 * blank (early-tenant onboarding state), fall back to the tenant slug
 * so dispatch is never blocked on cosmetic data.
 *
 * Cached per-request via the closure created in each route handler;
 * no module-level cache (avoid stale display names after F4 settings
 * upsert).
 */
export async function resolveTenantDisplayName(
  tenantId: string,
): Promise<string> {
  try {
    const settings = await drizzleTenantSettingsRepo.getForIssue(tenantId);
    if (settings !== null && settings.identity.legal_name_en.length > 0) {
      return settings.identity.legal_name_en;
    }
  } catch {
    // Best-effort — never 5xx the broadcast submit because settings
    // lookup failed. Fall through to slug.
  }
  return tenantId;
}

/**
 * Status-code map for known F7 error kinds. Mirrors F4/F5's data-driven
 * pattern — adding a new code requires updating both this map and the
 * `F7RouteErrorCode` union (TS will fail compile if either drifts).
 */
const F7_ERROR_STATUS: Record<F7RouteErrorCode, number> = {
  broadcast_member_halted_pending_review: 422,
  broadcast_rate_limit_exceeded: 429,
  broadcast_not_in_plan: 422,
  broadcast_quota_blocked: 422,
  broadcast_member_missing_primary_contact_email: 422,
  broadcast_subject_too_long: 422,
  broadcast_subject_empty: 422,
  broadcast_body_too_large: 422,
  broadcast_body_unsafe_html: 422,
  broadcast_custom_recipient_unknown: 422,
  broadcast_custom_recipient_invalid_format: 422,
  broadcast_custom_recipient_empty: 422,
  broadcast_custom_recipient_too_many: 422,
  broadcast_empty_segment_blocked: 422,
  broadcast_audience_too_large: 422,
  broadcast_immutable_after_submit: 409,
  broadcast_not_found: 404,
  broadcast_invalid_state_transition: 409,
  broadcast_concurrent_action_blocked: 409,
  broadcast_cancel_too_late: 409,
  broadcast_schedule_too_soon: 422,
  broadcast_rejection_reason_required: 400,
  broadcast_rejection_reason_too_long: 400,
  broadcast_cancel_reason_too_long: 400,
  broadcast_member_not_found: 404,
  invalid_body: 400,
  forbidden: 403,
  feature_disabled: 503,
  internal_error: 500,
};

function isF7RouteErrorCode(kind: string): kind is F7RouteErrorCode {
  return Object.prototype.hasOwnProperty.call(F7_ERROR_STATUS, kind);
}

/**
 * Maps an Application-layer error kind to its (status, code) HTTP pair.
 *
 * Type safety: the `Record<F7RouteErrorCode, number>` map enforces at
 * compile time that every code in the `F7RouteErrorCode` union has a
 * status — adding a code to the union without a status is TS2741.
 * However the function signature is `kind: string` — Application-layer
 * errors that are NEW + not yet added to the union compile fine and
 * silently fall through to 500. Application use-cases SHOULD widen the
 * union when they add new error kinds; the TS2741 will then surface in
 * this file. Route handlers should map their domain-specific kinds
 * before invoking this generic fallback.
 */
export function httpStatusForBroadcastError(kind: string): {
  readonly status: number;
  readonly code: F7RouteErrorCode;
} {
  if (isF7RouteErrorCode(kind)) {
    return { status: F7_ERROR_STATUS[kind], code: kind };
  }
  return { status: 500, code: 'internal_error' };
}
