/**
 * F114 — `POST /api/portal/change-requests` — submit (US1; contracts/
 * portal-change-requests-api.md § 2; FR-001–FR-008, FR-011, FR-012, FR-036,
 * FR-038, FR-039).
 *
 * Order of checks is the contract: platform flag (404, dark ship — before any
 * session work) → member context (member role only; the proxy already applied
 * the CSRF Origin allow-list and read-only 503) → tenant gate (409
 * `approval_not_required` when `immediate` — a race guard, the form resolves
 * the gate first) → body JSON → optional `Idempotency-Key` (same key + same
 * body → the stored response; same key + different body → 422
 * `idempotency-key-reused`; reservation outage → 503) → use case.
 *
 * Error envelope: `{ error: <code>, message?, issues?, fields?, retryAfterSeconds? }`.
 * Every failing arm names itself in the errorId taxonomy (`M114.portal.submit.<arm>`).
 * `GET` (own history, FR-029) lands in US4 (T073) in this same file.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import {
  classifyIdempotencyRequest,
  hashRequestBody,
  parseIdempotencyKey,
  rememberIdempotentResponse,
  reserveIdempotencyRecord,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { requireMemberContext } from '@/lib/member-context';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { submitChangeRequest } from '@/modules/members';
import { serialiseChangeRequestForPortal } from './_serialise';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.portal.submit';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // FR-039 — dark ship: 404 before any session work.
  if (!env.features.memberChangeApproval) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const deps = buildChangeRequestDeps(ctx.tenant);

  let gate: 'immediate' | 'approval';
  try {
    gate = await deps.memberChangeGate.resolve(ctx.tenant);
  } catch (e) {
    logger.error(
      { errorId: `${ERROR_ID}.gate_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: errKind(e) },
      'change-requests.submit: gate resolver failed',
    );
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  if (gate === 'immediate') {
    return NextResponse.json(
      { error: 'approval_not_required', message: 'This tenant does not require approval; use the profile endpoint.' },
      { status: 409 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'Body must be valid JSON.' }, { status: 400 });
  }

  // Optional Idempotency-Key — same semantics as the profile endpoint's
  // classify / reserve / remember flow (FR-038).
  const keyCheck = parseIdempotencyKey(request.headers);
  const idem = keyCheck.ok ? { key: keyCheck.key, bodyHash: hashRequestBody(rawBody, 'POST /portal/change-requests') } : null;
  if (idem) {
    const classification = await classifyIdempotencyRequest(ctx.tenant, idem.key, idem.bodyHash);
    if (classification.kind === 'replay') {
      return NextResponse.json(classification.previousResponse.body, {
        status: classification.previousResponse.status,
      });
    }
    if (classification.kind === 'conflict') {
      return NextResponse.json(
        { error: 'idempotency-key-reused', message: 'Idempotency-Key was reused with a different body.' },
        { status: 422 },
      );
    }
    const reserved = await reserveIdempotencyRecord(ctx.tenant, idem.key, idem.bodyHash);
    if (!reserved.ok) {
      return NextResponse.json(
        { error: 'idempotency_reservation_failed', message: 'Retry shortly.' },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
  }

  const result = await submitChangeRequest(deps, {
    memberId: ctx.memberId,
    contactId: ctx.ownContactId,
    rawBody,
    actorUserId: asMembersUserId(ctx.current.user.id),
    actorRole: ctx.current.user.role,
    requestId: ctx.requestId,
  });

  if (result.ok) {
    const me = {
      contactId: ctx.ownContactId,
      displayName: `${ctx.ownContact.firstName} ${ctx.ownContact.lastName}`.trim(),
      isMe: true,
    };
    const v = result.value;
    const { status, body } =
      v.outcome === 'submitted'
        ? {
            status: 201,
            body: {
              outcome: 'submitted' as const,
              request: serialiseChangeRequestForPortal(v.request, me),
              replaced: v.replaced,
              staffNotified: v.staffNotified,
            },
          }
        : v.outcome === 'already_pending'
          ? { status: 200, body: { outcome: 'already_pending' as const, request: serialiseChangeRequestForPortal(v.request, me) } }
          : { status: 200, body: { outcome: 'nothing_to_submit' as const } };
    if (idem) await rememberIdempotentResponse(ctx.tenant, idem.key, idem.bodyHash, { status, body });
    return NextResponse.json(body, { status });
  }

  const error = result.error;
  switch (error.type) {
    case 'forbidden':
      return NextResponse.json(
        {
          error: error.reason === 'company_fields_require_primary' ? 'company_fields_require_primary' : 'forbidden',
          fields: error.fields,
        },
        { status: 403 },
      );
    case 'validation_error':
      return NextResponse.json({ error: 'validation_error', issues: error.issues }, { status: 422 });
    case 'member_archived':
      return NextResponse.json(
        { error: 'member_archived', message: 'An archived membership cannot be edited.' },
        { status: 403 },
      );
    case 'not_found':
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    case 'rate_limited':
      return NextResponse.json(
        { error: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    case 'server_error':
    default:
      logger.error(
        { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: error.type },
        'change-requests.submit: use case failed',
      );
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
