/**
 * POST /api/auth/users/[id]/reissue-invite (Staff Invitation Lifecycle, Task 2).
 *
 * Admin-only. Exposes Task 1's `resendStaffInvitation` use case: mints a
 * fresh invitation token + re-enqueues the outbox email for a `pending`
 * staff user, and emits the `invitation_reissued` audit event.
 *
 * RA-1 (security) — atomic consume-BEFORE the use case runs, 3/hour, keyed
 * on (tenant, TARGET userId) rather than the acting admin. Keying on the
 * target (not the admin) closes the DV-11 gap: N different admins hitting
 * this route for the SAME pending user would otherwise get N independent
 * buckets and could collectively mail-bomb that one inbox well past the
 * stated per-recipient budget. Mirrors the F3 resend-verification route's
 * identical per-document throttle
 * (src/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route.ts).
 *
 * A short-lived peek-then-consume variant was tried (spend the token only
 * after a confirmed send) and REVERTED: it removes the atomic mail-bomb
 * guarantee. Under N concurrent requests for the same target, every
 * request can `peek` the bucket as not-yet-full before any of them
 * `check`s it — all N pass the gate and all N send before any of them
 * consumes a token, bypassing the 3/hour budget entirely (DV-11 bypass).
 * A single consuming `check` called BEFORE the use case closes that
 * window: the limiter itself serializes concurrent callers. The tradeoff
 * — a 404 (user-not-found) / 409 (not-pending) response also spends one
 * token even though no email was sent — is ACCEPTED: it is fail-closed
 * and harmless (worst case, an admin's probe against a bad id costs part
 * of the budget), and the alternative (peek-then-consume) is worse because
 * it loses the atomic guarantee under concurrency. This supersedes the
 * earlier /code-review nit that suggested not counting non-sends.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { resendStaffInvitation, asUserId } from '@/modules/auth';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;
  // B3 — outer try/catch (see sign-in/route.ts B3 note).
  try {
    const { id } = await params;
    const tenant = resolveTenantFromRequest(request);

    // RA-1 — per-(tenant, target) resend throttle. Atomic consume BEFORE
    // the use case runs: the ONLY way to keep the mail-bomb guarantee
    // under concurrent requests (see the RA-1 doc comment above).
    const rl = await rateLimiter.check(`reissue-invite:${tenant.slug}:${id}`, 3, 3600);
    if (!rl.success) {
      return NextResponse.json(
        { error: 'rate-limited' },
        { status: 429, headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) } },
      );
    }

    const result = await resendStaffInvitation({
      userId: asUserId(id),
      actorUserId: ctx.current.user.id,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
      // RA-6 — no resolveLocaleFromRequest helper exists, and F1 users have no
      // stored locale column; enqueueInvitationInTx defaults to English when
      // locale is undefined. Reissued invites therefore always render in
      // English (accepted tradeoff per RA-6).
      locale: undefined,
      tenantId: tenant.slug,
    });

    if (result.ok) {
      return NextResponse.json({ ok: true, email: result.value.email }, { status: 200 });
    }

    const { error } = result;
    switch (error.code) {
      case 'user-not-found':
        return NextResponse.json({ error: 'user-not-found' }, { status: 404 });
      case 'not-pending':
        return NextResponse.json({ error: 'not-pending' }, { status: 409 });
      default: {
        logger.error(
          { requestId: ctx.requestId },
          'reissue-invite: unhandled error variant',
        );
        return NextResponse.json({ error: 'server-error' }, { status: 500 });
      }
    }
  } catch (error) {
    logger.error(
      { err: error, requestId: ctx.requestId },
      'reissue-invite.infra-error',
    );
    return NextResponse.json(
      { error: 'server-error', requestId: ctx.requestId },
      { status: 500 },
    );
  }
}
