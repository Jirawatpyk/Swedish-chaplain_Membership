/**
 * POST /api/admin/contacts/[contactId]/marketing — 108 PR-D (US4 / FR-030,
 * FR-030b, FR-053a; contracts/contact-marketing-api.md § 1).
 *
 * The STAFF marketing toggle: switch one contact's marketing state on or off.
 * Gate `contacts.marketing` (admin, super_admin, marketing — never manager),
 * which confers nothing else: the name / email / phone edits stay behind
 * `contacts.write`.
 *
 * Order of checks is the contract: gate → params → body → `Idempotency-Key`
 * (400) → rate limit consumed BEFORE anything is written (60/min per
 * tenant + user, FR-030b) → idempotency replay / reserve → use case.
 * Request `{ state: 'on' | 'off' }` (strict). Responses:
 *   200 `{ outcome: 'changed', contact }` · 200 `{ outcome: 'unchanged' }`
 *   400 invalid_body | missing_idempotency_key · 404 not_found
 *   409 suppressed (FR-025) · 409 idempotency_conflict · 429 · 503
 * Error bodies are RFC 7807 problem details (`type` ends in the code).
 *
 * A miss is audited as `member_cross_tenant_probe` with ids only — the repo
 * cannot distinguish "does not exist" from "another tenant's" (RLS), and any
 * miss from an authenticated staff user on a PII resource is high-signal
 * (same rule as getMember). The audit failure never masks the 404.
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
import { problemResponse } from '@/lib/http/problem-response';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/modules/auth';
import { asContactId, setContactMarketingOptOut } from '@/modules/members';
import { buildContactMarketingDeps } from '@/lib/contact-marketing-deps';
import { serialiseContact } from '../../../../members/_serialise';

const paramsSchema = z.object({ contactId: z.string().uuid() });
const bodySchema = z.object({ state: z.enum(['on', 'off']) }).strict();

/** FR-030b — 60 changes per minute per (tenant, user); shared with the portal self-toggle. */
const RATE_MAX = 60;
const RATE_WINDOW_SECONDS = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
): Promise<NextResponse> {
  const ctx = await requireApiPermission(request, 'contacts.marketing');
  if ('response' in ctx) return ctx.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return problemResponse(404, 'not_found', 'Contact not found.');
  }
  const contactId = asContactId(parsedParams.data.contactId.toLowerCase());

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return problemResponse(400, 'invalid_body', 'Body must be valid JSON.');
  }
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return problemResponse(400, 'invalid_body', 'Body must be exactly { state: "on" | "off" }.');
  }

  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return problemResponse(
      400,
      'missing_idempotency_key',
      keyCheck.reason === 'missing'
        ? 'Idempotency-Key header is required.'
        : 'Idempotency-Key header is malformed.',
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const actorUserId = ctx.current.user.id;

  // FR-030b — consumed before the change is attempted (and before the replay
  // check: a replay is still a request against the same budget).
  const rl = await rateLimiter.check(
    `contacts:marketing:${tenant.slug}:${actorUserId}`,
    RATE_MAX,
    RATE_WINDOW_SECONDS,
  );
  if (!rl.success) return rateLimitedJson(rl);

  const bodyHash = hashRequestBody(parsedBody.data, `POST /contacts/${contactId}/marketing`);
  const classification = await classifyIdempotencyRequest(tenant, keyCheck.key, bodyHash);
  if (classification.kind === 'replay') {
    return NextResponse.json(classification.previousResponse.body, {
      status: classification.previousResponse.status,
    });
  }
  if (classification.kind === 'conflict') {
    return problemResponse(
      409,
      'idempotency_conflict',
      'Idempotency-Key was reused with a different body.',
    );
  }
  const reserved = await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);
  if (!reserved.ok) {
    return problemResponse(
      503,
      'idempotency_reservation_failed',
      'Idempotency reservation temporarily unavailable. Retry shortly.',
      undefined,
      { headers: { 'Retry-After': '5' } },
    );
  }

  const deps = buildContactMarketingDeps(tenant);
  const result = await setContactMarketingOptOut(
    {
      contactId,
      state: parsedBody.data.state,
      actor: { userId: actorUserId, role: ctx.current.user.role, source: 'staff' },
      requestId: ctx.requestId,
    },
    deps,
  );

  if (result.ok) {
    const body =
      result.value.outcome === 'changed'
        ? { outcome: 'changed' as const, contact: serialiseContact(result.value.contact) }
        : { outcome: 'unchanged' as const };
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, { status: 200, body });
    return NextResponse.json(body, { status: 200 });
  }

  switch (result.error.type) {
    case 'not_found': {
      // The adapter returns a Result (it never throws) — read it, or a failed
      // probe write would be silent (security review LOW-2).
      const probe = await deps.audit.record(tenant, {
        type: 'member_cross_tenant_probe',
        actorUserId,
        requestId: ctx.requestId,
        summary: `probe on contact ${contactId}`,
        payload: { attempted_contact_id: contactId, actor_tenant_id: tenant.slug },
      });
      if (!probe.ok) {
        logger.error(
          { requestId: ctx.requestId, err: probe.error.code },
          'contact-marketing: probe audit failed',
        );
      }
      return problemResponse(404, 'not_found', 'Contact not found.');
    }
    case 'removed':
      // Same 404 to the client (non-disclosure), but NO probe audit: an
      // in-tenant soft-deleted contact is a benign race (security LOW-1).
      return problemResponse(404, 'not_found', 'Contact not found.');
    case 'self_opted_out':
      return problemResponse(
        409,
        'self_opted_out',
        'Marketing cannot be switched on.',
        'This person switched marketing off themselves; only they can switch it back on.',
      );
    case 'suppressed':
      return problemResponse(
        409,
        'suppressed',
        'Marketing cannot be switched on.',
        "This person unsubscribed themselves; their choice takes precedence over a staff change.",
      );
    case 'suppression_unavailable':
      return problemResponse(
        503,
        'suppression_unavailable',
        'Unsubscribe status is temporarily unavailable.',
        'Switching marketing on needs the unsubscribe list; retry shortly.',
        { headers: { 'Retry-After': '5' } },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error.message },
        'contact-marketing: unhandled',
      );
      return problemResponse(500, 'server_error', 'Internal server error.');
  }
}
