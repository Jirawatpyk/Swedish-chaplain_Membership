/**
 * T018 — `WebhookOutcome` + `ProcessingOutcome` value objects (F6).
 *
 * Discriminated unions modelling the webhook receipt outcome (used in
 * audit-event payloads) and the processing-outcome sub-state when the
 * receipt was successfully verified.
 *
 * Source of truth: data-model.md § 3.4 + § 5 + contracts/audit-port.md § 1.
 *
 * Pure TypeScript — Constitution Principle III.
 */

/**
 * `ProcessingOutcome` discriminator. Used inside `WebhookOutcome` kind
 * `'verified'` and as the `processing_outcome` label on
 * `eventcreate_webhook_receipts_total` OTel counter (FR-036).
 */
export const PROCESSING_OUTCOMES = [
  'matched_member_contact',
  'matched_member_domain',
  'matched_member_fuzzy',
  'non_member',
  'unmatched',
] as const;

export type ProcessingOutcome = (typeof PROCESSING_OUTCOMES)[number];

export function isProcessingOutcome(
  value: unknown,
): value is ProcessingOutcome {
  return (
    typeof value === 'string' &&
    (PROCESSING_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * `WebhookOutcome` discriminated union — every observable terminal state
 * of a single webhook delivery. The `kind` field maps 1:1 to an audit
 * event type (e.g., `'signature_rejected'` → `webhook_signature_rejected`).
 *
 * `'grace_used'` is emitted in ADDITION to the success kind (i.e., a
 * successful delivery verified against the grace secret would emit both
 * `{kind:'verified'}` and `{kind:'grace_used'}` audit events) — see
 * contracts/audit-port.md § 1.
 */
export type WebhookOutcome =
  | { readonly kind: 'verified'; readonly processingOutcome: ProcessingOutcome }
  | { readonly kind: 'signature_rejected' }
  | { readonly kind: 'replay_rejected'; readonly skewSeconds: number }
  | { readonly kind: 'duplicate_rejected'; readonly requestId: string }
  | {
      readonly kind: 'malformed_rejected';
      readonly errors: ReadonlyArray<{ path: string; message: string }>;
    }
  | { readonly kind: 'rolled_back'; readonly reason: string }
  | { readonly kind: 'grace_used' };

export type WebhookOutcomeKind = WebhookOutcome['kind'];
