/**
 * F114 — `POST /api/portal/change-requests` — submit (US1; contracts/
 * portal-change-requests-api.md § 2; FR-001–FR-008, FR-011, FR-012, FR-036,
 * FR-038, FR-039).
 *
 * Order of checks is the contract: platform flag (404, dark ship — before any
 * session work) → member context (member role only; the proxy already applied
 * the CSRF Origin allow-list) → in-route READ_ONLY_MODE 503 (T116) → tenant
 * gate (409 `approval_not_required` when `immediate` — a race guard, the form
 * resolves the gate first) → body JSON → optional
 * `Idempotency-Key` (a PRESENT malformed key → 400; same key + same body → the
 * stored response; same key + different body → 422 `idempotency-key-reused`;
 * reservation outage → 503) → use case.
 *
 * Error envelope: `{ error: <code>, message?, issues?, fields?, retryAfterSeconds? }`.
 * The two arms that can only be a FAULT (a throwing gate resolver, a failed
 * use case) name themselves in the errorId taxonomy (`M114.portal.submit.<arm>`);
 * the deterministic 4xx refusals are audited / counted by the use case, or
 * not at all. The 429 is the use case's DURABLE 10 / 24 h cap (US5 T087 —
 * counted from the request table, so no rate-limiting service is consulted
 * here; PR-1's interim Upstash peek is gone): mapped to `{ error:
 * 'rate_limited', retryAfterSeconds }` + `Retry-After`, and NOT remembered
 * under an Idempotency-Key (transient — the retry after the window succeeds).
 *
 * `GET` — own history (US4 AS4, FR-029; § history): the caller's own requests
 * + the member's `company` / `mixed` ones, newest first, never a colleague's
 * own-field request; a colleague's `mixed` row carries its company fields
 * only. Query `state?`, opaque keyset `cursor?`, `limit? ≤ 50`; anything
 * else → 400 `invalid_query`. `M114.portal.history.<arm>` on the 500.
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
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { z } from 'zod';
import {
  CHANGE_REQUEST_STATES,
  PORTAL_PAGE_DEFAULT,
  PORTAL_PAGE_MAX,
  listPortalChangeRequests,
  submitChangeRequest,
  type SubmitChangeRequestError,
} from '@/modules/members';
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

  // The durable cap (FR-008): 429 + Retry-After, the same seconds in the
  // body for the form's "try again after <time>"; audited + counted by the
  // use case. Transient by nature — never remembered under the key.
  if (result.error.type === 'rate_limited') {
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds: result.error.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(result.error.retryAfterSeconds) } },
    );
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

// ---------------------------------------------------------------------------
// GET — own history (FR-029)
// ---------------------------------------------------------------------------

const HISTORY_ERROR_ID = 'M114.portal.history';

const historyQuerySchema = z.object({
  state: z.enum(CHANGE_REQUEST_STATES).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(PORTAL_PAGE_MAX).default(PORTAL_PAGE_DEFAULT),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const parsed = historyQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query', message: 'Invalid query.' }, { status: 400 });
  }

  const deps = buildChangeRequestDeps(ctx.tenant);
  const me = asMembersUserId(ctx.current.user.id);
  const result = await listPortalChangeRequests(deps, {
    userId: me,
    memberId: ctx.memberId,
    ...(parsed.data.state ? { state: parsed.data.state } : {}),
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit,
  });

  if (!result.ok) {
    if (result.error.type === 'invalid_cursor') {
      return NextResponse.json({ error: 'invalid_query', message: 'Invalid cursor.' }, { status: 400 });
    }
    logger.error(
      { errorId: `${HISTORY_ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: result.error.message },
      'change-requests.history: use case failed',
    );
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  return NextResponse.json({
    items: result.value.items.map((row) =>
      serialiseChangeRequestForPortal(row.request, {
        contactId: row.request.submittedByContactId,
        displayName: row.submitter.displayName,
        isMe: row.request.submittedByUserId === me,
      }),
    ),
    nextCursor: result.value.nextCursor,
  });
}
