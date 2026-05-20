/**
 * T109 (F7.1a US7) — POST `/api/member/broadcasts/draft/[id]/snapshot-template`
 *
 * Member role + tenant ctx + draft ownership.
 * Wraps `snapshotTemplateToDraft` Application use-case per contracts/
 * broadcast-template.md § 1.4.
 *
 * Flag gate (T121): member route returns 503 `feature_disabled` when
 * off (vs admin routes which return notFound — different UX semantics).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  snapshotTemplateToDraft,
  makeSnapshotTemplateToDraftDeps,
  isF71aUs7Enabled,
  f71aUs7DisabledReason,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { baseHeaders, jsonError } from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const BodySchema = z.object({
  templateId: z.string().uuid(),
});

const UuidSchema = z.string().uuid();

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs7DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const resolvedParams = await params;
  const draftIdParse = UuidSchema.safeParse(resolvedParams.id);
  if (!draftIdParse.success) {
    return jsonError(400, 'invalid_draft_id', correlationId);
  }
  const draftId = draftIdParse.data;

  const tenantCtx = resolveTenantFromRequest(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, 'invalid_body', correlationId);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }

  try {
    const result = await runInTenant(tenantCtx, async () =>
      snapshotTemplateToDraft(
        makeSnapshotTemplateToDraftDeps(tenantCtx.slug),
        {
          tenantId: tenantCtx.slug as never,
          actorUserId: ctx.current.user.id,
          memberId: ctx.member.memberId,
          draftId,
          templateId: parsed.data.templateId,
          requestId: correlationId,
        },
      ),
    );

    if (!result.ok) {
      const kind = result.error.kind;
      switch (kind) {
        case 'template_not_found':
          return jsonError(404, 'template_not_found', correlationId);
        case 'draft_not_found':
          return jsonError(404, 'broadcast_not_found', correlationId);
        case 'invalid_input':
          return jsonError(400, 'invalid_input', correlationId, {
            detail: result.error.detail,
          });
        // R1.2 H-sf-3: concurrent mutation race (draft status drifted
        // out of 'draft' between findOwnedByMember + updateDraft tx).
        // 409 + broadcast_immutable_after_submit gives the compose
        // surface a clean "draft is no longer editable" signal instead
        // of misleading "not found".
        case 'draft_status_drift':
          return jsonError(409, 'broadcast_immutable_after_submit', correlationId, {
            currentStatus: result.error.currentStatus,
          });
        default: {
          const _exhaustive: never = kind;
          void _exhaustive;
          return jsonError(500, 'internal_error', correlationId);
        }
      }
    }

    return NextResponse.json(
      {
        draftId: result.value.draftId,
        subject: result.value.subject,
        bodyHtml: result.value.bodyHtml,
        templateNameSnapshot: result.value.templateNameSnapshot,
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        draftId,
      },
      'member.broadcasts.snapshot-template.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}
