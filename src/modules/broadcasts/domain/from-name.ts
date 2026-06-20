/**
 * DV-17 — compose the Resend `from_name` for a member-originated broadcast as
 * "<member display name> via <tenant display name>" (data-model.md:59 — e.g.
 * "Fogmaker International AB via SweCham"). Single source so submitBroadcast +
 * saveDraft (and any future originator path) never drift on the " via "
 * separator or the member-then-tenant ordering.
 */
export function composeBroadcastFromName(
  memberDisplayName: string,
  tenantDisplayName: string,
): string {
  return `${memberDisplayName} via ${tenantDisplayName}`;
}
