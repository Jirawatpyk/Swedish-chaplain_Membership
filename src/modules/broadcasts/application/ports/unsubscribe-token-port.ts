/**
 * T028 — `UnsubscribeTokenPort` Application port (F7).
 *
 * One-click unsubscribe token signing + verification (FR-029–FR-032).
 * HMAC-SHA256 over `(tenant_id, broadcast_id, email_lower [, lang])`
 * using `UNSUBSCRIBE_TOKEN_SECRET` (≥32 bytes, distinct from
 * `AUTH_COOKIE_SIGNING_SECRET` per research.md § 4).
 *
 * Token format: `v1.<base64url-payload>.<base64url-mac>`
 *   - v1: scheme version for forward-compat key rotation
 *   - payload: JSON `{tenantId, broadcastId, emailLower, lang?}`
 *     base64url-encoded
 *   - mac: HMAC-SHA256(secret, payload) base64url-encoded
 *
 * Tokens are valid forever per FR-030 idempotency — replays are safe
 * (idempotent upsert at the suppression repo). Compromise of the
 * secret is recovered via key rotation; the token format carries the
 * version prefix so old tokens remain verifiable until purged.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { EmailLower } from '../../domain/value-objects/email-lower';

export interface UnsubscribeTokenPayload {
  readonly tenantId: TenantSlug;
  readonly broadcastId: BroadcastId;
  readonly emailLower: EmailLower;
  readonly lang?: 'en' | 'th' | 'sv';
}

/**
 * Discrete reasons for `token.invalid_payload` errors. Kept as a literal
 * union so the route handler's switch is exhaustive and audit-payload
 * cardinality is bounded (no caller-supplied free-form strings). Only
 * reasons actually emitted by the signer appear here; structural-parse
 * failures (b64-decode, JSON-parse, non-object) collapse into `not_json`
 * via the shared `parsePayloadSegment` helper.
 */
export type TokenInvalidPayloadReason =
  | 'not_json'
  | 'bad_version'
  | 'missing_tid'
  | 'missing_bid'
  | 'missing_eml'
  | 'bad_lang';

export type TokenVerifyError =
  | { readonly kind: 'token.malformed'; readonly raw: string }
  | { readonly kind: 'token.unsupported_version'; readonly version: string }
  | { readonly kind: 'token.bad_signature' }
  | {
      readonly kind: 'token.invalid_payload';
      readonly reason: TokenInvalidPayloadReason;
    };

export interface UnsubscribeTokenPort {
  /**
   * Sign an unsubscribe token. The returned string is safe to embed
   * in a URL (`/unsubscribe/[token]`) — it is base64url-encoded with
   * no character that requires URL-encoding.
   */
  sign(payload: UnsubscribeTokenPayload): string;

  /**
   * Verify an unsubscribe token. Returns the parsed payload on success
   * (caller proceeds with suppression upsert + audit emit). Returns
   * a discriminated error for clean 4xx routing.
   */
  verify(token: string): Result<UnsubscribeTokenPayload, TokenVerifyError>;
}
