/**
 * F119 T059 / T060 — which of a member company's active portal contacts is
 * emailed about an approval round (contracts/dashboard-and-notifications.md
 * § 3: "the member's contact", one row per broadcast).
 *
 * The contact whose portal login SUBMITTED the E-Blast first — they wrote it
 * and are waiting for it; else the member's primary contact; else the lowest
 * contact id, so the choice is deterministic. Spec § Edge Cases ("the
 * contact who submitted has left the company: any authorised portal user of
 * the same member company can review and approve") is why the fallbacks
 * exist. `null` ⇒ nobody at the company can sign in to approve.
 *
 * Pure Application — no framework imports.
 */
import type { PortalContact } from '../../ports/member-portal-recipient-port';

export function chooseApprovalRecipient(
  contacts: readonly PortalContact[],
  submitterUserId: string | null,
): PortalContact | null {
  return (
    contacts.find((c) => c.linkedUserId === submitterUserId) ??
    contacts.find((c) => c.isPrimary) ??
    [...contacts].sort((a, b) => a.contactId.localeCompare(b.contactId))[0] ??
    null
  );
}
