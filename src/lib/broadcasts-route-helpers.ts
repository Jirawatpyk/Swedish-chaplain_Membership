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
 * Maps an Application-layer error kind from `submit-broadcast.ts` (or
 * `save-draft.ts`) to its (status, code) HTTP pair. Single source of
 * truth — route handlers MUST use this to keep the mapping consistent.
 */
export function httpStatusForBroadcastError(kind: string): {
  readonly status: number;
  readonly code: F7RouteErrorCode;
} {
  switch (kind) {
    case 'broadcast_member_halted_pending_review':
      return { status: 422, code: 'broadcast_member_halted_pending_review' };
    case 'broadcast_rate_limit_exceeded':
      return { status: 429, code: 'broadcast_rate_limit_exceeded' };
    case 'broadcast_not_in_plan':
      return { status: 422, code: 'broadcast_not_in_plan' };
    case 'broadcast_quota_blocked':
      return { status: 422, code: 'broadcast_quota_blocked' };
    case 'broadcast_member_missing_primary_contact_email':
      return {
        status: 422,
        code: 'broadcast_member_missing_primary_contact_email',
      };
    case 'broadcast_subject_too_long':
      return { status: 422, code: 'broadcast_subject_too_long' };
    case 'broadcast_subject_empty':
      return { status: 422, code: 'broadcast_subject_empty' };
    case 'broadcast_body_too_large':
      return { status: 422, code: 'broadcast_body_too_large' };
    case 'broadcast_body_unsafe_html':
      return { status: 422, code: 'broadcast_body_unsafe_html' };
    case 'broadcast_custom_recipient_unknown':
      return { status: 422, code: 'broadcast_custom_recipient_unknown' };
    case 'broadcast_custom_recipient_invalid_format':
      return {
        status: 422,
        code: 'broadcast_custom_recipient_invalid_format',
      };
    case 'broadcast_custom_recipient_empty':
      return { status: 422, code: 'broadcast_custom_recipient_empty' };
    case 'broadcast_custom_recipient_too_many':
      return { status: 422, code: 'broadcast_custom_recipient_too_many' };
    case 'broadcast_empty_segment_blocked':
      return { status: 422, code: 'broadcast_empty_segment_blocked' };
    case 'broadcast_audience_too_large':
      return { status: 422, code: 'broadcast_audience_too_large' };
    case 'broadcast_immutable_after_submit':
      return { status: 409, code: 'broadcast_immutable_after_submit' };
    case 'broadcast_not_found':
      return { status: 404, code: 'broadcast_not_found' };
    default:
      return { status: 500, code: 'internal_error' };
  }
}
