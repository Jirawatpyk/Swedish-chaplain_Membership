/**
 * F114 — the ONE resolver of "which contact is the viewer" behind the FR-029
 * portal timeline projection (round 5, silent-failure #6 / tests I-3). Three
 * hand-copied closures used to answer `null` on any fault with no log; the
 * projection then treated the viewer as unresolvable and dropped their OWN
 * change-request rows too, and nothing said why.
 *
 * Fail-closed stays (a fault → `null` → every own-contact row is dropped for
 * this viewer, colleagues' rows included) — but a fault is now LOGGED, and
 * "not linked" (a legitimate state) is not.
 */
import type { TenantContext } from '@/modules/tenants';
import type { ContactRepo } from '@/modules/members/application/ports/contact-repo';
import type { Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';

/** The three fields the resolver reads — structural, so a test double need not build a whole Contact. */
type ContactLike = { readonly contactId: string; readonly linkedUserId: string | null; readonly removedAt: Date | null };
type ListByMember = {
  listByMember(
    tenant: TenantContext,
    memberId: Parameters<ContactRepo['listByMember']>[1],
  ): Promise<Result<readonly ContactLike[], { readonly code: string }>>;
};

export async function resolveOwnContactId(
  contactRepo: ListByMember,
  tenant: TenantContext,
  memberId: Parameters<ContactRepo['listByMember']>[1] | string,
  userId: string,
  requestId: string,
): Promise<string | null> {
  try {
    const contacts = await contactRepo.listByMember(tenant, memberId as Parameters<ContactRepo['listByMember']>[1]);
    if (!contacts.ok) {
      logger.warn({ requestId, tenantId: tenant.slug, err: contacts.error.code }, 'portal.own_contact_unresolved');
      return null;
    }
    return contacts.value.find((c) => String(c.linkedUserId) === userId && !c.removedAt)?.contactId ?? null;
  } catch (e) {
    logger.warn({ requestId, tenantId: tenant.slug, err: errKind(e) }, 'portal.own_contact_unresolved');
    return null;
  }
}
