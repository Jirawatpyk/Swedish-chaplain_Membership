/**
 * F119 T032 — `POST /api/broadcasts/preview` (member compose + sign-off
 * compare; research R11, FR-043).
 *
 * Member gate (`requireMemberContext`), then the shared preview handler
 * (`src/lib/broadcasts-preview-route.ts`): 400 `invalid_body` over the
 * limits, 429 at 30 renders / minute per actor with `Retry-After`, 200
 * `{ html }` — a full document rendered by the SAME wrapper the sender
 * uses, for an `<iframe srcdoc>`. No audit event. Node runtime (the
 * sanitiser is jsdom-backed).
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { handlePreview } from '@/lib/broadcasts-preview-route';
import { requireMemberContext } from '@/lib/member-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }
  return handlePreview(
    request,
    { tenantSlug: ctx.tenant.slug, userId: ctx.current.user.id, surface: 'member' },
    correlationId,
  );
}
