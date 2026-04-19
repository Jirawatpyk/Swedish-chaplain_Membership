/**
 * T027 — Member identity snapshot (F4).
 *
 * Copied onto the invoice at issue time so the customer block on the
 * PDF reflects the member's data as it was when the tax document was
 * issued — NOT the live data if the member subsequently updates their
 * address / legal name / tax id (FR-038).
 */
export interface MemberIdentitySnapshot {
  readonly legal_name: string;
  readonly tax_id: string | null;
  readonly address: string;
  readonly primary_contact_name: string;
  readonly primary_contact_email: string;
}

export function makeMemberIdentitySnapshot(parts: MemberIdentitySnapshot): MemberIdentitySnapshot {
  return Object.freeze({ ...parts });
}
