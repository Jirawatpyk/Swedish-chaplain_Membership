import { getCurrentSession } from '@/lib/auth-session';
import { isPortalPathAllowed } from '@/lib/lapsed-portal-scope';
import { loadMembershipAccess } from '@/lib/load-membership-access';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';

const BENEFITS_PATH = '/portal/benefits';

export interface PortalBroadcastBack {
  readonly href: string;
  /** The link leads to the dashboard, so it reads "Back to dashboard". */
  readonly toDashboard: boolean;
}

const TO_LIST: PortalBroadcastBack = { href: `${BENEFITS_PATH}?tab=broadcasts`, toDashboard: false };

/**
 * Where the E-Blast detail's Back link leads (UX review M5): the E-Blast list
 * on the benefits page, unless the member's standing blocks that page — a
 * terminated member's Back leads to the dashboard. The same request-cached,
 * audit-free access read the benefits page gates on; fails open to `full`.
 */
export async function portalBroadcastBack(tenantSlug: string, memberId: string): Promise<PortalBroadcastBack> {
  const access = await loadMembershipAccess(tenantSlug, memberId);
  return isPortalPathAllowed(access.access, BENEFITS_PATH) ? TO_LIST : { href: '/portal', toDashboard: true };
}

/**
 * The same, for the not-found state, which gets no params and runs after the
 * page gave up — possibly because the member lookup itself failed. Any gap
 * (no session, no member row, a failing read) falls back to the E-Blast list,
 * the link it showed before; a terminated member who follows it is redirected
 * by the portal guard. A failing read is logged (the error class only), so an
 * outage is not hidden behind the fallback.
 */
export async function portalBroadcastBackForViewer(): Promise<PortalBroadcastBack> {
  try {
    const session = await getCurrentSession();
    if (!session) return TO_LIST;
    const tenant = resolveTenantFromRequest();
    const member = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(tenant, session.user.id);
    if (!member.ok) return TO_LIST;
    return await portalBroadcastBack(tenant.slug, member.value.memberId);
  } catch (e) {
    logger.warn({ err: errKind(e) }, 'broadcasts.detail_not_found.back_link_fallback');
    return TO_LIST;
  }
}
