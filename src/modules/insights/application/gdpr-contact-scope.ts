/**
 * GDPR Art. 15(4) / 20(4) · PDPA §30 — whose contact data a member archive
 * may carry.
 *
 * Any linked portal user of a member (a colleague) may request the member's
 * archive, so the archive must not hand one colleague another's personal data
 * (the same class of rule as F114 FR-029 for change-request history). Decision
 * (pdpa-gdpr-compliance-officer): the requester gets their OWN contact record
 * in full; current colleagues appear only with the business identity the
 * member already shares internally — name, role, primary flag; former
 * (removed) colleagues are left out entirely (Art. 5(1)(c)/(e)). A staff
 * on-behalf export (no linked requester) gets the colleague view for everyone.
 *
 * Pure — no framework/ORM imports (Constitution Principle III).
 */

/** The contact fields the projection reads (a subset of the members `Contact`). */
export interface ScopableContact {
  readonly contactId: string;
  readonly linkedUserId: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly dateOfBirth: Date | string | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: string | null;
  readonly isPrimary: boolean;
  readonly removedAt: Date | string | null;
  readonly createdAt: Date | string | null;
}

function isoOrNull(d: Date | string | null): string | null {
  if (d === null) return null;
  return typeof d === 'string' ? d : d.toISOString();
}

/**
 * Project the member's contacts for the archive's viewer. `requesterUserId` is
 * the requester's user id when they are a linked contact of the member, else
 * `null` (staff on-behalf / unlinked requester — nobody's record is "own").
 */
export function projectContactsForRequester(
  contacts: readonly ScopableContact[],
  requesterUserId: string | null,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of contacts) {
    const own = requesterUserId !== null && c.linkedUserId === requesterUserId;
    if (own) {
      out.push({
        contactId: c.contactId,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        // P2 Wave-0 — a contact's date of birth is material personal data
        // (Art. 15/20) — the requester's own, so it stays.
        dateOfBirth: isoOrNull(c.dateOfBirth),
        roleTitle: c.roleTitle,
        preferredLanguage: c.preferredLanguage,
        isPrimary: c.isPrimary,
        removedAt: isoOrNull(c.removedAt),
        createdAt: isoOrNull(c.createdAt),
      });
      continue;
    }
    if (c.removedAt !== null) continue;
    out.push({
      firstName: c.firstName,
      lastName: c.lastName,
      roleTitle: c.roleTitle,
      isPrimary: c.isPrimary,
    });
  }
  return out;
}
