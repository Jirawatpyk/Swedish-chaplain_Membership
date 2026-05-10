/**
 * F8 Phase 5 R1 v2 step 9 — token redemption + auto-sign-in.
 *
 * Deep-review fix — closes the gap where `verifyRenewalLinkToken` use-case
 * existed but had ZERO call-sites. Without this route, a member who
 * clicked the renewal email link would hit `requireSession('member')`
 * on the portal page, get bounced to the sign-in form, lose the token,
 * and never reach the renewal flow. This route is the public entry
 * point that:
 *
 *   1. Reads the HMAC token from the `t` query param.
 *   2. Verifies the token via `verifyRenewalLinkToken` (HMAC + expiry +
 *      tenant + cycle + replay-detection).
 *   3. Resolves the member's primary contact and its linked user id
 *      (the F1 user account that "owns" the member's portal access).
 *   4. Creates a fresh session for that user via the F1 `sessionRepo`.
 *   5. Sets the `swecham_session` cookie + 302-redirects to
 *      `/portal/renewal/[memberId]`.
 *
 * Failure modes ALL return a generic 302 to `/portal/sign-in?reason=link_invalid`
 * (no oracle on token state — Constitution Principle I clause 4 / FR-027
 * generic-error policy):
 *   - malformed / mac_mismatch / expired / replayed / cross-tenant
 *   - cycle not found / member-cycle mismatch
 *   - member has no primary contact
 *   - primary contact has no `linked_user_id` (admin-only context — no
 *     portal access wired)
 *
 * Auth: PUBLIC route — pre-session by design. The token IS the proof
 * of authorisation. Bearer/CSRF are not applicable; the proxy allows
 * this path because `/api/portal/renewal/**` is gated only by the F8
 * kill-switch (which we honour at the top of this handler).
 *
 * Response headers — `cache-control: no-store` + `referrer-policy:
 * no-referrer` so the token never appears in the browser's referer
 * header on the post-redirect navigation chain or in any intermediate
 * cache. The token is ONE-TIME-USE (consumed by `markConsumed`); a
 * leak post-consumption is a replay-detection win, not a credential
 * leak — but we minimise exposure regardless.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { setSessionCookie } from '@/lib/auth-cookies';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { uuidv7 } from '@/lib/request-id';
import { getClientIp } from '@/lib/client-ip';
import { defaultSignInDeps } from '@/lib/auth-deps';
import { asUserId } from '@/modules/auth';
import { asMemberId, type Contact } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asTenantContext } from '@/modules/tenants';
import {
  verifyRenewalLinkToken,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Generic redirect target on ANY failure path. The destination is a
 * member-portal sign-in surface that shows a localised "this link is
 * no longer valid" notice without revealing WHICH failure mode
 * triggered (preserves the no-oracle policy).
 */
const FAILURE_REDIRECT = '/portal/sign-in?reason=link_invalid';

function failureRedirect(req: NextRequest): NextResponse {
  const url = new URL(FAILURE_REDIRECT, req.url);
  const res = NextResponse.redirect(url, { status: 302 });
  res.headers.set('cache-control', 'no-store');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Kill-switch — short-circuit BEFORE any DB read so a disabled-F8
  // deploy never touches the renewals composition root.
  if (!env.features.f8Renewals) {
    // Match the proxy 503 contract for F8 paths.
    return NextResponse.json(
      { error: { code: 'feature_disabled' } },
      { status: 503 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const tenantCtx = asTenantContext(tenant.slug);
  const correlationId = uuidv7();

  // Token MUST come from `?t=`. We never read the body or other params
  // so the token value is bounded to one source — minimises leak surface.
  const rawToken = request.nextUrl.searchParams.get('t') ?? '';
  if (rawToken.length === 0) {
    logger.warn(
      { correlationId, tenantId: tenant.slug },
      '[redeem-renewal-link] missing token param',
    );
    return failureRedirect(request);
  }

  try {
    const renewalsDeps = makeRenewalsDeps(tenant.slug);
    const membersDeps = buildMembersDeps(tenantCtx);
    const now = new Date();

    // Round 9 — pre-consume gate. Resolve the member's primary-contact
    // linked user + run the same eligibility checks as sign-in.ts BEFORE
    // verify proceeds to markConsumed. Returning 'block' aborts token
    // consumption so the link stays valid for retry/re-issue. Closes the
    // Round 8 half-fix where the token was consumed BEFORE we discovered
    // the user was ineligible, leaving the user stranded with a burned
    // link.
    //
    // The gate captures `resolvedUserId` in a closure so the post-verify
    // session creation can use the same UserId without a second lookup.
    let resolvedUserId: ReturnType<typeof asUserId> | null = null;
    const preConsumeGate = async (args: {
      readonly memberId: string;
      readonly cycleId: string;
    }): Promise<'allow' | 'block'> => {
      const contactsResult = await membersDeps.contactRepo.listByMember(
        tenantCtx,
        asMemberId(args.memberId),
      );
      if (!contactsResult.ok) {
        logger.error(
          {
            correlationId,
            tenantId: tenant.slug,
            memberId: args.memberId,
            cycleId: args.cycleId,
            err: contactsResult.error.code,
          },
          '[redeem-renewal-link] preConsumeGate: failed to list member contacts',
        );
        return 'block';
      }
      const primary = contactsResult.value.find(
        (c: Contact) => c.isPrimary && !c.removedAt,
      );
      if (!primary || !primary.linkedUserId) {
        logger.warn(
          {
            correlationId,
            tenantId: tenant.slug,
            memberId: args.memberId,
            hasPrimary: primary !== undefined,
            hasLinkedUser: primary?.linkedUserId != null,
          },
          '[redeem-renewal-link] preConsumeGate: member has no primary-contact linked user — token NOT consumed',
        );
        return 'block';
      }
      // Mirror sign-in.ts checks (lines 200-261): status==='active',
      // emailVerified, !requiresPasswordReset, not locked.
      const userId = asUserId(primary.linkedUserId);
      const linkedUser = await defaultSignInDeps.users.findById(userId);
      const userBlocked =
        linkedUser === null ||
        linkedUser.status !== 'active' ||
        !linkedUser.emailVerified ||
        linkedUser.requiresPasswordReset ||
        (linkedUser.lockedUntil !== null && linkedUser.lockedUntil > now);
      if (userBlocked) {
        logger.error(
          {
            correlationId,
            tenantId: tenant.slug,
            memberId: args.memberId,
            cycleId: args.cycleId,
            userId,
            userExists: linkedUser !== null,
            userStatus: linkedUser?.status ?? null,
            emailVerified: linkedUser?.emailVerified ?? null,
            requiresPasswordReset:
              linkedUser?.requiresPasswordReset ?? null,
            lockedUntil: linkedUser?.lockedUntil?.toISOString() ?? null,
          },
          '[redeem-renewal-link] preConsumeGate: linked user is not sign-in-eligible — token NOT consumed; admin can re-enable + member retries link',
        );
        return 'block';
      }
      resolvedUserId = userId;
      return 'allow';
    };

    const verifyResult = await verifyRenewalLinkToken(
      {
        tokenVerifier: renewalsDeps.tokenVerifier,
        cyclesRepo: renewalsDeps.cyclesRepo,
        auditEmitter: renewalsDeps.auditEmitter,
        tenant: renewalsDeps.tenant,
        consumedLinkTokensRepo: renewalsDeps.consumedLinkTokensRepo,
      },
      {
        rawToken,
        expectedTenantId: tenant.slug,
        correlationId,
        requestId: null,
        now,
      },
      preConsumeGate,
    );

    if (!verifyResult.ok) {
      // Round 8 review-fix — `kind` fork: `invalid_input` is a
      // programmer-error path (Zod schema reject — should be impossible
      // given the explicit empty-token guard above) so we log loudly
      // for ops triage. `invalid_token` is the security-rejection
      // path which `verifyRenewalLinkToken` already emitted
      // `renewal_token_invalid` audit for. Both paths return the same
      // generic 302 (no oracle on token state per FR-027).
      if (verifyResult.error.kind === 'invalid_input') {
        logger.error(
          {
            correlationId,
            tenantId: tenant.slug,
            message: verifyResult.error.message,
          },
          '[redeem-renewal-link] programmer error — verifyRenewalLinkToken rejected input shape (no audit emitted by use-case)',
        );
      }
      return failureRedirect(request);
    }

    const memberId = verifyResult.value.memberId;
    // The preConsumeGate captured `resolvedUserId` on the success path.
    // Verify success implies the gate returned 'allow', which implies
    // the user lookup succeeded and was eligible. The token has already
    // been consumed by `verifyRenewalLinkToken` step 8.
    if (resolvedUserId === null) {
      // Defensive — should be unreachable. If it ever fires, the gate
      // contract has drifted and we want a loud signal.
      logger.error(
        { correlationId, tenantId: tenant.slug, memberId },
        '[redeem-renewal-link] verify succeeded but preConsumeGate did not capture userId — gate contract drift',
      );
      return failureRedirect(request);
    }
    const userId: ReturnType<typeof asUserId> = resolvedUserId;

    // Create a fresh session for the linked user. Mirrors sign-in.ts
    // step 8 — same `sessions.create({ userId, sourceIp, now })`
    // contract, same 12h absolute lifetime via session repo's internal
    // ABSOLUTE_LIFETIME_MS.
    const sourceIp = getClientIp(request);
    const session = await defaultSignInDeps.sessions.create({
      userId,
      sourceIp,
      now,
    });

    // Idempotent (`cycle_already_completed`) and `success` both warrant
    // signing the member in — the difference is the destination copy
    // shown by the page itself. Both land on /portal/renewal/[memberId].
    const target = new URL(`/portal/renewal/${memberId}`, request.url);
    const res = NextResponse.redirect(target, { status: 302 });
    res.headers.set('cache-control', 'no-store');
    res.headers.set('referrer-policy', 'no-referrer');

    // Cookie set must propagate via the response. setSessionCookie reads
    // from the request cookies API, so we set it directly on the
    // response headers here for the redirect-with-cookie pattern.
    // Mirror the COOKIE_OPTIONS in @/lib/auth-cookies.ts; redeem-link
    // is the ONLY surface outside sign-in.ts that mints a session.
    res.cookies.set('swecham_session', session.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    return res;
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId: tenant.slug,
      },
      '[redeem-renewal-link] unexpected error — falling through to generic failure',
    );
    return failureRedirect(request);
  }
}

// `setSessionCookie` import kept for parity with sign-in.ts even though
// the redirect-cookie pattern uses NextResponse#cookies.set. Eslint
// no-unused-imports would flag it; mark intentional via `void`.
void setSessionCookie;
