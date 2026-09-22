/**
 * T077 (F7.1a US2) · F119 T033 / T146 — POST /api/broadcasts/inline-image-upload
 *
 * Member role + tenant ctx + the REAL draft-ownership check (T146: `draftId`
 * used to be an unvalidated form string although this header claimed a
 * check). Multipart upload pipeline (FR-012 + FR-013 + FR-040):
 *   - 60 / minute per (tenant, user) member write bucket, consumed ABOVE the
 *     ownership read, the blob write and the ClamAV call (T026a / T146)
 *   - ownership: the caller's own member AND a `draft` they own; another
 *     member's row → 404 + `broadcast_cross_member_probe`; an unknown or
 *     other-tenant id → 404 + `broadcast_cross_tenant_probe`; a closed
 *     broadcast → 409 (never 403 — no existence leak)
 *   - 5 MB hard cap, png/jpeg/webp/gif, SHA-256 dedup, fail-closed ClamAV,
 *     tenant-scoped Vercel Blob path, and ONE `broadcast_images` row +
 *     `broadcast_image_uploaded` audit carrying snake_case `member_id`
 *     (the 0009 `last_activity_at` trigger key — a member illustrating
 *     their own draft IS member activity)
 * Shared handler: `src/lib/broadcasts-image-upload-route.ts`.
 *
 * Pinned to Node runtime — the ClamAV adapter and the Blob client need
 * Node APIs. Pipeline-order invariant (FR-013): bytes NEVER reach storage
 * before verdict=clean; rejected uploads are NEVER persisted.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { handleImageUpload } from '@/lib/broadcasts-image-upload-route';
import { baseHeaders } from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { f71aUs2DisabledReason, isF71aUs2Enabled, parseBroadcastId } from '@/modules/broadcasts';

export const runtime = 'nodejs';
// ClamAV scan + Blob upload can take 5-10 s at the 5 MB cap.
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs2Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs2DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  // The draft id rides the multipart body. Security review F1-3 (2026-09-22):
  // this used to be `await request.clone().formData()` HERE, which buffered
  // and parsed the whole body before the shared handler's `content-length`
  // 413 guard ran — and the handler then parsed it a second time. The shared
  // handler now hands us the ONE parsed form, after the 413.
  return handleImageUpload(
    request,
    {
      tenant: ctx.tenant,
      owner: {
        kind: 'broadcast',
        field: 'draftId',
        readOwnerId: (form) => {
          const draftId = form.get('draftId');
          return typeof draftId === 'string' && parseBroadcastId(draftId).ok ? draftId : null;
        },
      },
      actor: {
        kind: 'member',
        memberId: ctx.member.memberId as unknown as string,
        userId: ctx.current.user.id,
        email: ctx.current.user.email,
        role: ctx.current.user.role ?? null,
      },
      surface: 'member',
    },
    correlationId,
  );
}
