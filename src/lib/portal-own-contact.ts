/**
 * F114 — the ONE resolver of "which contact is the viewer" behind the FR-029
 * portal timeline projection (rounds 5 and 7). Three hand-copied closures
 * used to answer `null` on any fault with no log; the projection then
 * treated the viewer as unresolvable and dropped their OWN change-request
 * rows too, and nothing said why.
 *
 * A fault is a TYPED fault (`err`), never a `null` that reads as "not linked"
 * — the same distinction `readOwnPendingRequest` carries — so each caller
 * decides what the viewer sees (an error, not a silently shortened
 * timeline). "Not linked" is a legitimate state: `ok(null)`, no log.
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members/domain/member';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';

/** The three fields the resolver reads — structural, so a test double need not build a whole Contact. */
type ContactLike = { readonly contactId: string; readonly linkedUserId: string | null; readonly removedAt: Date | null };
type ListByMember = {
  listByMember(tenant: TenantContext, memberId: MemberId): Promise<Result<readonly ContactLike[], { readonly code: string }>>;
};

export type OwnContactReadError = { readonly code: string };

export async function resolveOwnContactId(
  contactRepo: ListByMember,
  tenant: TenantContext,
  memberId: MemberId,
  userId: string,
  requestId: string,
): Promise<Result<string | null, OwnContactReadError>> {
  try {
    const contacts = await contactRepo.listByMember(tenant, memberId);
    if (!contacts.ok) {
      logger.warn({ requestId, tenantId: tenant.slug, err: contacts.error.code }, 'portal.own_contact_unresolved');
      return err({ code: contacts.error.code });
    }
    return ok(contacts.value.find((c) => c.linkedUserId === userId && !c.removedAt)?.contactId ?? null);
  } catch (e) {
    const code = errKind(e);
    logger.warn({ requestId, tenantId: tenant.slug, err: code }, 'portal.own_contact_unresolved');
    return err({ code });
  }
}
