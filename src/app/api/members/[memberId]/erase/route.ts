/**
 * POST /api/members/[memberId]/erase (COMP-1 US3-A).
 *
 * Admin-only GDPR Art.17 / PDPA §33 permanent erasure trigger. Mirrors the
 * archive route shell (RBAC → parse → idempotency → use-case → error-map) but
 * runs `eraseMember` (anonymise-in-place + cascades) and records the in-dialog
 * Art.12 identity attestation into the `member_erasure_requested` audit.
 *
 * The attestation is REQUIRED here (not in the core eraseMemberSchema, which
 * keeps it optional so the US2d reconciler's `{ reason }`-only re-drive stays
 * valid): `identityVerified` MUST be literally true and `verificationMethod`
 * MUST be a known method, else 400 before eraseMember is called.
 *
 * The handler MUST NOT log the request body or the operator note
 * (forbidden-in-logs rule — the note may carry case-reference PII).
 *
 * Error mapping:
 *   400 invalid_body          — eraseRouteSchema fail (missing reason,
 *                               identityVerified !== true, unknown method,
 *                               note > 500, malformed JSON)
 *   400 missing_idempotency_key
 *   401 / 403                 — RBAC (requireAdminContext; 401 no-session first)
 *   404 not_found             — member absent or cross-tenant
 *   409 idempotency_conflict
 *   503 idempotency_reservation_failed — Upstash outage
 *   200 { memberId, erasedAt, cascadesComplete } — happy path (a
 *       cascadesComplete:false is STILL 200; the reconciler finishes the rest)
 *   500 server_error
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import {
  eraseMember,
  eraseReasonSchema,
  verificationMethodSchema,
} from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';

const paramsSchema = z.object({ memberId: z.string().uuid() });

// Route-boundary schema — STRICTER than the core eraseMemberSchema: the Art.12
// attestation is mandatory at the human entry point. Reuses the core's
// `eraseReasonSchema` + `verificationMethodSchema` so the enums never drift.
const eraseRouteSchema = z
  .object({
    reason: eraseReasonSchema,
    identityVerified: z.literal(true),
    verificationMethod: verificationMethodSchema,
    note: z.string().max(500).nullish(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
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

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    if (text.length > 0) rawBody = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }

  const parsedBody = eraseRouteSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'Body failed validation.',
          details: {
            issues: parsedBody.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
      },
      { status: 400 },
    );
  }

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

  const tenant = resolveTenantFromRequest(request);
  const bodyHash = hashRequestBody(rawBody, `POST /api/members/${memberId}/erase`);
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

  const deps = buildEraseMemberDeps(tenant);
  const result = await eraseMember(
    memberId,
    parsedBody.data,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

  if (result.ok) {
    const responseBody = {
      memberId: result.value.memberId,
      erasedAt: result.value.erasedAt.toISOString(),
      cascadesComplete: result.value.cascadesComplete,
    };
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 200,
      body: responseBody,
    });
    return NextResponse.json(responseBody, { status: 200 });
  }

  switch (result.error.type) {
    case 'invalid_body':
      return NextResponse.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Body failed validation.',
            details: { issues: result.error.issues },
          },
        },
        { status: 400 },
      );
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'erase-member: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
