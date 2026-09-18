/**
 * F119 T032 — the shared half of the two preview endpoints
 * (`POST /api/broadcasts/preview` for the member compose + sign-off compare,
 * `POST /api/admin/broadcasts/preview` for the staff format surface). Each
 * route owns its gate and its `surface`; this module owns the body contract,
 * the limiter key and the response envelope so the two can never drift —
 * the `broadcasts-recipient-count.ts` precedent (research R11).
 *
 * Order of checks is the contract: gate (in the route) → body shape (400
 * `invalid_body`, decided BEFORE the limiter so an oversize body cannot burn
 * a token) → 30 renders / minute per (tenant, actor), consumed BEFORE the
 * render (429 + `Retry-After` — an amplification guard on a server-side
 * render, not a workflow limit) → `renderBroadcastPreview` → 200 `{ html }`
 * (a full document for `<iframe srcdoc>`). No audit event.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { makeRenderBroadcastPreviewDeps } from '@/lib/broadcast-brand-deps';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import {
  broadcastsRateLimiter,
  renderBroadcastPreview,
  PREVIEW_BODY_MAX_BYTES,
  PREVIEW_SUBJECT_MAX,
  type PreviewSurface,
} from '@/modules/broadcasts';

/** Research R11 + spec § Roles — 30 renders per minute per actor, atomic. */
export const PREVIEW_RATE_MAX = 30;
export const PREVIEW_RATE_WINDOW_SECONDS = 60;

export function previewRateKey(tenantSlug: string, userId: string): string {
  return `broadcasts:preview:${tenantSlug}:${userId}`;
}

// `max` on the body is a character bound ≥ the byte cap: the use case applies
// the exact 200 KB byte rule; this only stops a multi-megabyte payload at the
// door. An empty subject is allowed — the compose preview renders before
// the subject is typed.
export const previewBodySchema = z.object({
  subject: z.string().max(PREVIEW_SUBJECT_MAX),
  bodyHtml: z.string().max(PREVIEW_BODY_MAX_BYTES),
  locale: z.enum(['en', 'th', 'sv']),
});

export type PreviewBody = z.infer<typeof previewBodySchema>;

export function parsePreviewBody(raw: unknown): PreviewBody | null {
  const parsed = previewBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface PreviewActor {
  readonly tenantSlug: string;
  readonly userId: string;
  readonly surface: PreviewSurface;
}

/** Everything after the gate: parse → limit → render → respond. */
export async function handlePreview(
  request: Request,
  actor: PreviewActor,
  correlationId: string,
): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const body = parsePreviewBody(raw);
  if (body === null) return errorResponse(400, 'invalid_body', correlationId);

  const limit = await broadcastsRateLimiter.checkLimit(
    previewRateKey(actor.tenantSlug, actor.userId),
    PREVIEW_RATE_MAX,
    PREVIEW_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
      details: { retryAfterSeconds: limit.error.retryAfterSeconds },
    });
  }

  try {
    const { tenantDisplayName, ...deps } = await makeRenderBroadcastPreviewDeps(actor.tenantSlug);
    const result = await renderBroadcastPreview(deps, {
      tenantId: actor.tenantSlug as never,
      tenantDisplayName,
      subject: body.subject,
      bodyHtml: body.bodyHtml,
      locale: body.locale,
      surface: actor.surface,
    });
    if (!result.ok) {
      if (result.error.kind === 'invalid_body') {
        return errorResponse(400, 'invalid_body', correlationId, { details: { reason: result.error.reason } });
      }
      logger.error(
        { err: result.error.reason, correlationId, errorId: `M119.${actor.surface}.preview.sanitizer` },
        'broadcasts.preview.sanitizer_unavailable',
      );
      return errorResponse(500, 'internal_error', correlationId);
    }
    return NextResponse.json({ html: result.value.html }, { status: 200, headers: baseHeaders(correlationId) });
  } catch (e) {
    logger.error({ err: errKind(e), correlationId, errorId: `M119.${actor.surface}.preview.render` }, 'broadcasts.preview.failed');
    return errorResponse(500, 'internal_error', correlationId);
  }
}
