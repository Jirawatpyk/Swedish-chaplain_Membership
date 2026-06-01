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
import {
  buildPayload,
  RENEWAL_LINK_TOKEN_TTL_SECONDS,
} from '../../../domain/renewal-link-token';
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

/**
 * Decide the renewal-email CTA url — go-live audit #8.
 *
 * The redeem-link token has a FIXED `RENEWAL_LINK_TOKEN_TTL_SECONDS` lifetime
 * (kept short to bound replay surface, ≤ the consumed-token prune window). Early
 * reminders (the default schedule sends email steps as far out as T-90/T-60) are
 * dispatched more than that TTL before expiry, so a one-time redeem-link minted
 * then would EXPIRE before the member is likely to act — a dead CTA, the very bug
 * S1-P0-4 set out to remove.
 *
 * So: embed the auto-sign-in redeem-link ONLY when the token will still be valid
 * at expiry (`now + TTL >= expiresAt`). For earlier reminders, point the CTA at the
 * authenticated renewal page directly — the member signs in normally (via the route
 * guard's `from` redirect) and lands on the SAME destination the redeem-link reaches
 * (`/portal/renewal/[memberId]`), just without the magic auto-sign-in. This avoids
 * extending the token lifetime purely to cover advisory early nudges.
 *
 * Single source of truth for BOTH the first-attempt dispatch and the retry path so
 * the redeem-vs-plain decision never drifts between them. Date-based (not offset-day
 * based) so a retry dispatched closer to expiry correctly upgrades to a redeem-link.
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
export function buildRenewalCtaUrl(
  signer: RenewalLinkTokenSigner,
  baseUrl: string,
  args: {
    readonly tenantId: string;
    readonly memberId: string;
    readonly cycleId: string;
    readonly now: Date;
    readonly expiresAtIso: string;
  },
): string {
  const tokenValidThroughExpiry =
    args.now.getTime() + RENEWAL_LINK_TOKEN_TTL_SECONDS * 1000 >=
    Date.parse(args.expiresAtIso);
  if (tokenValidThroughExpiry) {
    return buildRenewalRedeemLinkUrl(signer, baseUrl, args);
  }
  return `${baseUrl}/portal/renewal/${encodeURIComponent(args.memberId)}`;
}
