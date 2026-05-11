/**
 * F8 Phase 5 Wave C · T132 — POST `/api/portal/preferences/renewals`.
 *
 * Member toggles renewal-reminder opt-out per FR-016. Body is
 * `{ optedOut: boolean }`; `true` → calls `optOutRenewalReminders`,
 * `false` → calls `optInRenewalReminders`. Idempotent.
 *
 * Auth: member role via `requireMemberContext`. Session-member's
 * memberId is the target — no URL [memberId] needed (member can only
 * modify their own preferences).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireMemberContext } from '@/lib/member-context';
import { errorResponse, successResponse } from '@/lib/renewals-route-helpers';
import {
  optInRenewalReminders,
  optOutRenewalReminders,
  makeRenewalsDeps,
} from '@/modules/renewals';

const BodySchema = z.object({
  opted_out: z.boolean(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId,
    });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId,
    });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const deps = makeRenewalsDeps(ctx.tenant.slug);
  const baseInput = {
    tenantId: ctx.tenant.slug,
    memberId: ctx.memberId,
    actorUserId: ctx.current.user.id,
    actorRole: 'member' as const,
    requestId: ctx.requestId,
    correlationId,
  };

  try {
    if (parsed.data.opted_out) {
      const r = await optOutRenewalReminders(deps, baseInput);
      if (!r.ok) {
        return mapToggleError(r.error.kind, correlationId);
      }
      return successResponse(
        { opted_out: true, already_opted_out: r.value.alreadyOptedOut },
        correlationId,
      );
    } else {
      const r = await optInRenewalReminders(deps, baseInput);
      if (!r.ok) {
        return mapToggleError(r.error.kind, correlationId);
      }
      return successResponse(
        { opted_out: false, was_opted_out: r.value.wasOptedOut },
        correlationId,
      );
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId: ctx.tenant.slug,
      },
      'preferences-renewals route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId,
    });
  }
}

function mapToggleError(
  kind: 'invalid_input' | 'member_not_found',
  correlationId: string,
) {
  if (kind === 'member_not_found') {
    return errorResponse({
      status: 404,
      code: 'member_not_found',
      correlationId,
    });
  }
  return errorResponse({
    status: 400,
    code: 'invalid_input',
    correlationId,
  });
}
