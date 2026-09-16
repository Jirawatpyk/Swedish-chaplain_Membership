/**
 * `runIdempotent` — the post-reservation section of an Idempotency-Key route,
 * with the reservation RELEASED on every exit that does not remember a
 * response (117 idempotency-release sweep).
 *
 * The defect class it closes
 * -------------------------
 * `withIdempotency` / `reserveIdempotencyRecord` write `{ bodyHash,
 * response: null }` with a 24 h TTL, and `classifyIdempotencyRequest` reads a
 * reserved-but-unwritten record as a CONFLICT ("another worker is still
 * working"). That is right while the handler runs — and wrong the moment it
 * finishes with an outcome it must not remember: a 429 (time-bound), a 5xx (a
 * fault), a thrown error, or any early return between the reservation and the
 * remember. The reservation is then left behind, so the SAME key + the SAME
 * body — the retry that `Retry-After` and every HTTP client's retry policy
 * tell the client to make — answers the conflict status for the full 24 h.
 * PR #371 / T121 fixed it by hand on one route; seventeen others had no
 * release call at all.
 *
 * Why a closure rather than a `release()` the caller remembers to call: the
 * class recurs precisely because a hand-written release has to be repeated at
 * every exit, and a new arm added later gets none. `finally` covers every exit
 * there is, including the ones nobody wrote down.
 *
 * Usage — the whole post-reservation tail moves inside `work`:
 *
 *   const reserved = await reserveIdempotencyRecord(tenant, key, bodyHash);
 *   if (!reserved.ok) return json503();
 *   return runIdempotent(tenant, { key, bodyHash }, async ({ remember }) => {
 *     const result = await useCase(...);
 *     if (result.ok) {
 *       await remember({ status: 200, body });     // was rememberIdempotentResponse
 *       return NextResponse.json(body, { status: 200 });
 *     }
 *     return NextResponse.json(errorBody, { status: 500 });  // released
 *   });
 *
 * Pass `null` for the reservation when the route's `Idempotency-Key` header is
 * OPTIONAL and absent — `remember` is then a no-op and there is nothing to
 * release.
 *
 * This lives outside `./idempotency` on purpose: the route contract suites
 * `vi.mock('@/lib/idempotency')` with an explicit factory (it builds an Upstash
 * client at module load), so a `runIdempotent` exported from there would be
 * replaced by a stub in every one of them and the release path would never be
 * exercised by the tests that are supposed to prove it. From here it calls
 * through to whatever `@/lib/idempotency` resolves to — the real module in
 * production, the suite's spies under test.
 */

import {
  releaseIdempotencyRecord,
  rememberIdempotentResponse,
  type StoredResponse,
} from './idempotency';
import { logger } from './logger';
import type { TenantContext } from '@/modules/tenants';

/** The key + body hash a `reserveIdempotencyRecord` call just reserved. */
export type IdempotentReservation = {
  readonly key: string;
  readonly bodyHash: string;
};

export type IdempotentRun = {
  /**
   * Remember this response under the reserved key and mark the reservation
   * ANSWERED, so it is not released on the way out. Same semantics as
   * `rememberIdempotentResponse` (best-effort; a Redis outage is logged, never
   * thrown) — the key + body hash come from the reservation.
   *
   * A 429 or a 5xx is REFUSED here and released instead: a rate limit is
   * time-bound and a fault is a fault, so a retry must re-evaluate rather than
   * replay. No caller asks for one today; the guard exists so a future arm
   * cannot make one stick for 24 h.
   */
  readonly remember: (response: StoredResponse) => Promise<void>;
};

/** A response that must never be replayed from the idempotency record. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function runIdempotent<T>(
  tenant: TenantContext,
  reservation: IdempotentReservation | null,
  work: (run: IdempotentRun) => Promise<T>,
): Promise<T> {
  if (reservation === null) {
    // No key on this request — nothing was reserved, nothing to remember.
    return work({ remember: async () => undefined });
  }

  let answered = false;
  try {
    return await work({
      remember: async (response) => {
        if (isTransient(response.status)) {
          logger.warn(
            { tenant: tenant.slug, status: response.status },
            'idempotency: refused to remember a transient response — releasing the reservation instead',
          );
          return;
        }
        await rememberIdempotentResponse(
          tenant,
          reservation.key,
          reservation.bodyHash,
          response,
        );
        // Set AFTER the write: if remembering itself blew up, the reservation
        // must still be released rather than left to burn the key.
        answered = true;
      },
    });
  } finally {
    // Every exit that did not remember: a 429, a 5xx, a 4xx this route does
    // not cache, a thrown error, an early return. `work` throwing releases
    // first and then rethrows.
    if (!answered) await releaseIdempotencyRecord(tenant, reservation.key);
  }
}
