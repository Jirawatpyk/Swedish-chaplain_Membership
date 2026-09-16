/**
 * F114 — the per-actor ATTEMPT bucket the change-request routes share
 * (review round 1 SEC-I2 / REL-2; PR-3 polish S-2 / S-5).
 *
 * One atomic `rateLimiter.check` per call, keyed per tenant + user + route,
 * consumed on EVERY call that reaches it — hits, misses, refusals and
 * validation errors alike — so a client cannot drive a route's read /
 * probe-audit / count path at line rate. The submit route bounds its gate +
 * validation + `countSubmittedSince` path (60 / 10 min); the by-id portal
 * routes bound the `member_cross_tenant_probe` audit row a miss writes into
 * the append-only trail (10 / 10 min — the legitimate UI calls them a
 * handful of times a session); withdraw is a write and takes the submit
 * bucket's size.
 *
 * The three things a caller could previously get wrong are types now (PR-3
 * review B1): the key comes from {@link attemptBucketKey} and is BRANDED (a
 * hand-assembled one that drops the tenant segment would make one global
 * bucket), the size is one of the two documented names rather than two free
 * numbers, and the errorId prefix is shaped `M114.<surface>.<route>`.
 *
 * A refusal answers the same envelope as the durable FR-008 cap
 * (`{ error: 'rate_limited', retryAfterSeconds }` + `Retry-After`) but is
 * COUNTED apart: `members_change_request_refused_total{reason=attempt_throttled}`
 * — the limiter refused before any read — versus `rate_limited`, the durable
 * cap counted from the request table. It has no audit row (nothing was
 * attempted against the data), so it logs under the CALLER's errorId
 * (`<prefix>.attempts_exhausted`), never a shared literal (T107).
 *
 * On an Upstash outage the limiter does NOT fail open: its fallback is a
 * per-process in-memory window, so the cap holds per serverless instance
 * rather than per tenant + user — weaker, never absent. Every call that lands
 * on the fallback logs `<prefix>.attempt_bucket_fell_back` (R-L4: an earlier
 * draft of this docblock said "logged once" — it is per CALL, and the limiter
 * logs its own line for the same outage). The duplication is deliberate: the
 * limiter's line says Upstash is down, this one says WHICH route's bucket was
 * degraded, which is the dimension an operator reading a 429 spike needs and
 * the one a shared literal would destroy (T107).
 */
import { NextResponse } from 'next/server';
import { rateLimiter } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';
import { membersMetrics } from '@/lib/metrics';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';

/** The submit route's size — and withdraw's (a write). */
export const SUBMIT_ATTEMPTS_PER_WINDOW = 60;
/** The by-id read / acknowledge size: bounds the probe audit a miss writes. */
export const PROBE_ATTEMPTS_PER_WINDOW = 10;
export const ATTEMPT_WINDOW_SECONDS = 600;

/**
 * The four F114 routes that carry a bucket, spelled as the KEY segment each
 * one uses. These strings are live Redis keys — renaming one to something
 * tidier empties the in-flight bucket for every actor on that route.
 */
export type AttemptBucketRoute = 'submit' | 'withdraw' | 'history-item' | 'acknowledge';

declare const attemptBucketKeyBrand: unique symbol;
/**
 * A bucket key built by {@link attemptBucketKey}, and only by it.
 *
 * The key has a grammar — `f114:<route>-attempts:<tenant>:<user>` — and every
 * segment is load-bearing. A hand-assembled key that drops the tenant makes
 * one GLOBAL bucket: tenant B is then refused because tenant A was noisy, and
 * nothing anywhere says so (PR-3 review B1). The brand makes that a compile
 * error instead of an incident.
 */
export type AttemptBucketKey = string & { readonly [attemptBucketKeyBrand]: true };

/** The only way to mint an {@link AttemptBucketKey}. */
export function attemptBucketKey(route: AttemptBucketRoute, tenantSlug: string, userId: string): AttemptBucketKey {
  return `f114:${route}-attempts:${tenantSlug}:${userId}` as AttemptBucketKey;
}

/**
 * The two documented bucket sizes — the ONE choice a route makes.
 *
 * `max` and `windowSeconds` used to be two independent numbers on the input,
 * so a fifth route could invent a size that matches neither the runbook nor
 * `docs/observability.md` § 27.1 and still typecheck.
 */
export type AttemptBucketSizeName = 'submit' | 'probe';

const SIZES: Readonly<Record<AttemptBucketSizeName, { readonly max: number; readonly windowSeconds: number }>> = {
  submit: { max: SUBMIT_ATTEMPTS_PER_WINDOW, windowSeconds: ATTEMPT_WINDOW_SECONDS },
  probe: { max: PROBE_ATTEMPTS_PER_WINDOW, windowSeconds: ATTEMPT_WINDOW_SECONDS },
};

/** Resolve a size name to its `{ max, windowSeconds }` — exported for the pin. */
export function attemptBucketSize(name: AttemptBucketSizeName): { readonly max: number; readonly windowSeconds: number } {
  return SIZES[name];
}

/**
 * The CALLER's own `M114.<surface>.<route>` prefix — `.attempts_exhausted` /
 * `.attempt_bucket_fell_back` are appended to it. Shaped at the type level so
 * a two-segment id cannot be handed over; that it is the caller's OWN id (not
 * a neighbour's const) is checked by the source scan in
 * `tests/unit/architecture/change-requests-error-id.test.ts`.
 */
export type AttemptBucketErrorIdPrefix = `M114.${string}.${string}`;

export type AttemptBucketInput = {
  /** From {@link attemptBucketKey} — one bucket per route + tenant + user. */
  readonly key: AttemptBucketKey;
  readonly size: AttemptBucketSizeName;
  readonly errorIdPrefix: AttemptBucketErrorIdPrefix;
  /** The caller's log-line prefix, e.g. `change-requests.submit`. */
  readonly logPrefix: string;
  readonly requestId: string;
  readonly tenantId: string;
};

/**
 * Consume one attempt; answer the 429 when the bucket is exhausted, `null`
 * when the caller may proceed.
 */
export async function refuseWhenAttemptsExhausted(input: AttemptBucketInput): Promise<NextResponse | null> {
  const { max, windowSeconds } = SIZES[input.size];
  const attempts = await rateLimiter.check(input.key, max, windowSeconds);
  if ('fellBack' in attempts && attempts.fellBack === true) {
    logger.warn(
      { errorId: `${input.errorIdPrefix}.attempt_bucket_fell_back`, requestId: input.requestId, tenantId: input.tenantId },
      `${input.logPrefix}: attempt bucket on the in-process fallback (Upstash unreachable)`,
    );
  }
  if (attempts.success) return null;
  // the one F114 refusal with no audit row — so it logs, under the caller's id
  logger.warn(
    { errorId: `${input.errorIdPrefix}.attempts_exhausted`, requestId: input.requestId, tenantId: input.tenantId, reset: attempts.reset },
    `${input.logPrefix}: attempt bucket exhausted`,
  );
  membersMetrics.changeRequests.refused(input.tenantId, 'attempt_throttled');
  const retryAfterSeconds = retryAfterSecondsFromRl({ reset: attempts.reset });
  return NextResponse.json(
    { error: 'rate_limited', retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}
