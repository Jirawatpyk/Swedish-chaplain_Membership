/**
 * Application port — sub-processor erasure propagation for the member-erasure
 * cascade (COMP-1 US3-C, GDPR Art. 17 / PDPA §33).
 *
 * Post-commit best-effort step: after `eraseMember`'s atomic scrub tx commits,
 * the cascade hands the `(audience, email)` pairs captured pre-redaction
 * (Task 3 `BroadcastsAudienceDerivationPort`) to this port, which propagates
 * the erasure to external sub-processors so the member's PII is removed from
 * their systems too:
 *
 *   - Resend  — remove the member's email from every audience it received
 *               broadcasts in (so a future broadcast never re-reaches an
 *               erased member).
 *   - Stripe  — a PURE no-op TODAY. There is no member↔Stripe-customer model
 *               in Chamber-OS (F5 payments are ad-hoc Payment Intents, never
 *               persisted Stripe Customers keyed to a member). `stripeOutcome`
 *               is typed as the literal `'ok'` so a future customer-erasure
 *               path widens it EXPLICITLY (a new union member) rather than
 *               silently passing through. ZERO payments symbols are imported.
 *
 * Best-effort — the port contract is NEVER-THROWS (mirrors the F6/F7/F8
 * cascade ports). A sub-processor outage must not fail the member-erasure
 * flow: the member's OWN-system PII is already durably scrubbed by the atomic
 * tx; sub-processor propagation is a follow-up the US2d reconciler / US3-E
 * DPO runbook re-drives on a `partial`/`failed` outcome.
 */

import type { SubprocessorAudienceContact } from './broadcasts-audience-derivation-port';

export type SubprocessorResendOutcome = 'ok' | 'partial' | 'failed';

/**
 * Stripe is a pure no-op TODAY (no member↔customer model). Typed as a literal
 * so a future customer-erasure path widens it explicitly.
 *
 * Deliberately FLAT (not a discriminated union on `resendOutcome`): the sole
 * consumer (`eraseMember`'s post-commit cascade) reads ALL fields unconditionally
 * for the `subprocessor_erasure_propagated` audit payload + the metric, so a union
 * would force a needless switch with no field-presence safety gained. The
 * coherence invariant (`'ok'⇔failed===0`, `'failed'⇔removed===0 && failed>0`,
 * `'partial'⇔both>0`) is enforced at the SINGLE producer — the adapter derives all
 * three fields together from the loop counts; the shape is never hand-assembled
 * elsewhere.
 */
export interface SubprocessorErasureResult {
  readonly resendOutcome: SubprocessorResendOutcome;
  readonly resendContactsRemoved: number;
  /**
   * Round 2 R2-25 — calls the processor acknowledged where the contact was
   * ALREADY absent (404). A success, but NOT a removal. Kept apart because
   * `resendContactsRemoved` reaches an Art. 30 record and a DSR answer.
   */
  readonly resendContactsAlreadyAbsent: number;
  readonly resendContactsFailed: number;
  readonly stripeOutcome: 'ok';
}

/**
 * The `subprocessor_erasure_propagated` F3 audit payload — ids + outcomes ONLY,
 * NEVER erased PII. Typed (the F3 `AuditPort` takes a freeform `Record`) so a key
 * typo or a value-type drift in this GDPR-evidence emit fails at COMPILE time,
 * not only in the integration assertion. (The module-wide F3-AuditPort typed-emit
 * parity with F7 stays a separate backlog — this is the one erasure-evidence
 * payload worth pinning now; applied via `satisfies` at the emit site so the
 * literal stays assignable to the port's `Record<string, unknown>`.)
 */
export interface SubprocessorErasurePropagatedAudit {
  readonly member_id: string;
  readonly reason: string;
  readonly resend_outcome: SubprocessorResendOutcome;
  readonly resend_contacts_removed_count: number;
  /** R2-25 — see `resendContactsAlreadyAbsent`. */
  readonly resend_contacts_already_absent_count: number;
  readonly resend_contacts_failed_count: number;
  readonly stripe_outcome: 'ok';
}

export interface SubprocessorErasureInput {
  readonly memberId: string;
  readonly reason: string;
  /** (audience, email) pairs captured in the atomic scrub tx (pre-redaction) —
   *  reuses the producer type from `BroadcastsAudienceDerivationPort` so the
   *  producer→consumer contract is explicit (no silent shape divergence). */
  readonly audienceContacts: ReadonlyArray<SubprocessorAudienceContact>;
  readonly tenantSlug: string;
  readonly requestId: string;
}

/** Best-effort — NEVER throws (mirrors the F6/F7 cascade ports). */
export interface SubprocessorErasurePort {
  propagate(input: SubprocessorErasureInput): Promise<SubprocessorErasureResult>;
}
