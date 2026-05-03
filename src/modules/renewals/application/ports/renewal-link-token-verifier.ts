/**
 * T048 (F8 Phase 2 Wave E) — `RenewalLinkTokenVerifier` Application port.
 *
 * HMAC verifier with R16 dual-key rotation support. Verifies first
 * against `RENEWAL_LINK_TOKEN_SECRET_PRIMARY`; on signature mismatch
 * AND `_FALLBACK` is configured, retries against the fallback key.
 * Returns a typed error union so the use-case can distinguish:
 *   - replay (token previously consumed)
 *   - cross-tenant (token's tid != request tenant)
 *   - expired (exp ≤ now)
 *   - tamper (HMAC mismatch under both keys)
 *   - malformed (parse failure)
 *
 * Replay protection: caller hashes the verified token bytes via the
 * `tokenSha256` returned and consults `consumed_link_tokens` —
 * separate concern from the verifier itself.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { RenewalLinkTokenPayload } from '../../domain/renewal-link-token';

export interface VerifiedRenewalLinkToken {
  readonly payload: RenewalLinkTokenPayload;
  readonly tokenSha256: Uint8Array;
  /** Which key matched: useful for the audit trail during rotation. */
  readonly verifiedWith: 'primary' | 'fallback';
}

export type VerifyTokenError =
  | { readonly kind: 'malformed_token' }
  | { readonly kind: 'signature_mismatch' }
  | { readonly kind: 'wrong_version'; readonly raw: unknown }
  | {
      readonly kind: 'tenant_mismatch';
      readonly expectedTenantId: string;
      readonly tokenTenantId: string;
    }
  | { readonly kind: 'expired'; readonly expSec: number; readonly nowSec: number };

export interface VerifyTokenContext {
  readonly expectedTenantId: string;
  readonly now: Date;
}

export interface RenewalLinkTokenVerifier {
  verify(
    rawToken: string,
    ctx: VerifyTokenContext,
  ):
    | { readonly ok: true; readonly value: VerifiedRenewalLinkToken }
    | { readonly ok: false; readonly error: VerifyTokenError };
}
