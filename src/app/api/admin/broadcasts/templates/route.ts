/**
 * T107 (F7.1a US7) — POST + GET `/api/admin/broadcasts/templates`
 *
 * Admin role + tenant ctx.
 *   - POST: create a new template per contracts/broadcast-template.md § 1.1
 *   - GET: list all tenant templates (all locales — admin library view;
 *     member picker uses the separate /api/broadcasts/templates GET with
 *     cascading locale filter per contracts § 1.5)
 *
 * Flag gate (T121): when `isF71aUs7Enabled()` is false the route returns
 * notFound() (404) — opaque per the admin UX convention (no flag-toggle
 * surface leak).
 *
 * Wraps `createBroadcastTemplate` + `listBroadcastTemplates` Application
 * use-cases. Tenant resolved via `resolveTenantFromRequest`; auth + RBAC
 * via `requireAdminContext`. Storage runs inside `runInTenant()` so
 * RLS+FORCE (migration 0166) is the storage-layer guard.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import {
  createBroadcastTemplate,
  listBroadcastTemplates,
  makeCreateBroadcastTemplateDeps,
  makeListBroadcastTemplatesDeps,
  isF71aUs7Enabled,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { baseHeaders } from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const LocaleSchema = z.enum(['en', 'th', 'sv']);

const CreateBodySchema = z.object({
  name: z.string().min(1).max(100),
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(200 * 1024),
  locale: LocaleSchema,
});

function jsonError(
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    notFound(); // 404 — opaque admin surface
  }

  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, 'invalid_body', correlationId);
  }
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    const result = await runInTenant(tenantCtx, async () =>
      createBroadcastTemplate(
        makeCreateBroadcastTemplateDeps(tenantCtx.slug),
        {
          tenantId: tenantCtx.slug as never,
          actorUserId: ctx.current.user.id,
          name: parsed.data.name,
          subject: parsed.data.subject,
          bodyHtml: parsed.data.bodyHtml,
          locale: parsed.data.locale,
          requestId: correlationId,
        },
      ),
    );

    if (!result.ok) {
      const kind = result.error.kind;
      switch (kind) {
        case 'invalid_input':
          return jsonError(400, 'invalid_input', correlationId, {
            detail: result.error.detail,
          });
        case 'template_body_unsafe':
          return jsonError(422, 'template_body_unsafe', correlationId, {
            unsafeImageSources: result.error.unsafeImageSources,
          });
        case 'duplicate_name':
          return jsonError(409, 'template_name_duplicate', correlationId, {
            locale: result.error.locale,
          });
        case 'storage_error':
          return jsonError(500, 'storage_error', correlationId);
        default: {
          const _exhaustive: never = kind;
          void _exhaustive;
          return jsonError(500, 'internal_error', correlationId);
        }
      }
    }

    return NextResponse.json(
      { templateId: result.value.templateId },
      { status: 201, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.broadcasts.templates.create.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    notFound();
  }

  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const rows = await runInTenant(tenantCtx, async () =>
      listBroadcastTemplates(
        makeListBroadcastTemplatesDeps(tenantCtx.slug),
        {
          tenantId: tenantCtx.slug as never,
          // Admin view: all locales, no cascade
          includeAllLocales: true,
        },
      ),
    );

    return NextResponse.json(
      {
        templates: rows.map((t) => ({
          id: t.id,
          name: t.name,
          subject: t.subject,
          locale: t.locale,
          startedFromCount: t.startedFromCount,
          isSeeded: t.isSeeded,
          updatedAt: t.updatedAt.toISOString(),
        })),
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.broadcasts.templates.list.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}
