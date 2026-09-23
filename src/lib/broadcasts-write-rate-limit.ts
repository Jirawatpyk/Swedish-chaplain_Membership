/**
 * F119 T026a / T062a / T081 / T081a — the two NEW write buckets the E-Blast
 * approval feature adds (contracts § Rate limits; spec § Roles), in the
 * `RECIPIENT_COUNT_RATE_MAX` / `_WINDOW_SECONDS` shape of
 * `src/lib/broadcasts-recipient-count.ts` so the routes cannot drift on the
 * numbers or the key format.
 *
 *   staff  — 30 requests / 60 s per (tenant, actor): brand PATCH, the
 *            staff + template image uploads, and (PR-2) start / save / send
 *            a version, confirm a schedule, the widened reject + cancel.
 *   member — 60 / minute per (tenant, user): the inline-image upload and
 *            (PR-2) approve / request changes / withdraw.
 *
 * Both ride `broadcastsRateLimiter.checkLimit`, which CONSUMES on check —
 * an atomic check, never a peek-then-act — and are consumed BEFORE the
 * write so a refused call stores nothing. `approve` / `reject` / `cancel`
 * carried no bucket at all before F119; every number here is an addition.
 */

export const STAFF_WRITE_RATE_MAX = 30;
export const STAFF_WRITE_RATE_WINDOW_SECONDS = 60;
export const MEMBER_WRITE_RATE_MAX = 60;
export const MEMBER_WRITE_RATE_WINDOW_SECONDS = 60;

export function staffWriteRateKey(tenantSlug: string, userId: string): string {
  return `broadcasts:staff-write:${tenantSlug}:${userId}`;
}

export function memberWriteRateKey(tenantSlug: string, userId: string): string {
  return `broadcasts:member-write:${tenantSlug}:${userId}`;
}
