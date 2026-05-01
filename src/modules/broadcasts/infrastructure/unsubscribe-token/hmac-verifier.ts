/**
 * T141 — HMAC unsubscribe-token verifier (F7 US4).
 *
 * Re-export of the verify side of `unsubscribeTokenSigner` from
 * `hmac-signer.ts`. The signer + verifier share the same module-private
 * `hmac()` helper so a key rotation MUST update both at once
 * (single source of truth on `env.broadcasts.unsubscribeTokenSecret`).
 *
 * Kept as a separate file to mirror tasks.md T140 (signer) + T141
 * (verifier) split. The actual verify logic lives in `hmac-signer.ts`
 * because timing-attack resistance requires the HMAC compute helper to
 * be shared with sign(); duplicating it would risk the verifier and
 * signer drifting on secret-derivation.
 */
export {
  unsubscribeTokenSigner,
  peekTokenTenantId,
} from './hmac-signer';
