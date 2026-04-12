/**
 * Shared idempotency guard for plan API route handlers.
 *
 * Encapsulates the 40-line preamble (parse key → classify → replay /
 * conflict / reserve) that was previously copy-pasted across 5 state-
 * mutating routes. The caller provides the request, the tenant resolver,
 * a hash seed string, and an async `fn` that receives the key + tenant.
 * On success the caller returns the response and calls
 * `rememberIdempotentResponse` as usual.
 *
 * Returns either:
 *   - `{ kind: 'proceed', key, tenant }` — caller should execute the
 *     use case and then call `rememberIdempotentResponse`
 *   - `{ kind: 'response', response }` — caller should return this
 *     response immediately (replay, conflict, or validation error)
 */

import { NextResponse, type NextRequest } from 'next/server';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  hashRequestBody,
} from '@/lib/idempotency';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import type { TenantContext } from '@/modules/tenants';

type IdempotencyProceed = {
  readonly kind: 'proceed';
  readonly key: string;
  readonly bodyHash: string;
  readonly tenant: TenantContext;
};

type IdempotencyShortCircuit = {
  readonly kind: 'response';
  readonly response: NextResponse;
};

export type IdempotencyResult = IdempotencyProceed | IdempotencyShortCircuit;

/**
 * Run the idempotency guard preamble for a state-mutating route.
 *
 * @param request  — the incoming NextRequest
 * @param hashSeed — unique seed for the body hash (e.g. `'POST /api/plans/2026/premium/activate'`)
 * @param body     — the parsed request body (use `{}` for bodyless POSTs)
 */
export async function runIdempotencyGuard(
  request: NextRequest,
  hashSeed: string,
  body: unknown = {},
): Promise<IdempotencyResult> {
  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return {
      kind: 'response',
      response: NextResponse.json(
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
      ),
    };
  }

  const tenant = resolveTenantFromRequest(request);
  const bodyHash = hashRequestBody(body, hashSeed);
  const classification = await classifyIdempotencyRequest(
    tenant,
    keyCheck.key,
    bodyHash,
  );

  if (classification.kind === 'replay') {
    return {
      kind: 'response',
      response: NextResponse.json(
        classification.previousResponse.body,
        { status: classification.previousResponse.status },
      ),
    };
  }

  if (classification.kind === 'conflict') {
    return {
      kind: 'response',
      response: NextResponse.json(
        {
          error: {
            code: 'idempotency_conflict',
            message: 'Idempotency-Key was reused with a different body.',
          },
        },
        { status: 409 },
      ),
    };
  }

  await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);

  return { kind: 'proceed', key: keyCheck.key, bodyHash, tenant };
}
