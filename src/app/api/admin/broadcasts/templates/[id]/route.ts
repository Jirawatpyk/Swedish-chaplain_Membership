/**
 * T108 (F7.1a US7) — PATCH + DELETE `/api/admin/broadcasts/templates/[id]`
 *
 * Admin role + tenant ctx.
 *   - PATCH: partial update per contracts/broadcast-template.md § 1.2
 *   - DELETE: soft-delete per contracts § 1.3 (audit captures
 *     started_from_count snapshot — FR-023)
 *
 * Flag gate (T121): admin routes return notFound() when off.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import {
  updateBroadcastTemplate,
  deleteBroadcastTemplate,
  makeUpdateBroadcastTemplateDeps,
  makeDeleteBroadcastTemplateDeps,
  isF71aUs7Enabled,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { baseHeaders } from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UpdateBodySchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    subject: z.string().min(1).max(200).optional(),
    bodyHtml: z
      .string()
      .min(1)
      .max(200 * 1024)
      .optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.subject !== undefined ||
      v.bodyHtml !== undefined,
    { message: 'at least one field required' },
  );

const UuidSchema = z.string().uuid();

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

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function PATCH(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    notFound();
  }

  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const resolvedParams = await params;
  const idParse = UuidSchema.safeParse(resolvedParams.id);
  if (!idParse.success) {
    return jsonError(400, 'invalid_template_id', correlationId);
  }
  const templateId = idParse.data;

  const tenantCtx = resolveTenantFromRequest(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, 'invalid_body', correlationId);
  }
  const parsed = UpdateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    // `exactOptionalPropertyTypes: true` rejects explicit-undefined
    // properties; conditionally spread instead.
    const result = await runInTenant(tenantCtx, async () =>
      updateBroadcastTemplate(
        makeUpdateBroadcastTemplateDeps(tenantCtx.slug),
        {
          tenantId: tenantCtx.slug as never,
          actorUserId: ctx.current.user.id,
          templateId,
          requestId: correlationId,
          ...(parsed.data.name !== undefined
            ? { name: parsed.data.name }
            : {}),
          ...(parsed.data.subject !== undefined
            ? { subject: parsed.data.subject }
            : {}),
          ...(parsed.data.bodyHtml !== undefined
            ? { bodyHtml: parsed.data.bodyHtml }
            : {}),
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
        case 'not_found':
          return jsonError(404, 'template_not_found', correlationId);
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
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        templateId,
      },
      'admin.broadcasts.templates.update.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    notFound();
  }

  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const resolvedParams = await params;
  const idParse = UuidSchema.safeParse(resolvedParams.id);
  if (!idParse.success) {
    return jsonError(400, 'invalid_template_id', correlationId);
  }
  const templateId = idParse.data;

  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const result = await runInTenant(tenantCtx, async () =>
      deleteBroadcastTemplate(makeDeleteBroadcastTemplateDeps(tenantCtx.slug), {
        tenantId: tenantCtx.slug as never,
        actorUserId: ctx.current.user.id,
        templateId,
        requestId: correlationId,
      }),
    );

    if (!result.ok) {
      const kind = result.error.kind;
      switch (kind) {
        case 'not_found':
          return jsonError(404, 'template_not_found', correlationId);
        case 'storage_error':
          return jsonError(500, 'storage_error', correlationId);
        default: {
          const _exhaustive: never = kind;
          void _exhaustive;
          return jsonError(500, 'internal_error', correlationId);
        }
      }
    }

    return new NextResponse(null, {
      status: 204,
      headers: baseHeaders(correlationId),
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        templateId,
      },
      'admin.broadcasts.templates.delete.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}
