/**
 * F119 T145 — the two halves the member and staff draft/quota routes MUST
 * agree on, byte for byte.
 *
 * `/api/broadcasts/draft` + `/api/broadcasts/quota` (member session) and
 * `/api/admin/broadcasts/draft` + `/api/admin/broadcasts/quota` (staff session,
 * member named in the request) run the SAME two use cases and are consumed by
 * the SAME two client components — `compose-form.tsx` / `proxy-compose-form.tsx`
 * share a draft-save helper, and `QuotaDisplay` takes only an endpoint. FR-039
 * ("the writing tool MUST be the same") is a promise about behaviour, so the
 * envelope and the error mapping live here rather than being copied into the
 * staff routes, where they could drift a field at a time.
 */
import type { NextResponse } from 'next/server';
import {
  designBlockErrorResponse,
  errorResponse,
  httpStatusForBroadcastError,
} from '@/lib/broadcasts-route-helpers';
import type { SaveDraftError } from '@/modules/broadcasts';

/** The `saveDraft` success envelope both draft routes return. */
export function draftResponseBody(broadcast: {
  readonly broadcastId: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly subject: string;
  readonly segmentType: string;
  readonly segmentParams: unknown;
  readonly customRecipientEmails: unknown;
  readonly scheduledFor: Date | null;
}): Record<string, unknown> {
  return {
    broadcastId: broadcast.broadcastId,
    status: broadcast.status,
    createdAt: broadcast.createdAt.toISOString(),
    updatedAt: broadcast.updatedAt.toISOString(),
    subject: broadcast.subject,
    segmentType: broadcast.segmentType,
    segmentParams: broadcast.segmentParams,
    customRecipientEmails: broadcast.customRecipientEmails,
    scheduledFor: broadcast.scheduledFor?.toISOString() ?? null,
  };
}

/** `SaveDraftError` → the bilingual envelope, identical on both routes. */
export function mapSaveDraftError(
  error: SaveDraftError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'sanitizer_unavailable' || error.kind === 'save_draft.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }
  // F119 FR-041 (security review F1-2) — the design-block codes are their own
  // 422s (`cta_text_length` / `too_many_cta` / `cta_link_scheme` /
  // `banner_alt_required`), not one generic kind, so they cannot go through
  // `httpStatusForBroadcastError(error.kind)`.
  if (error.kind === 'content_rules') {
    return designBlockErrorResponse(error.violations, correlationId);
  }
  const { status, code } = httpStatusForBroadcastError(error.kind);
  const details: Record<string, unknown> = {};
  if (error.kind === 'broadcast_subject_too_long' && 'length' in error) {
    details['submittedLength'] = error.length;
  } else if (error.kind === 'broadcast_body_too_large' && 'bytes' in error) {
    details['submittedSize'] = error.bytes;
  } else if (error.kind === 'broadcast_body_unsafe_html' && 'reason' in error) {
    details['reason'] = error.reason;
  } else if (
    error.kind === 'broadcast_member_missing_primary_contact_email' &&
    'memberId' in error
  ) {
    details['memberId'] = error.memberId;
  } else if (error.kind === 'broadcast_immutable_after_submit') {
    details['broadcastId'] = error.broadcastId;
    details['currentStatus'] = error.currentStatus;
  } else if (error.kind === 'broadcast_not_found') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}

/**
 * The `computeQuotaCounter` success envelope both quota routes return.
 *
 * Smart-4: `planCode` is humanised to a display name ("premium_corporate" →
 * "Premium Corporate") rather than extending the F2 bridge contract for a UI
 * label.
 */
export function quotaResponseBody(value: {
  readonly counter: {
    readonly used: number;
    readonly reserved: number;
    readonly remaining: number;
    readonly cap: number;
  };
  readonly quotaYear: number;
  readonly planCode: string;
  readonly planId: string;
  readonly nextResetAt: string;
  readonly tenantTimezone: string;
}): Record<string, unknown> {
  const { counter, quotaYear, planCode, planId, nextResetAt, tenantTimezone } = value;
  const planName =
    planCode.length > 0
      ? planCode
          .split(/[_-]/)
          .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
          .join(' ')
      : null;

  return {
    planId,
    planCode,
    planName,
    eblastPerYear: counter.cap,
    quotaYear,
    used: counter.used,
    reserved: counter.reserved,
    remaining: counter.remaining,
    cap: counter.cap,
    nextResetAt,
    tenantTimezone,
  };
}
