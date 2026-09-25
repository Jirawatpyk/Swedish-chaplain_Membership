/**
 * F119 T059 / T060 — `MemberPortalRecipientPort` Application port.
 *
 * The member company's contacts who can sign in to the portal and give the
 * approval: live contacts (`removed_at IS NULL`) of the owning member,
 * linked to an ACTIVE `member`-role user. A linked login that is still only
 * invited, or disabled, cannot approve anything, so it does not count. An
 * empty list is what the send refuses as `no_portal_user` (spec § Edge
 * Cases — a proxy-submitted E-Blast whose member has no portal user cannot
 * be sent for approval). Which one of them is emailed is the Application's
 * rule (`chooseApprovalRecipient`), not the adapter's.
 *
 * `tx` is the caller's `runInTenant` tx: contacts are tenant-scoped (RLS +
 * FORCE), so the contact read MUST ride it. The composition root is
 * `src/lib/broadcast-approval-deps.ts` (members + auth barrels).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';

export interface PortalContact {
  readonly contactId: string;
  /** The contact's CURRENT address. */
  readonly email: string;
  /** `contacts.preferred_language` (FR-024). */
  readonly locale: 'en' | 'th' | 'sv';
  readonly linkedUserId: string;
  readonly isPrimary: boolean;
}

export interface MemberPortalRecipientPort {
  listActivePortalContacts(
    tenant: TenantContext,
    memberId: string,
    tx: unknown,
  ): Promise<readonly PortalContact[]>;
}
