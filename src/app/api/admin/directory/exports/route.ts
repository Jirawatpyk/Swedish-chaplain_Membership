/**
 * F9 US5 (T082) — POST `/api/admin/directory/exports`.
 *
 * Enqueues an async directory artefact (E-Book PDF or JSON). Staff-only
 * (admin + manager; member → 403). The cron worker builds + stores the artefact;
 * this route only creates the job (FR-037 hybrid). CSRF Origin allow-list +
 * session are enforced by `middleware.ts` for state-changing `/api/**`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { getCurrentSession } from '@/lib/auth-session';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  exportDirectoryJson,
  generateDirectoryEbook,
  makeGenerateDirectoryExportDeps,
} from '@/modules/insights';

export const runtime = 'nodejs';

const BodySchema = z.object({
  kind: z.enum(['directory_ebook', 'directory_json']),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'feature_disabled' }, correlationId }, { status: 503 });
  }
  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: { code: 'unauthorized' }, correlationId }, { status: 401 });
  }
  if (current.user.role === 'member') {
    return NextResponse.json({ error: { code: 'forbidden' }, correlationId }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid_body' }, correlationId }, { status: 400 });
  }

  const tenant = resolveTenantFromRequest(request);

  // Rate-limit per staff actor (F9 #5): each accepted request enqueues a job
  // that renders a full react-pdf E-Book / JSON over the ENTIRE published
  // directory on the cron worker, and generateDirectoryExport keys idempotency
  // on the generation instant so every call creates a FRESH job — without a cap
  // a staff actor (admin OR the read-only manager) could queue unbounded heavy
  // builds (resource-exhaustion). 10/hour is ample for legitimate regeneration;
  // mirrors the GDPR admin export limiter (W0-18).
  const rl = await rateLimiter.check(
    `directory-export:${tenant.slug}:${current.user.id as string}`,
    10,
    3600,
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' }, correlationId },
      {
        status: 429,
        headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() },
      },
    );
  }

  const meta = {
    actorUserId: current.user.id as string,
    actorRole: current.user.role,
    requestId: correlationId,
  };

  try {
    const deps = makeGenerateDirectoryExportDeps(tenant.slug);
    const result =
      parsed.data.kind === 'directory_ebook'
        ? await generateDirectoryEbook(meta, tenant, deps)
        : await exportDirectoryJson(meta, tenant, deps);
    if (!result.ok) {
      const status = result.error === 'forbidden' ? 403 : 400;
      return NextResponse.json({ error: { code: result.error }, correlationId }, { status });
    }
    return NextResponse.json({ ok: true, jobId: result.value.jobId, correlationId }, { status: 200 });
  } catch (e) {
    logger.error(
      { correlationId, tenantId: tenant.slug, errKind: errKind(e) },
      'admin.directory.exports.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
}
