/**
 * Idempotency-Key middleware (T061, F2 + shared F3+).
 *
 * Every F2 mutating endpoint (POST / PATCH / DELETE) requires an
 * `Idempotency-Key: <uuid>` request header. This module stores the
 * key + a SHA-256 hash of the request body in Upstash Redis for 24h
 * (Redis TTL), and classifies each incoming request as:
 *
 *   - `'first'`     — no prior record; caller MUST process the request
 *                     then call `rememberResponse()` with the result
 *   - `'replay'`    — prior record exists with the same body hash;
 *                     caller MUST return `previousResponse` verbatim
 *                     (same status + body)
 *   - `'conflict'`  — prior record exists with a DIFFERENT body hash;
 *                     caller MUST return 409 `idempotency_conflict`
 *
 * Why Upstash Redis (not a new Postgres table):
 *   - 24h TTL is a native Redis primitive — zero migration work
 *   - <1 ms read path under normal load (well inside the 400ms p95 SLO)
 *   - The existing F1 rate-limit adapter already has the client wired
 *   - Lost-on-outage is acceptable: on Redis outage, `classify()` fails
 *     open and returns `'first'`, which lets the request through with
 *     a degraded-but-working UX rather than blocking
 *
 * Tenant scoping:
 *   - Keys are namespaced per tenant slug so two tenants cannot
 *     collide on the same Idempotency-Key UUID (unlikely but cheap to
 *     prevent): `idem:<tenant>:<key>`
 *
 * Not exported on the plans public barrel — this is a request-layer
 * adapter, not a Domain/Application surface.
 */

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { env } from './env';
import { logger } from './logger';
import type { TenantContext } from '@/modules/tenants';

// --- Types -------------------------------------------------------------------

export type IdempotencyClassification =
  | { readonly kind: 'first' }
  | {
      readonly kind: 'replay';
      readonly previousResponse: StoredResponse;
    }
  | {
      readonly kind: 'conflict';
      readonly storedBodyHash: string;
      readonly incomingBodyHash: string;
    };

export type StoredResponse = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
};

type StoredRecord = {
  readonly bodyHash: string;
  readonly response: StoredResponse | null;
  readonly createdAt: string; // ISO 8601
};

// --- Validation --------------------------------------------------------------

/**
 * Validate the `Idempotency-Key` header. Returns the normalised key on
 * success or a rejection reason on failure.
 *
 * Accepted format: UUID v4 (36 chars, dashes) OR any printable ASCII
 * string 8..128 chars. This is permissive on purpose — clients may
 * generate keys from anything (ULID, NanoID, uuidv7, application-
 * specific tokens) as long as the format is stable per-request.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;

export type KeyValidation =
  | { readonly ok: true; readonly key: string }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'malformed';
    };

export function parseIdempotencyKey(headers: Headers | Record<string, string>): KeyValidation {
  const raw =
    headers instanceof Headers
      ? headers.get('idempotency-key') ?? headers.get('Idempotency-Key')
      : (headers['idempotency-key'] ?? headers['Idempotency-Key'] ?? null);

  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'missing' };
  }
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, key };
}

// --- Body hashing ------------------------------------------------------------

/**
 * Hash the request body with SHA-256. JSON stringification is stable
 * enough for this purpose — two requests with identical keys but
 * non-identical bodies collide if and only if the stringification
 * differs, which is exactly the desired behaviour for conflict
 * detection.
 *
 * Optional `extraSalt` lets callers namespace by HTTP method + route
 * so a PATCH and DELETE with the same key on different routes aren't
 * classified as replays of each other.
 */
export function hashRequestBody(body: unknown, extraSalt = ''): string {
  const json = body === undefined ? '' : JSON.stringify(body);
  return createHash('sha256').update(extraSalt + '\n' + json).digest('hex');
}

// --- Storage adapter (Upstash Redis with fail-open fallback) ----------------

const redis = new Redis({
  url: env.upstash.url,
  token: env.upstash.token,
});

/** Default TTL for idempotency records — 24 hours in seconds. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function redisKey(tenant: TenantContext, key: string): string {
  return `idem:${tenant.slug}:${key}`;
}

/**
 * Classify an incoming idempotent request against prior Redis state.
 *
 * Returns `'first'` when no prior record exists (caller proceeds),
 * `'replay'` when the stored body hash matches (caller returns the
 * stored response), or `'conflict'` when the stored hash differs.
 *
 * On Redis outage, this function LOGS + returns `'first'` (fail open).
 * A denial would block every mutation during the incident, which is
 * worse than accepting some duplicate work for 24h.
 */
export async function classifyIdempotencyRequest(
  tenant: TenantContext,
  key: string,
  bodyHash: string,
): Promise<IdempotencyClassification> {
  let stored: StoredRecord | null = null;
  try {
    stored = await redis.get<StoredRecord>(redisKey(tenant, key));
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), tenant: tenant.slug, key },
      'idempotency: Redis read failed — failing open to first',
    );
    return { kind: 'first' };
  }

  if (!stored) return { kind: 'first' };

  if (stored.bodyHash !== bodyHash) {
    return {
      kind: 'conflict',
      storedBodyHash: stored.bodyHash,
      incomingBodyHash: bodyHash,
    };
  }

  if (stored.response === null) {
    // Record exists but response not yet written — request is still
    // in-flight on another worker. Treat as conflict so the client
    // retries; the alternative (block + wait) would hold an edge
    // function open and blow the execution budget.
    return {
      kind: 'conflict',
      storedBodyHash: stored.bodyHash,
      incomingBodyHash: bodyHash,
    };
  }

  return { kind: 'replay', previousResponse: stored.response };
}

/**
 * Reserve the key + body hash immediately (before processing the
 * request). Subsequent calls for the same key during processing will
 * see a `null` response and return `conflict` — preventing duplicate
 * concurrent writes. Called at the START of the handler.
 */
export async function reserveIdempotencyRecord(
  tenant: TenantContext,
  key: string,
  bodyHash: string,
): Promise<void> {
  const record: StoredRecord = {
    bodyHash,
    response: null,
    createdAt: new Date().toISOString(),
  };
  try {
    await redis.set(redisKey(tenant, key), record, { ex: IDEMPOTENCY_TTL_SECONDS });
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), tenant: tenant.slug, key },
      'idempotency: Redis reserve failed — continuing without reservation',
    );
  }
}

/**
 * Store the final response after the handler finishes. Subsequent
 * identical requests within the 24h window will be classified as
 * replays and returned from this stored record.
 *
 * The caller is responsible for stripping any per-request-unique
 * headers (request ID, timestamps) before storing if full verbatim
 * replay is required.
 */
export async function rememberIdempotentResponse(
  tenant: TenantContext,
  key: string,
  bodyHash: string,
  response: StoredResponse,
): Promise<void> {
  const record: StoredRecord = {
    bodyHash,
    response,
    createdAt: new Date().toISOString(),
  };
  try {
    await redis.set(redisKey(tenant, key), record, { ex: IDEMPOTENCY_TTL_SECONDS });
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), tenant: tenant.slug, key },
      'idempotency: Redis write failed — response not cached, replays will be re-processed',
    );
  }
}

// --- Convenience wrapper for route handlers ----------------------------------

export type WithIdempotencyResult<T> =
  | { readonly kind: 'first'; readonly proceed: () => Promise<T> }
  | { readonly kind: 'replay'; readonly previousResponse: StoredResponse }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly reason: 'missing' | 'malformed' };

/**
 * High-level helper that route handlers can use directly:
 *
 *   const outcome = await withIdempotency(req, tenant, body, 'POST /api/plans');
 *   if (outcome.kind === 'invalid') return NextResponse.json({...}, { status: 400 });
 *   if (outcome.kind === 'conflict') return NextResponse.json({...}, { status: 409 });
 *   if (outcome.kind === 'replay') return NextResponse.json(outcome.previousResponse.body, { status: outcome.previousResponse.status });
 *   // outcome.kind === 'first'
 *   const result = await doWork();
 *   await rememberIdempotentResponse(tenant, ..., { status: 201, body: result });
 *   return NextResponse.json(result, { status: 201 });
 */
export async function withIdempotency(
  headers: Headers | Record<string, string>,
  tenant: TenantContext,
  body: unknown,
  routeSalt: string,
): Promise<Omit<WithIdempotencyResult<never>, 'kind'> & {
  kind: 'first' | 'replay' | 'conflict' | 'invalid';
  key?: string;
  bodyHash?: string;
  reason?: 'missing' | 'malformed';
  previousResponse?: StoredResponse;
}> {
  const parsed = parseIdempotencyKey(headers);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };

  const bodyHash = hashRequestBody(body, routeSalt);
  const classification = await classifyIdempotencyRequest(tenant, parsed.key, bodyHash);

  if (classification.kind === 'replay') {
    return {
      kind: 'replay',
      key: parsed.key,
      bodyHash,
      previousResponse: classification.previousResponse,
    };
  }
  if (classification.kind === 'conflict') {
    return { kind: 'conflict', key: parsed.key, bodyHash };
  }
  // First — reserve the slot so concurrent workers see a conflict
  await reserveIdempotencyRecord(tenant, parsed.key, bodyHash);
  return { kind: 'first', key: parsed.key, bodyHash };
}
