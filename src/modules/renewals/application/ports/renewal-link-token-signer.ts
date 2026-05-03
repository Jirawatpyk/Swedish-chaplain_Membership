/**
 * T048 (F8 Phase 2 Wave E) — `RenewalLinkTokenSigner` Application port.
 *
 * HMAC-SHA256 signer for renewal-link tokens (research.md R1). Pairs
 * with `RenewalLinkTokenVerifier` (sibling port file). Signer uses
 * ONLY `RENEWAL_LINK_TOKEN_SECRET_PRIMARY`; verifier supports R16
 * dual-key rotation by accepting both PRIMARY and FALLBACK during the
 * 30-day rotation window.
 *
 * Wire format: `<base64url-payload>.<base64url-hmac>` — compact for
 * URL-path inclusion. Adapter assembles the full URL via
 * `APP_BASE_URL` + `/portal/renewal/[token]`.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { RenewalLinkTokenPayload } from '../../domain/renewal-link-token';

export interface SignedRenewalLinkToken {
  /** The HMAC-signed token string suitable for embedding in a URL path. */
  readonly token: string;
  /** Convenience accessor — server-side log breadcrumb. */
  readonly payload: RenewalLinkTokenPayload;
  /**
   * SHA-256 digest of the full token bytes. The
   * `consumed_link_tokens` table PK uses this digest, so the caller
   * can persist the digest for replay-protection without re-hashing.
   */
  readonly tokenSha256: Uint8Array;
}

export interface RenewalLinkTokenSigner {
  /**
   * Sign a payload using the PRIMARY HMAC secret. Throws when the
   * secret env var is missing (boot-time invariant). Failure is fatal
   * — token issuance is on the renewal-cron critical path; refusing
   * to issue is preferable to issuing an unverifiable token.
   */
  sign(payload: RenewalLinkTokenPayload): SignedRenewalLinkToken;
}
