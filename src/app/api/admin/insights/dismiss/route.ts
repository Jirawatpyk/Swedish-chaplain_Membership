/**
 * F9 (US1 / FR-004) — POST `/api/admin/insights/dismiss`.
 *
 * Records a staff dismissal of a smart insight for the current cycle. Insights
 * are staff-facing (FR-007a): admin + manager may dismiss, members may not.
 * The `dismissInsight` use-case is idempotent (repo dedupes on the unique key)
 * and emits `smart_insight_dismissed` atomically with the write.
 *
 * Auth: staff session required; member role → 403. CSRF Origin allow-list +
 * session lookup are enforced by `middleware.ts` for state-changing `/api/**`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { dismissInsight, makeDismissInsightDeps } from '@/modules/insights';

export const runtime = 'nodejs';

const BodySchema = z.object({
  insightKey: z.string().min(1).max(64),
  scopeRef: z.string().max(255).optional(),
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
    return NextResponse.json(
      { error: { code: 'invalid_body' }, correlationId },
      { status: 400 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const result = await dismissInsight(
      {
        insightKey: parsed.data.insightKey,
        ...(parsed.data.scopeRef !== undefined ? { scopeRef: parsed.data.scopeRef } : {}),
      },
      {
        actorUserId: current.user.id as string,
        actorRole: current.user.role,
        requestId: correlationId,
      },
      tenantCtx,
      makeDismissInsightDeps(tenantCtx.slug),
    );
    if (!result.ok) {
      const status = result.error === 'forbidden' ? 403 : 400;
      return NextResponse.json({ error: { code: result.error }, correlationId }, { status });
    }
    return NextResponse.json({ ok: true, correlationId }, { status: 200 });
  } catch (e) {
    logger.error(
      {
        correlationId,
        tenantId: tenantCtx.slug,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      'admin.insights.dismiss.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
}
