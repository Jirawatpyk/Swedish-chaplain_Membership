/**
 * T141 — Re-export shim for the unsubscribe-token verify surface.
 *
 * This file re-exports the FULL `unsubscribeTokenSigner` (sign + verify)
 * plus `peekTokenTenantId` from `hmac-signer.ts`. Importing from
 * `./hmac-verifier` is therefore equivalent to importing from
 * `./hmac-signer` — kept as a separate file purely to mirror the
 * tasks.md T140 (signer) / T141 (verifier) split.
 *
 * Why one file owns both sides: timing-attack resistance requires the
 * HMAC compute helper to be shared between `sign()` and `verify()` so a
 * secret rotation atomically updates both code paths. Duplicating the
 * compute helper into a separate verifier module would risk drift on
 * secret derivation.
 */
export {
  unsubscribeTokenSigner,
  peekTokenTenantId,
} from './hmac-signer';
