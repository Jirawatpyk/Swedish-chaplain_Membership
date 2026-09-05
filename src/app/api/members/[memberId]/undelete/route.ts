/**
 * POST /api/members/[memberId]/undelete (T140, US7).
 *
 * Admin-only restore within the 90-day archive window. Idempotency-Key
 * required per endpoints spec.
 *
 * 108 PR-B (FR-014): an optional JSON body `{ designate_primary_contact_id }`
 * names the live contact to make primary in the same transaction. When the
 * member has no live primary and none is designated, the use case refuses
 * with 409 `no_primary_contact` carrying `details.designatable` (the member's
 * live contacts) so the restore dialog can offer a choice. The body is part
 * of the idempotency hash — "restore designating A" and "restore designating
 * B" must not replay each other under one key.
 *
 * Error mapping:
 *   400 missing_idempotency_key
 *   400 invalid_body             — designate_primary_contact_id not a uuid
 *   403 forbidden                — RBAC
 *   403 archive_window_expired   — > 90 days since archived_at
 *   404 not_found                — member absent or cross-tenant
 *   409 idempotency_conflict
 *   409 no_primary_contact       — designate one (details.designatable)
 *   409 state_error              — not archived (nothing to undelete)
 *   500 server_error
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { undeleteMember } from '@/modules/members';
import type { ContactId, MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { serialiseMember } from '../../_serialise';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

const bodySchema = z
  .object({
    designate_primary_contact_id: z.string().uuid().optional(),
  })
  .strict();

/**
 * The body is optional (the pre-108 client sends none). An empty or absent
 * body parses as `{}`; malformed JSON or an unknown/invalid field is a 400.
 */
async function readBody(
  request: NextRequest,
): Promise<z.infer<typeof bodySchema> | null> {
  const raw = await request.text();
  let json: unknown = {};
  if (raw.trim() !== '') {
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = bodySchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireApiPermission(request, 'members.write');
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsedParams = paramsSchema.safeParse(resolved);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }
  const memberId = parsedParams.data.memberId as MemberId;

  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'missing_idempotency_key',
          message:
            keyCheck.reason === 'missing'
              ? 'Idempotency-Key header is required.'
              : 'Idempotency-Key header is malformed.',
        },
      },
      { status: 400 },
    );
  }

  const body = await readBody(request);
  if (body === null) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'designate_primary_contact_id must be a contact id.',
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const bodyHash = hashRequestBody(
    body,
    `POST /api/members/${memberId}/undelete`,
  );
  const classification = await classifyIdempotencyRequest(
    tenant,
    keyCheck.key,
    bodyHash,
  );
  if (classification.kind === 'replay') {
    return NextResponse.json(classification.previousResponse.body, {
      status: classification.previousResponse.status,
    });
  }
  if (classification.kind === 'conflict') {
    return NextResponse.json(
      {
        error: {
          code: 'idempotency_conflict',
          message: 'Idempotency-Key was reused with a different body.',
        },
      },
      { status: 409 },
    );
  }
  // Post-ship R6 Batch 2b — surface Upstash outage as 503 instead of
  // silently continuing. Mirrors `_idempotency-guard.ts:106-125` from
  // Batch 1d. Undelete is a state transition that emits audit; a
  // silent drop+retry could double-emit the `member_undeleted` event.
  const reserved = await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);
  if (!reserved.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'idempotency_reservation_failed',
          message:
            'Idempotency reservation temporarily unavailable. Retry shortly.',
        },
      },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }

  const deps = buildMembersDeps(tenant);
  const meta = { actorUserId: ctx.current.user.id, requestId: ctx.requestId };
  const designate = body.designate_primary_contact_id;
  const result =
    designate === undefined
      ? await undeleteMember(memberId, meta, deps)
      : await undeleteMember(memberId, meta, deps, {
          designatePrimaryContactId: designate as ContactId,
        });

  if (result.ok) {
    const responseBody = serialiseMember(result.value);
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 200,
      body: responseBody,
    });
    return NextResponse.json(responseBody, { status: 200 });
  }

  switch (result.error.type) {
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    case 'state_error':
      if (result.error.code === 'no_primary_contact') {
        // Not remembered under the idempotency key: the admin's next call
        // with the same key WILL carry a designation and must run.
        return NextResponse.json(
          {
            error: {
              code: 'no_primary_contact',
              message:
                'This member has no primary contact. Choose one to restore.',
              details: {
                designatable: (result.error.designatable ?? []).map((c) => ({
                  contact_id: c.contactId,
                  first_name: c.firstName,
                  last_name: c.lastName,
                })),
              },
            },
          },
          { status: 409 },
        );
      }
      if (result.error.code === 'state.undelete_window_expired') {
        return NextResponse.json(
          {
            error: {
              code: 'archive_window_expired',
              message:
                'Archive window (90 days) has expired. Contact platform admin to restore.',
              details: {
                daysSinceArchive: result.error.daysSinceArchive,
              },
            },
          },
          { status: 403 },
        );
      }
      return NextResponse.json(
        {
          error: {
            code: 'state_error',
            message: 'Member is not archived.',
            details: { code: result.error.code },
          },
        },
        { status: 409 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'undelete-member: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
