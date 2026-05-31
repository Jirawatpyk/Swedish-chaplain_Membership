/**
 * Build the renewal-reminder email CTA URL — go-live audit S1-P0-4 + S1-P1-1.
 *
 * The renewal email CTA previously hard-coded `${baseUrl}/portal/account` (a
 * dead-end: the member landed on account settings, NOT the renewal flow) while
 * the signed-token redeem-link route + HMAC signer sat as dead code. This helper
 * wires them together: it signs a single-use HMAC token for (tenant, member,
 * cycle) and assembles the public redeem-link URL the email CTA points to.
 *
 * Redeem-link contract (`src/app/api/portal/renewal/redeem-link/route.ts`):
 *   GET /api/portal/renewal/redeem-link?t=<token>
 *   → verify (HMAC + expiry + tenant + cycle + replay) → create session →
 *     302 /portal/renewal/[memberId].
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
import { buildPayload } from '../../../domain/renewal-link-token';
import type { RenewalLinkTokenSigner } from '../../ports/renewal-link-token-signer';

export function buildRenewalRedeemLinkUrl(
  signer: RenewalLinkTokenSigner,
  baseUrl: string,
  args: {
    readonly tenantId: string;
    readonly memberId: string;
    readonly cycleId: string;
    readonly now: Date;
  },
): string {
  const payload = buildPayload({
    tenantId: args.tenantId,
    memberId: args.memberId,
    cycleId: args.cycleId,
    now: args.now,
  });
  const { token } = signer.sign(payload);
  return `${baseUrl}/api/portal/renewal/redeem-link?t=${encodeURIComponent(token)}`;
}
