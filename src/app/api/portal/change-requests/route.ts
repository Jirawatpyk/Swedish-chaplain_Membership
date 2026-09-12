/**
 * F114 — `POST /api/portal/change-requests` — submit (US1; contracts/
 * portal-change-requests-api.md § 2; FR-001–FR-008, FR-011, FR-012, FR-036,
 * FR-038, FR-039).
 *
 * Order of checks is the contract: platform flag (404, dark ship — before any
 * session work) → member context (member role only; the proxy already applied
 * the CSRF Origin allow-list) → in-route READ_ONLY_MODE 503 (T116) → the
 * interim rate-limit PEEK (429, review round 1 security I-1; consumed only on
 * `submitted`) → tenant gate (409 `approval_not_required` when `immediate` — a
 * race guard, the form resolves the gate first) → body JSON → optional
 * `Idempotency-Key` (a PRESENT malformed key → 400; same key + same body → the
 * stored response; same key + different body → 422 `idempotency-key-reused`;
 * reservation outage → 503) → use case.
 *
 * Error envelope: `{ error: <code>, message?, issues?, fields?, retryAfterSeconds? }`.
 * The two arms that can only be a FAULT (a throwing gate resolver, a failed
 * use case) name themselves in the errorId taxonomy (`M114.portal.submit.<arm>`);
 * the deterministic 4xx refusals are logged by the use case, by this route
 * for the interim 429 (metric + warn), or not at all.
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
import { rateLimiter } from '@/lib/auth-deps';
import { membersMetrics } from '@/lib/metrics';
import { requireMemberContext } from '@/lib/member-context';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { SUBMISSION_WINDOW_HOURS, SUBMISSIONS_PER_WINDOW_CAP, submitChangeRequest, type SubmitChangeRequestError } from '@/modules/members';
import { serialiseChangeRequestForPortal } from '@/lib/change-request-portal-view';

type SubmitRefusalError = SubmitChangeRequestError;

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

  // FR-036 — READ_ONLY_MODE: 503 after auth, before the idempotency
  // reservation and the use case (the proxy short-circuits too; this is the
  // in-route guard every mutating route carries — T116).
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  // Interim per-person cap until the durable 10 / 24 h cap + 1 h staff-email
  // coalescing land (US5 T087): every submit fans one outbox row out per
  // reviewer, so an unbounded caller is a mailbox / reputation problem
  // (review: security I-1). The window and count mirror T087's numbers, but
  // this bucket counts ATTEMPTS while the durable rule counts CREATED
  // requests (FR-008) — so the bucket is peeked here and consumed only on
  // `outcome === 'submitted'` (round 2, UX + security: a validation error,
  // `nothing_to_submit`, `already_pending` or an idempotent replay must not
  // spend one of the member's ten). Peek-then-consume leaves the classic
  // race open (N concurrent submits can all pass the peek), but every
  // SEQUENTIAL replace still consumes one unit, so the fan-out this cap
  // exists for stays bounded at ten per day per person; the precedent is
  // change-password's peek-then-consume (`change-password.ts`, review B2).
  const rateLimitKey = `f114:submit:${ctx.tenant.slug}:${ctx.current.user.id}`;
  const rl = await rateLimiter.peek(rateLimitKey, SUBMISSIONS_PER_WINDOW_CAP, SUBMISSION_WINDOW_HOURS * 3600);
  if (!rl.success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
    logger.warn({ requestId: ctx.requestId, tenantId: ctx.tenant.slug, memberId: ctx.memberId, reset: rl.reset }, 'change-requests.submit rate-limited');
    // observable (round 6, code #4); the audit event `member_change_request_rate_limited` is T087's
    membersMetrics.changeRequests.refused(ctx.tenant.slug, 'rate_limited');
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
    );
  }

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
  // The header is optional here, but a PRESENT malformed key is a client
  // bug that must not silently run un-deduplicated (review: security M-3).
  if (!keyCheck.ok && keyCheck.reason !== 'missing') {
    return NextResponse.json({ error: 'invalid_idempotency_key', message: 'Idempotency-Key is malformed.' }, { status: 400 });
  }
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
    if (v.outcome === 'submitted') {
      // consume ONE unit for the request that was actually created; the
      // result is bookkeeping (the request exists either way)
      await rateLimiter.check(rateLimitKey, SUBMISSIONS_PER_WINDOW_CAP, SUBMISSION_WINDOW_HOURS * 3600);
    }
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
          ? { status: 200, body: { outcome: 'already_pending' as const, unchanged: v.unchanged, request: serialiseChangeRequestForPortal(v.request, me) } }
          : { status: 200, body: { outcome: 'nothing_to_submit' as const } };
    // The remembered body carries ids + outcome ONLY: the Redis record lives
    // 24 h outside the FR-030 scrub, so proposed values must not sit in it
    // (round 6, code #3). A replay answers the reduced body — the client only
    // reads `outcome` (and navigates) on a retry.
    if (idem) await rememberIdempotentResponse(ctx.tenant, idem.key, idem.bodyHash, { status, body: rememberableBody(body) });
    return NextResponse.json(body, { status });
  }

  // A deterministic refusal is remembered under the key too — otherwise a
  // retry with the same key + body reads the reserved-but-empty record as a
  // CONFLICT and answers 422 `idempotency-key-reused` forever (review:
  // security M-2). Transient 5xx / 429 are NOT remembered so the retry can
  // succeed.
  const refusal = mapRefusal(result.error);
  if (refusal) {
    if (idem) await rememberIdempotentResponse(ctx.tenant, idem.key, idem.bodyHash, refusal);
    return NextResponse.json(refusal.body, { status: refusal.status });
  }
  const error = result.error;
  logger.error(
    { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: error.type },
    'change-requests.submit: use case failed',
  );
  return NextResponse.json({ error: 'server_error' }, { status: 500 });
}

type Refusal = { readonly status: number; readonly body: Record<string, unknown> };

/**
 * Built BY CONSTRUCTION, never by subtraction (round 7, types S5): the
 * remembered body names every key it carries — ids, outcome, the two
 * booleans — so a future field with a value cannot ride along, and a
 * replay is visibly the reduced shape (`replay: true`).
 */
type RememberableBody = {
  readonly replay: true;
  readonly outcome: 'submitted' | 'already_pending' | 'nothing_to_submit';
  readonly request?: { readonly id: string; readonly state: string; readonly scope: string; readonly submittedAt: string };
  readonly replaced?: string | null;
  readonly staffNotified?: boolean;
  readonly unchanged?: boolean;
};
function rememberableBody(body: {
  readonly outcome: 'submitted' | 'already_pending' | 'nothing_to_submit';
  readonly request?: { id: string; state: string; scope: string; submittedAt: string };
  readonly replaced?: string | null;
  readonly staffNotified?: boolean;
  readonly unchanged?: boolean;
}): RememberableBody {
  const request = body.request ? { id: body.request.id, state: body.request.state, scope: body.request.scope, submittedAt: body.request.submittedAt } : undefined;
  return {
    replay: true,
    outcome: body.outcome,
    ...(request ? { request } : {}),
    ...(body.replaced !== undefined ? { replaced: body.replaced } : {}),
    ...(body.staffNotified !== undefined ? { staffNotified: body.staffNotified } : {}),
    ...(body.unchanged !== undefined ? { unchanged: body.unchanged } : {}),
  };
}

/** The 4xx arms the client can act on — stable for a given body, hence rememberable. */
function mapRefusal(error: SubmitRefusalError): Refusal | null {
  switch (error.type) {
    case 'forbidden':
      return {
        status: 403,
        body: { error: error.reason === 'company_fields_require_primary' ? 'company_fields_require_primary' : 'forbidden', fields: error.fields },
      };
    case 'validation_error':
      return { status: 422, body: { error: 'validation_error', issues: error.issues } };
    case 'member_archived':
      return { status: 403, body: { error: 'member_archived', message: 'An archived membership cannot be edited.' } };
    case 'not_found':
      return { status: 404, body: { error: 'not_found' } };
    default:
      return null;
  }
}
