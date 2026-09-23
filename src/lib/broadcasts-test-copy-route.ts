/**
 * F119 T105 — the shared half of the two test-copy endpoints
 * (`POST /api/broadcasts/test-copy` for a portal user,
 * `POST /api/admin/broadcasts/test-copy` for staff). Each route owns its
 * gate and resolves the actor; this module owns the body contract, the
 * 10 / hour bucket and the response envelope (FR-037).
 *
 * Order of checks is the contract: gate (in the route) → body shape (400
 * `invalid_body`; a `to` field is NOT part of the schema — the recipient is
 * the session address, always) → 10 test copies / hour per (tenant, user),
 * consumed BEFORE the send (429 + `Retry-After`) → `sendTestCopy` → 202
 * `{ messageId }` (the mail was handed to the transactional sender; delivery
 * is the provider's). 422 carries the design-block violation code, or
 * `test_copy_invalid_recipient` when the sender refused the session address
 * (retrying cannot help); 503 `test_copy_unavailable` when the sender is down.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { makeSendTestCopyDeps } from '@/lib/broadcast-test-copy-deps';
import { baseHeaders, designBlockErrorResponse, errorResponse } from '@/lib/broadcasts-route-helpers';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import {
  broadcastsRateLimiter,
  sendTestCopy,
  TEST_COPY_BODY_MAX_BYTES,
  TEST_COPY_SUBJECT_MAX,
} from '@/modules/broadcasts';

/** FR-037 / spec § Roles — 10 per user per hour, members and staff alike. */
export const TEST_COPY_RATE_MAX = 10;
export const TEST_COPY_RATE_WINDOW_SECONDS = 3600;

export function testCopyRateKey(tenantSlug: string, userId: string): string {
  return `broadcasts:test-copy:${tenantSlug}:${userId}`;
}

// No `to`, by design (FR-037). `broadcastId` / `versionId` are optional
// references for the audit row (PR-2 sends them from the format surface).
export const testCopyBodySchema = z.object({
  subject: z.string().max(TEST_COPY_SUBJECT_MAX),
  bodyHtml: z.string().max(TEST_COPY_BODY_MAX_BYTES),
  locale: z.enum(['en', 'th', 'sv']),
  broadcastId: z.string().uuid().nullable().optional(),
  versionId: z.string().uuid().nullable().optional(),
});

export interface TestCopyActor {
  readonly tenantSlug: string;
  readonly userId: string;
  readonly email: string;
  readonly role: string | null;
  readonly relatedMemberId: string | null;
  readonly surface: 'member' | 'staff';
}

export async function handleTestCopy(
  request: Request,
  actor: TestCopyActor,
  correlationId: string,
): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = testCopyBodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, 'invalid_body', correlationId);

  const limit = await broadcastsRateLimiter.checkLimit(
    testCopyRateKey(actor.tenantSlug, actor.userId),
    TEST_COPY_RATE_MAX,
    TEST_COPY_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
      details: { retryAfterSeconds: limit.error.retryAfterSeconds },
    });
  }

  try {
    const { tenantDisplayName, ...deps } = await makeSendTestCopyDeps(actor.tenantSlug);
    const result = await sendTestCopy(deps, {
      tenantId: actor.tenantSlug as never,
      tenantDisplayName,
      actorUserId: actor.userId,
      actorRole: actor.role,
      actorEmail: actor.email,
      relatedMemberId: actor.relatedMemberId,
      broadcastId: parsed.data.broadcastId ?? null,
      versionId: parsed.data.versionId ?? null,
      requestId: correlationId,
      subject: parsed.data.subject,
      bodyHtml: parsed.data.bodyHtml,
      locale: parsed.data.locale,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_body':
          return errorResponse(400, 'invalid_body', correlationId, { details: { reason: result.error.reason } });
        case 'content_rules':
          // F119 FR-041 — the same mapping the draft and submit routes use
          // since security review F1-2 wired `validateBlocks` into `saveDraft`
          // and `submitBroadcast`; it lives in `broadcasts-route-helpers.ts`
          // so the five surfaces cannot drift.
          return designBlockErrorResponse(result.error.violations, correlationId);
        // F2-9 — log the port's typed CODE, never `result.error.reason`: that
        // is the provider's verbatim message and Resend echoes the recipient
        // address back in it ("Invalid `to` field: …@…"), which is forbidden
        // in logs. Same house rule as `broadcasts-content-scrub-adapter.ts`.
        // F7-5 — the code (not the constant kind) is what tells a refused
        // address from an outage, in the log and on the wire.
        case 'mailer_unavailable':
          logger.warn(
            { err: result.error.code, correlationId, errorId: `M119.${actor.surface}.test_copy.mailer` },
            'broadcasts.test_copy.mailer_unavailable',
          );
          return result.error.code === 'invalid-recipient'
            ? errorResponse(422, 'test_copy_invalid_recipient', correlationId)
            : errorResponse(503, 'test_copy_unavailable', correlationId);
        case 'sanitizer_unavailable':
          logger.error(
            { err: result.error.kind, correlationId, errorId: `M119.${actor.surface}.test_copy.sanitizer` },
            'broadcasts.test_copy.sanitizer_unavailable',
          );
          return errorResponse(500, 'internal_error', correlationId);
      }
    }
    return NextResponse.json({ messageId: result.value.messageId }, { status: 202, headers: baseHeaders(correlationId) });
  } catch (e) {
    logger.error({ err: errKind(e), correlationId, errorId: `M119.${actor.surface}.test_copy` }, 'broadcasts.test_copy.failed');
    return errorResponse(500, 'internal_error', correlationId);
  }
}
