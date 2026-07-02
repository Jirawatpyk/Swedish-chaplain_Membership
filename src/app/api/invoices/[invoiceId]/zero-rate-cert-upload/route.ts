/**
 * 088 US8 UX-B1 (T061e-2) — POST /api/invoices/[invoiceId]/zero-rate-cert-upload
 *
 * Admin-only OPTIONAL upload of an MFA §80/1(5) zero-rate certificate SCAN
 * (FR-024). Mirrors the F7.1a inline-image-upload route: multipart parse +
 * defence-in-depth Content-Length pre-check, then the `uploadZeroRateCert`
 * use-case runs the fail-closed pipeline (MIME → size → ClamAV scan → Blob).
 * Bytes NEVER reach storage before a clean scan verdict.
 *
 * Pinned to the Node runtime — the ClamAV fetch + Vercel Blob client require
 * Node APIs (Edge breaks both). `maxDuration = 60` to fit the ClamAV scan +
 * Blob upload for a file at the 5 MB cap.
 *
 * Error → HTTP map:
 *   - bad MIME       → 415 zero_rate_cert_invalid_mime
 *   - oversize       → 413 zero_rate_cert_too_large (pre-parse Content-Length + use-case)
 *   - infected       → 422 zero_rate_cert_unsafe
 *   - scan failed    → 422 zero_rate_cert_scan_failed (incl. ClamAV unconfigured/timeout)
 *   - non-admin      → 401/403 (requireAdminContext)
 *   - malformed body → 400 invalid_body
 *
 * The endpoint is NOT feature-flag-gated: reachability is controlled by the
 * issue form (the uploader renders only under FEATURE_088_TAX_AT_PAYMENT on a
 * zero-rate sale), and a clean upload without a subsequent zero-rate issue only
 * ever produces an orphan blob (swept by the UX-B2 TTL cron). Admin-only access
 * keeps the blast radius to staff.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { uploadZeroRateCert, makeUploadZeroRateCertDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { assertNever } from '@/lib/assert-never';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** 10% headroom over the 5 MB use-case cap so attacker streams reject early. */
const MAX_FORM_BYTES = 5.5 * 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // Defence-in-depth: reject unbounded payloads before Next.js buffers them.
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_FORM_BYTES) {
    return NextResponse.json(
      { error: { code: 'zero_rate_cert_too_large' } },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_body' } }, { status: 400 });
  }

  // Duck-type the `file` field on `arrayBuffer` rather than `instanceof File`:
  // undici's `File` (what Request.formData() returns) is a different realm from
  // a jsdom/Edge `File` global, so `instanceof` can spuriously fail. A string
  // value is a non-file form field. (Same pattern as the CSV import route.)
  const fileField = form.get('file');
  if (
    fileField === null ||
    typeof fileField === 'string' ||
    typeof (fileField as { arrayBuffer?: unknown }).arrayBuffer !== 'function'
  ) {
    return NextResponse.json({ error: { code: 'invalid_body' } }, { status: 400 });
  }
  const file = fileField as { name: string; type: string; arrayBuffer: () => Promise<ArrayBuffer> };

  const bytes = Buffer.from(await file.arrayBuffer());

  let result: Awaited<ReturnType<typeof uploadZeroRateCert>>;
  try {
    result = await uploadZeroRateCert(makeUploadZeroRateCertDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug,
      invoiceId,
      filename: file.name,
      contentType: file.type,
      bytes,
    });
  } catch (err) {
    logger.error(
      { err, requestId, tenantId: tenantCtx.slug, invoiceId },
      'POST /api/invoices/[id]/zero-rate-cert-upload — uploadZeroRateCert threw',
    );
    return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
  }

  if (!result.ok) {
    let status: number;
    switch (result.error.kind) {
      case 'zero_rate_cert_invalid_mime':
        status = 415;
        break;
      case 'zero_rate_cert_too_large':
        status = 413;
        break;
      case 'zero_rate_cert_unsafe':
      case 'zero_rate_cert_scan_failed':
        status = 422;
        break;
      default:
        assertNever(result.error);
    }
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, invoiceId, errorCode: result.error.kind },
      'POST /api/invoices/[id]/zero-rate-cert-upload rejected',
    );
    return NextResponse.json({ error: { code: result.error.kind } }, { status });
  }

  return NextResponse.json({ blobKey: result.value.blobKey }, { status: 200 });
}
