/**
 * T043 — `verifyWebhookSignature` use-case (F6 Application).
 *
 * Thin wrapper around the `WebhookSignatureVerifier` port. The actual
 * HMAC + skew + grace-window logic lives in
 * `crypto-webhook-signature-verifier.ts` (T044) so the Application
 * layer can swap implementations at test time via dependency injection.
 *
 * Spec authority:
 *   - research.md R2 (HMAC scheme + 5-min skew + grace key + E8 length guard)
 *   - FR-002 + FR-003 + FR-008
 *   - contracts/webhook-eventcreate-api.md § Signature computation
 *
 * Generic-rejection invariant: ALL failure paths produce a `VerifyFailure`
 * outcome with discriminator `kind`. The HTTP layer maps every failure
 * kind to the SAME 401 generic body (no oracle). The discriminator is
 * forwarded to the audit log for forensic use only.
 *
 * Pure Application — no framework imports. The verifier is INJECTED so
 * unit tests can plug in a deterministic stub. Production composition
 * binds `cryptoWebhookSignatureVerifier` at the route layer (T052).
 */
import type {
  WebhookSignatureVerifier,
  VerifyInput,
  VerifyOutcome,
} from '../ports/webhook-signature-verifier';

export type VerifyWebhookSignatureInput = Omit<VerifyInput, never> & {
  /**
   * Verifier port instance. Production uses
   * `cryptoWebhookSignatureVerifier`; tests use a stub.
   */
  readonly verifier: WebhookSignatureVerifier;
};

/**
 * Verify a webhook delivery's signature + timestamp envelope.
 *
 * Returns `Result.ok` always — the outcome's `verified` boolean carries
 * the success/fail decision. This matches the project's "Application
 * layer NEVER throws" convention (Constitution Principle VIII) — the
 * caller branches on `outcome.verified`.
 */
export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): VerifyOutcome {
  const { verifier, ...rest } = input;
  return verifier.verify(rest);
}
