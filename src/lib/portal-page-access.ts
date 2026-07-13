/**
 * 059-membership-suspension Task 7 — SSR-load page chokepoint.
 *
 * Defense-in-depth alongside the ALWAYS-ON `requireMemberContext` API gate
 * (`src/lib/member-context.ts`). **Next.js 16 layouts do NOT re-run on
 * client-side navigation between sibling routes** — they only re-execute on
 * SSR load, a hard refresh, or a direct/typed-URL navigation. So this guard
 * catches "a terminated/suspended member deep-links or refreshes a blocked
 * portal page"; it is NOT a substitute for the API-layer gate, which runs on
 * every data fetch/mutation regardless of how the client got there.
 *
 * Call from `(member)/portal/layout.tsx` immediately after
 * `requireSession('member')` resolves (and after the cross-portal staff
 * guard, so a staff account — which has no linked member — never reaches
 * this lookup). Resolves the member linked to the session user the same way
 * `requireMemberContext` does (`memberRepo.findByLinkedUserId`), reads the
 * current pathname from the `x-pathname` header `src/proxy.ts` sets on every
 * request, and calls `checkPortalAccess`. A blocked decision redirects to
 * the bare `/portal` dashboard, which renders the terminated "membership
 * ended" mailto CTA (see `(member)/portal/_components/membership-stat-
 * section.tsx`) instead of the normal widgets.
 *
 * Fails OPEN (logs + returns without redirecting) on:
 *   - no linked member for the session user (data inconsistency; other
 *     portal surfaces already handle this independently — nothing to gate
 *     on here)
 *   - any lookup/DB error — a layout-level guard must never be the surface
 *     that takes down the whole portal on a transient fault, mirroring
 *     `checkPortalAccess`'s own fail-open contract for its internal repo
 *     read.
 *
 * `redirect()` is called OUTSIDE the try/catch below: Next.js implements it
 * by throwing a special digest-tagged error that must propagate uncaught to
 * unwind the render — swallowing it in a broad catch would silently no-op
 * the redirect.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { CurrentSession } from '@/lib/auth-session';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { checkPortalAccess } from './lapsed-portal-scope';
import { buildPortalAccessDeps } from './portal-access-deps';

export async function enforcePortalPageAccess(current: CurrentSession): Promise<void> {
  const blocked = await isPortalPageAccessBlocked(current);
  if (blocked) {
    redirect('/portal');
  }
}

async function isPortalPageAccessBlocked(current: CurrentSession): Promise<boolean> {
  try {
    const h = await headers();
    const rawPath = h.get('x-pathname');
    const pathname = rawPath ? (rawPath.split('?')[0] ?? rawPath) : '/portal';
    const requestId = requestIdFromHeaders(h);

    // `resolveTenantFromHeaders` (not the no-arg `resolveTenantFromRequest()`
    // some other portal pages use) so this chokepoint honours the same
    // `x-tenant` E2E-override mechanism `requireMemberContext` does — Task 10
    // (Playwright E2E for the DENY side) drives its throwaway test tenant
    // through that header, and a no-arg resolver would silently route every
    // check at the REAL deployed tenant regardless of the test fixture.
    const tenant = resolveTenantFromHeaders(h);
    const deps = buildMembersDeps(tenant);
    const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, current.user.id);
    if (!memberResult.ok) {
      // No linked member (or a lookup fault) — nothing to gate on here.
      // `requireMemberContext` independently handles the "member-role user,
      // no linked member" data-inconsistency case for API routes.
      return false;
    }

    const decision = await checkPortalAccess(buildPortalAccessDeps(tenant), {
      tenantId: tenant.slug,
      memberId: memberResult.value.memberId,
      pathname,
      actorUserId: current.user.id,
      correlationId: requestId,
      requestId,
    });
    return !decision.allowed;
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        userIdHash: hashId(current.user.id),
      },
      '[enforce-portal-page-access] lookup failed — failing open (no redirect)',
    );
    return false;
  }
}
