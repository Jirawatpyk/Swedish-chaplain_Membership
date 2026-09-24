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
import { logger } from '@/lib/logger';
import type { BlockViolations, BroadcastVersion } from '@/modules/broadcasts';

/**
 * Closed union of every F7 route error code. Mirrors the union of
 * Application use-case errors plus a few HTTP-only codes for invalid
 * input + auth + kill-switch.
 */
export type F7RouteErrorCode =
  // Submit preconditions (FR-002 a–k + FR-016a)
  | 'broadcast_member_halted_pending_review'
  // 059-membership-suspension Task 5/8/15 — a suspended/terminated member
  // (F8 `deriveMembershipAccess`) is blocked from spending E-Blast quota.
  // Runs before rate-limit/plan/quota in `submit-broadcast.ts`; mirrors
  // `broadcast_quota_blocked` at 422 (policy reject, not infra failure —
  // a lookup *error* fails closed to `submit.server_error` → 500 instead).
  | 'broadcast_membership_suspended_blocked'
  | 'broadcast_rate_limit_exceeded'
  | 'broadcast_not_in_plan'
  | 'broadcast_quota_blocked'
  | 'broadcast_member_missing_primary_contact_email'
  | 'broadcast_subject_too_long'
  | 'broadcast_subject_empty'
  | 'broadcast_body_too_large'
  | 'broadcast_body_unsafe_html'
  // PR-review fix 2026-05-20 UX-C1 — F7.1a US2 FR-011 / AS2 closure.
  | 'broadcast_body_image_source_unsafe'
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
  // COMP-1 PR-review (FIX C) — proxied member is GDPR-Art.17/PDPA-§33 erased
  // (`erased_at IS NOT NULL`). 409 (existed-then-erased terminal state), distinct
  // from broadcast_member_not_found (404 — never existed in this tenant).
  | 'broadcast_member_erased'
  // F7.1a US1 — admin retry + partial-delivery flows
  | 'broadcast_manual_retry_budget_exhausted'
  | 'broadcast_already_retrying_in_progress'
  | 'broadcast_partial_delivery_reason_too_long'
  // Generic HTTP-shape codes
  | 'invalid_body'
  | 'forbidden'
  | 'feature_disabled'
  // R3.6 L-1 — typed code for 401 unauthenticated requests on member-
  // facing surfaces (was stringly-typed 'no-session' in templates GET
  // route). Provides bilingual message + status mapping.
  | 'no_session'
  // R4.2 H-1 — typed code for 400 invalid `locale` query parameter on
  // GET /api/broadcasts/templates. Was stringly-typed 'invalid_locale'
  // via `jsonError(400, 'invalid_locale', ...)` pre-R4.2; now flows
  // through `errorResponse` so the bilingual envelope lands.
  | 'invalid_locale'
  // 108 PR-C T088 — recipient-count endpoints (contract broadcast-audience § 5)
  | 'invalid_query'
  | 'count_unavailable'
  // F119 — brand settings (FR-041b): white text on the colour is below WCAG
  // AA 4.5:1 (422, details { ratio, required }); a malformed `#RRGGBB` or an
  // address over 300 chars (422). Distinct from `invalid_body` (400 — the
  // request SHAPE is wrong) because the client renders these as field errors.
  | 'colour_contrast'
  | 'validation_error'
  // F119 — design-block content rules (FR-041), refused 422 at every save,
  // at send-to-member and on the test copy, naming the block by index.
  | 'cta_text_length'
  | 'too_many_cta'
  | 'cta_link_scheme'
  | 'banner_alt_required'
  // F119 — the synchronous test copy could not be handed to the mailer (503).
  | 'test_copy_unavailable'
  // F119 F7-5 — the mailer PERMANENTLY refused the test copy (422): Resend
  // `validation_error` or `invalid_to_address`, so the session address OR the
  // chamber's sending setup (F7-6 — the copy must not blame the address). A
  // retry cannot help, so it must not share the 503 "try again" copy.
  | 'test_copy_invalid_recipient'
  // F119 review finding F2-6 — a 0-byte file (400). The DB CHECK on
  // `broadcast_images.byte_size` is `BETWEEN 1 AND 5 MB`; before this code
  // existed an empty upload passed MIME + the size cap, was scanned, was PUT,
  // and only then violated the CHECK — a 500 for the member plus an orphan
  // blob with no row that the sweep could never reach.
  | 'broadcast_image_empty'
  // F119 PR-2 — the staff formatting routes (`…/[id]/version`,
  // contracts/admin-eblast-formatting-api.md). `stage_changed` (409): the
  // re-read row is not in a stage the action accepts; `round_zero` (409): an
  // approve-as-submitted E-Blast was never in a design round; `version_changed`
  // (409): another save moved the working copy on (optimistic concurrency,
  // carries `currentUpdatedAt` + the current content); `no_working_copy` (409);
  // `unsafe_content` (422): the sanitiser left nothing of the body;
  // `image_source_not_allowlisted` (422): names every image whose host is off
  // the tenant allow-list.
  | 'stage_changed'
  | 'round_zero'
  | 'version_changed'
  | 'no_working_copy'
  | 'unsafe_content'
  | 'image_source_not_allowlisted'
  // F119 PR-2 — `…/[id]/version/send` and `…/[id]/schedule`. `no_portal_user`
  // (409): nobody at the member company can sign in to approve;
  // `no_proposal` (409): `keep_proposal` on a row with no recorded proposal;
  // `mode_not_allowed` (409): the schedule mode is not one the row's stage
  // accepts (`keep_proposal` once scheduled, `cancel` before).
  | 'no_portal_user'
  | 'no_proposal'
  | 'mode_not_allowed'
  // F119 PR-2 — the member decision (`POST /api/broadcasts/[id]/decision`)
  // and the widened withdraw / reject / cancel. `reason_required` (422): a
  // change request or a withdrawn approval without a reason (FR-010);
  // `stale_version` (409): the member decided on an older round than the one
  // now awaiting them (carries the current version); `sending_started` (409):
  // the E-Blast has been handed to the delivery provider — the send
  // completes (FR-015).
  | 'reason_required'
  | 'stale_version'
  | 'sending_started'
  // F119 T166 S-H1 — the send-time standing rules, re-read at approve-as-
  // submitted and at the approval-round promotion (409 — the E-Blast is not
  // approved; submit keeps its own 422 codes above).
  | 'member_halted'
  | 'member_not_in_good_standing'
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
  broadcast_membership_suspended_blocked: {
    message:
      'Your membership benefits are suspended. Please complete payment to resume sending E-Blasts.',
    messageThai:
      'สิทธิประโยชน์สมาชิกภาพของคุณถูกระงับ กรุณาชำระเงินเพื่อกลับมาส่ง E-Blast ได้อีกครั้ง',
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
  broadcast_body_image_source_unsafe: {
    message:
      'Message body contains images from sources not in your chamber\'s allowlist. Replace or remove the listed images.',
    messageThai:
      'เนื้อหาอีเมลมีรูปภาพจากแหล่งที่ไม่อยู่ในรายการอนุญาตของหอการค้า กรุณาเปลี่ยนหรือลบรูปภาพที่ระบุไว้',
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
  // Review 2026-09-07 round 2 (C11, FR-042): the ceiling has ONE definition
  // — `details.cap` on this same body carries it; the copy no longer states
  // a number that becomes a lie the day the flag flips.
  broadcast_audience_too_large: {
    message: 'Audience exceeds the recipient limit.',
    messageThai: 'จำนวนผู้รับเกินขีดจำกัด',
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
    // Neutral wording: accurate whether the broadcast already finished sending,
    // is a non-split send already at Resend, or lost a mid-send halt race
    // (last pending batch dispatched). Avoids claiming "started/finished sending"
    // which contradicts the admin halt control surfaced for in-flight sends.
    message:
      'This broadcast can no longer be cancelled — it is past the point where it can be stopped.',
    messageThai:
      'ยกเลิก E-Blast นี้ไม่ได้แล้ว — เลยจุดที่หยุดได้แล้ว',
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
  broadcast_member_erased: {
    message: 'This member has been erased and can no longer be acted on.',
    messageThai: 'สมาชิกรายนี้ถูกลบข้อมูลแล้ว ไม่สามารถดำเนินการต่อได้',
  },
  // F7.1a US1 — admin retry + partial-delivery error messages
  broadcast_manual_retry_budget_exhausted: {
    message:
      'All 3 manual retry attempts have been used. Consider accepting partial delivery.',
    messageThai:
      'ใช้สิทธิ์ลองส่งซ้ำครบ 3 ครั้งแล้ว ลองยอมรับการส่งบางส่วนแทน',
  },
  broadcast_already_retrying_in_progress: {
    message:
      'Another admin is currently retrying this broadcast. Please wait a moment and refresh.',
    messageThai:
      'มีผู้ดูแลคนอื่นกำลังลองส่งซ้ำ E-Blast นี้อยู่ กรุณารอสักครู่แล้วรีเฟรช',
  },
  broadcast_partial_delivery_reason_too_long: {
    message: 'Reason must be 500 characters or fewer.',
    messageThai: 'เหตุผลต้องมีไม่เกิน 500 ตัวอักษร',
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
  no_session: {
    message: 'You must be signed in to access this resource.',
    messageThai: 'คุณต้องเข้าสู่ระบบเพื่อเข้าถึงทรัพยากรนี้',
  },
  invalid_locale: {
    message: 'The locale parameter is invalid (must be one of: en, th, sv).',
    messageThai: 'พารามิเตอร์ภาษาไม่ถูกต้อง (ต้องเป็น en, th, หรือ sv)',
  },
  // 108 PR-C T088 — recipient-count endpoints.
  invalid_query: {
    message: 'The recipient-count query is invalid.',
    messageThai: 'พารามิเตอร์สำหรับนับผู้รับไม่ถูกต้อง',
  },
  count_unavailable: {
    message: 'The recipient count is unavailable right now. You can still submit; the server recomputes the audience.',
    messageThai: 'ไม่สามารถนับจำนวนผู้รับได้ในขณะนี้ คุณยังส่งได้ตามปกติ ระบบจะคำนวณผู้รับใหม่ฝั่งเซิร์ฟเวอร์',
  },
  colour_contrast: {
    message: 'White text on this colour does not meet the WCAG AA contrast ratio of 4.5:1. The previous colour stays in force.',
    messageThai: 'ตัวอักษรสีขาวบนสีนี้ไม่ผ่านอัตราส่วนความคมชัด WCAG AA 4.5:1 ระบบยังใช้สีเดิมต่อไป',
  },
  validation_error: {
    message: 'One or more fields are invalid.',
    messageThai: 'มีบางช่องข้อมูลไม่ถูกต้อง',
  },
  cta_text_length: {
    message: 'Button text must be between 1 and 60 characters.',
    messageThai: 'ข้อความบนปุ่มต้องมีความยาว 1–60 ตัวอักษร',
  },
  too_many_cta: {
    message: 'A message can carry at most 3 call-to-action buttons.',
    messageThai: 'ข้อความหนึ่งมีปุ่ม call-to-action ได้ไม่เกิน 3 ปุ่ม',
  },
  cta_link_scheme: {
    message: 'A button link must start with http://, https:// or mailto:.',
    messageThai: 'ลิงก์ของปุ่มต้องขึ้นต้นด้วย http://, https:// หรือ mailto:',
  },
  banner_alt_required: {
    message: 'A banner image needs a description of 1 to 125 characters.',
    messageThai: 'รูปแบนเนอร์ต้องมีคำอธิบายความยาว 1–125 ตัวอักษร',
  },
  test_copy_unavailable: {
    message: 'The test copy could not be sent right now. Please try again in a moment.',
    messageThai: 'ไม่สามารถส่งสำเนาทดสอบได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
  },
  test_copy_invalid_recipient: {
    message:
      "The email provider refused this test copy (for example because of the address you sign in with, or the chamber's email sending setup). Trying again will not help. Please contact your chamber administrator.",
    messageThai:
      'ผู้ให้บริการอีเมลปฏิเสธการส่งสำเนาทดสอบนี้ (อาจเกิดจากอีเมลที่คุณใช้เข้าสู่ระบบ หรือการตั้งค่าการส่งอีเมลของหอการค้า) การลองส่งใหม่จะไม่ช่วยแก้ปัญหา กรุณาติดต่อผู้ดูแลระบบของหอการค้า',
  },
  stage_changed: {
    message: 'This E-Blast has moved to another stage. Reload to see where it is now.',
    messageThai: 'E-Blast นี้เปลี่ยนไปอยู่ขั้นตอนอื่นแล้ว กรุณาโหลดหน้าใหม่เพื่อดูสถานะปัจจุบัน',
  },
  round_zero: {
    message: 'This E-Blast was approved as submitted, without a formatting round, so there is no approved version to reopen.',
    messageThai: 'E-Blast นี้ได้รับอนุมัติตามที่ส่งมาโดยไม่มีรอบจัดรูปแบบ จึงไม่มีฉบับที่อนุมัติให้เปิดแก้ไขใหม่',
  },
  version_changed: {
    message: 'Someone else saved this version after you opened it. Review their changes before saving again.',
    messageThai: 'มีผู้อื่นบันทึกฉบับนี้หลังจากที่คุณเปิด กรุณาตรวจสอบการเปลี่ยนแปลงก่อนบันทึกอีกครั้ง',
  },
  no_working_copy: {
    message: 'There is no working copy to change. Start a formatted version first.',
    messageThai: 'ไม่มีฉบับร่างสำหรับแก้ไข กรุณาเริ่มฉบับจัดรูปแบบก่อน',
  },
  unsafe_content: {
    message: 'The message content was refused by the content-safety rules. Remove the unsupported content and try again.',
    messageThai: 'เนื้อหาข้อความไม่ผ่านกฎความปลอดภัยของเนื้อหา กรุณาลบเนื้อหาที่ไม่รองรับแล้วลองใหม่',
  },
  image_source_not_allowlisted: {
    message: 'One or more images are hosted on a site that is not on the allowed list. Replace those images and try again.',
    messageThai: 'มีรูปภาพที่โฮสต์บนเว็บไซต์ที่ไม่อยู่ในรายการที่อนุญาต กรุณาเปลี่ยนรูปภาพเหล่านั้นแล้วลองใหม่',
  },
  no_portal_user: {
    message:
      'Nobody at this member company can sign in to the portal to approve it. Approve it as submitted, or invite a portal user first.',
    messageThai:
      'ไม่มีผู้ใช้ของบริษัทสมาชิกนี้ที่เข้าสู่ระบบพอร์ทัลเพื่ออนุมัติได้ กรุณาอนุมัติตามที่ส่งมา หรือเชิญผู้ใช้พอร์ทัลก่อน',
  },
  no_proposal: {
    message: 'The member did not propose a send time. Choose a time instead.',
    messageThai: 'สมาชิกไม่ได้เสนอเวลาส่ง กรุณาเลือกเวลาแทน',
  },
  mode_not_allowed: {
    message: 'That scheduling option is not available at this stage. Reload to see what can be done now.',
    messageThai: 'ตัวเลือกการตั้งเวลานี้ใช้ไม่ได้ในขั้นตอนนี้ กรุณาโหลดหน้าใหม่เพื่อดูสิ่งที่ทำได้ในตอนนี้',
  },
  reason_required: {
    message: 'Please tell the chamber what should change.',
    messageThai: 'กรุณาระบุสิ่งที่ต้องการให้หอการค้าแก้ไข',
  },
  stale_version: {
    message: 'A newer version of this E-Blast is waiting for you. Review it before deciding.',
    messageThai: 'มีฉบับใหม่กว่าของ E-Blast นี้รอคุณอยู่ กรุณาตรวจสอบก่อนตัดสินใจ',
  },
  sending_started: {
    message: 'This E-Blast is already being sent and can no longer be withdrawn or stopped.',
    messageThai: 'E-Blast นี้กำลังถูกส่งแล้ว จึงไม่สามารถถอนหรือหยุดได้อีก',
  },
  member_halted: {
    message:
      "This member's E-Blasts are paused pending admin review, so it cannot be sent. Clear the pause first, or leave it unsent.",
    messageThai:
      'E-Blast ของสมาชิกรายนี้ถูกพักไว้รอผู้ดูแลตรวจสอบ จึงยังส่งไม่ได้ กรุณายกเลิกการพักก่อน หรือปล่อยไว้โดยไม่ส่ง',
  },
  member_not_in_good_standing: {
    message:
      "This member's membership is suspended or has ended, so this E-Blast cannot be sent. It can be sent once the membership is in good standing again.",
    messageThai:
      'สมาชิกภาพของสมาชิกรายนี้ถูกระงับหรือสิ้นสุดแล้ว จึงส่ง E-Blast นี้ไม่ได้ จะส่งได้เมื่อสมาชิกภาพกลับมาอยู่ในสถานะปกติ',
  },
  broadcast_image_empty: {
    message: 'That file is empty. Please choose an image file with content.',
    messageThai: 'ไฟล์นี้ว่างเปล่า กรุณาเลือกไฟล์รูปภาพที่มีข้อมูล',
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

/**
 * R2.2 A1 — Shared `{ error: code, ...extra }` envelope used by F7.1a
 * template + image-upload routes (admin templates, member snapshot,
 * upload). Distinct from `errorResponse` above (which wraps the
 * bilingual `messages[code]` envelope used by Submit/Save/Quota).
 *
 * Use this helper when the error surface speaks to a single audience
 * (admin-only or member-only) and the i18n is handled client-side
 * via the route's specific `admin.broadcasts.templates.errors.{code}`
 * key set. Use `errorResponse` for surfaces shared between member +
 * admin where bilingual server-side text is required.
 */
export function jsonError(
  status: number,
  code: string,
  correlationId: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: code, ...(extra ?? {}) },
    { status, headers: baseHeaders(correlationId) },
  );
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
 * F119 FR-041 — the ONE mapping from a design-block violation set to the 422
 * envelope, shared by the test copy, both draft routes and both submit routes.
 *
 * Security review F1-2 (2026-09-22): `validateBlocks` used to run only on the
 * test copy, so this mapping lived inline in `broadcasts-test-copy-route.ts`.
 * Now that five surfaces refuse the same way, the shape (the FIRST violation's
 * code as the error code, the whole list in `details.violations` so the
 * compose form can highlight every offending block at once) is defined here so
 * the surfaces cannot drift a field at a time.
 *
 * `violations` is non-empty by type (`BlockViolations`): a use case builds a
 * `content_rules` refusal only through `hasBlockViolations`, so there is no
 * empty-list arm to fall back from.
 */
export function designBlockErrorResponse(
  violations: BlockViolations,
  correlationId: string,
): NextResponse {
  return errorResponse(422, violations[0].code, correlationId, { details: { violations } });
}

/**
 * F119 FR-033 — the 409 `version_changed` body: the working copy's current
 * concurrency token and content, so the client can say "someone else changed
 * this" instead of overwriting. ONE shape for the save (`PATCH …/version`) and
 * the send (`POST …/version/send`, round-4 B1), so the workspace reads both
 * refusals the same way.
 */
export function versionChangedResponse(current: BroadcastVersion, correlationId: string): NextResponse {
  return errorResponse(409, 'version_changed', correlationId, {
    details: {
      currentUpdatedAt: current.updatedAt.toISOString(),
      current: {
        subject: current.subject,
        bodyHtml: current.bodyHtml,
        bodySource: current.bodySource,
        noteToMember: current.noteToMember,
      },
    },
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
  } catch (err) {
    // Best-effort — never 5xx the broadcast submit because settings
    // lookup failed. Fall through to slug.
    //
    // R6.4 (silent-failure-M5) — surface the failure at warn level so
    // SRE can correlate "members complain about email showing raw
    // slug instead of legal name" against schema-drift / RLS-config /
    // pool-exhaustion incidents. The bare `catch {}` made this class
    // of failure invisible per Constitution Principle VIII.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId,
      },
      'broadcasts.tenant_display_name.settings_lookup_failed',
    );
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
  broadcast_membership_suspended_blocked: 422,
  broadcast_rate_limit_exceeded: 429,
  broadcast_not_in_plan: 422,
  broadcast_quota_blocked: 422,
  broadcast_member_missing_primary_contact_email: 422,
  broadcast_subject_too_long: 422,
  broadcast_subject_empty: 422,
  broadcast_body_too_large: 422,
  broadcast_body_unsafe_html: 422,
  broadcast_body_image_source_unsafe: 422,
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
  broadcast_member_erased: 409,
  // F7.1a US1
  broadcast_manual_retry_budget_exhausted: 409,
  broadcast_already_retrying_in_progress: 409,
  broadcast_partial_delivery_reason_too_long: 400,
  invalid_body: 400,
  forbidden: 403,
  feature_disabled: 503,
  no_session: 401,
  invalid_locale: 400,
  invalid_query: 400,
  count_unavailable: 503,
  colour_contrast: 422,
  validation_error: 422,
  cta_text_length: 422,
  too_many_cta: 422,
  cta_link_scheme: 422,
  banner_alt_required: 422,
  test_copy_unavailable: 503,
  test_copy_invalid_recipient: 422,
  // F2-6 — the member can fix this one; 400, not a 413 and not a 500.
  broadcast_image_empty: 400,
  stage_changed: 409,
  round_zero: 409,
  version_changed: 409,
  no_working_copy: 409,
  unsafe_content: 422,
  image_source_not_allowlisted: 422,
  no_portal_user: 409,
  no_proposal: 409,
  mode_not_allowed: 409,
  reason_required: 422,
  stale_version: 409,
  sending_started: 409,
  member_halted: 409,
  member_not_in_good_standing: 409,
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
