/**
 * T077 (F7.1a US2) — POST /api/broadcasts/inline-image-upload
 *
 * Member role + tenant ctx + draft ownership check. Multipart upload
 * pipeline (FR-012 + FR-013):
 *   - 5 MB hard cap (Application use-case enforces; route also rejects
 *     unbounded streams at form-data parse)
 *   - ClamAV virus-scan via `VirusScannerPort`
 *   - Content-hash dedup via `ImageStoragePort`
 *   - Tenant-scoped Vercel Blob path `broadcasts/images/{tenant}/...`
 *
 * Pinned to Node runtime — the ClamAV `clamscan` adapter and Vercel
 * Blob client require Node APIs (Edge runtime breaks both).
 *
 * Pipeline-order invariant (FR-013): bytes NEVER reach storage before
 * verdict=clean. Rejected uploads (oversize / infected / scanner-
 * error) are NEVER persisted.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import { makeUploadInlineImageDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import {
  isF71aUs2Enabled,
  f71aUs2DisabledReason,
} from '@/modules/broadcasts/infrastructure/feature-flags';
import { runInTenant } from '@/lib/db';
import {
  baseHeaders,
  errorResponse,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// Increase route function timeout — ClamAV scan + Blob upload can take
// 5-10s for files at the 5 MB cap. The Application use-case has its
// own 5-min ClamAV scan timeout (FR-013 / T151 P10 pre-flight gap).
export const maxDuration = 60;

const MAX_FORM_BYTES = 5.5 * 1024 * 1024; // 10% headroom over use-case cap

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

  // Defense-in-depth form-size cap — declares max early so Next.js
  // does not buffer multi-hundred-MB attacker payloads.
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_FORM_BYTES) {
    return NextResponse.json(
      { error: 'broadcast_image_too_large' },
      { status: 413, headers: baseHeaders(correlationId) },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }

  const file = form.get('file');
  const draftId = form.get('draftId');
  if (!(file instanceof File) || typeof draftId !== 'string') {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: {
        file: file instanceof File ? [] : ['file is required'],
        draftId: typeof draftId === 'string' ? [] : ['draftId is required'],
      },
    });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const result = await runInTenant(ctx.tenant, async () => {
      return uploadInlineImage(makeUploadInlineImageDeps(ctx.tenant.slug), {
        tenantId: ctx.tenant.slug as never,
        actorUserId: ctx.current.user.id,
        actorEmail: ctx.current.user.email,
        draftId,
        requestId: correlationId,
        fileBytes: bytes,
        filename: file.name,
        mimeType: file.type,
      });
    });

    if (!result.ok) {
      const status =
        result.error.kind === 'broadcast_image_too_large'
          ? 413
          : result.error.kind === 'broadcast_image_invalid_mime'
            ? 415
            : result.error.kind === 'broadcast_image_unsafe'
              ? 422
              : 500;
      return NextResponse.json(
        { error: result.error.kind },
        { status, headers: baseHeaders(correlationId) },
      );
    }

    return NextResponse.json(
      {
        blobUrl: result.value.blobUrl,
        allowlistedHostname: result.value.allowlistedHostname,
        contentHash: result.value.contentHash,
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: ctx.tenant.slug,
        draftId,
      },
      'broadcasts.inline-image-upload.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
