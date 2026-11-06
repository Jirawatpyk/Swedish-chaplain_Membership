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

/**
 * Two outcomes for a capture that was empty because every address the member
 * held was already a scrub sentinel (the scrub ran in an earlier pass, so this
 * pass could not know the real address). Never `ok`: an `ok` 0/0/0 row means
 * the member was in no audience.
 *   - `not_attempted` (spec 140 s3 review round 2, R2-A): no earlier
 *     `subprocessor_erasure_propagated` row for the member in this tenant. The
 *     first pass's detach may never have run, so it is treated like `failed`:
 *     designated to page, and shown on the erasure-log evidence card, which is
 *     the operative control while no alert backend is wired (runbook
 *     `member-erasure.md`).
 *   - `already_propagated` (R2-A2): an earlier row exists, and that row is the
 *     outcome; this one is a re-drive's echo of it and does not page. The row
 *     is still written (DT6's rotation keys on its timestamp).
 */
export type SubprocessorResendOutcome =
  | 'ok'
  | 'partial'
  | 'failed'
  | 'not_attempted'
  | 'already_propagated';

/**
 * Stripe is a pure no-op TODAY (no member↔customer model). Typed as a literal
 * so a future customer-erasure path widens it explicitly.
 *
 * Deliberately FLAT (not a discriminated union on `resendOutcome`): the sole
 * consumer (`eraseMember`'s post-commit cascade) reads ALL fields unconditionally
 * for the `subprocessor_erasure_propagated` audit payload + the metric, so a union
 * would force a needless switch with no field-presence safety gained. The
 * coherence invariant (`'ok'⇔failed===0`, `'failed'⇔removed===0 && failed>0`,
 * `'partial'⇔both>0`, `'not_attempted'⇔no pair && addressesAlreadyScrubbed &&
 * !priorPropagationRecorded`, `'already_propagated'⇔no pair &&
 * addressesAlreadyScrubbed && priorPropagationRecorded`, both with all counts 0)
 * is enforced at the SINGLE producer — the adapter derives all fields together
 * from the loop counts and these two flags; the shape is never hand-assembled
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
  /**
   * PR #756 review round 1 (pdpa M-1) — which Resend detach wire wrote the
   * counts. `'segments'` (`DELETE /contacts/{email}/segments/{id}`, spec 140 s4)
   * answers 200 only for a membership that existed and 404 otherwise, so its
   * "already absent" is Resend's own answer. A row WITHOUT the key predates s4:
   * the old `/audiences` wire answered 200 for an address no longer in the
   * audience (an address Resend never held is not measured), and the evidence
   * card explains those counts differently. Every row written now carries it.
   */
  readonly resend_detach_wire: 'segments';
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
  /**
   * Spec 140 s3 review round 2 (R2-A) — true when the member held addresses and
   * every one was already a scrub sentinel (`@erased.invalid`), i.e. an earlier
   * pass committed the scrub and this pass cannot know the real address. With
   * no pair the adapter then records `not_attempted`, not `ok`. Decided by the
   * use case (it alone sees the addresses); required so a new caller must say.
   */
  readonly addressesAlreadyScrubbed: boolean;
  /**
   * Spec 140 s3 review round 2 (R2-A2) — true when this tenant already holds a
   * `subprocessor_erasure_propagated` row for the member (read by the use case
   * only when `addressesAlreadyScrubbed`; false otherwise, and false when the
   * read failed, so a doubt pages). With no pair and the addresses already
   * scrubbed it turns `not_attempted` into `already_propagated`.
   */
  readonly priorPropagationRecorded: boolean;
  /**
   * Spec 140 s2a review round 1 (pdpa H-1) — the erasure cascade's deadline
   * (`erasureCascadeDeadline`, set by the erase route and `reconcile-erasures`
   * through `EraseMemberMeta.deadlineAt`). Before each pair the adapter stops
   * when less than one gateway request budget is left, and counts every pair it
   * did not try as failed, so the `subprocessor_erasure_propagated` row is
   * written inside `maxDuration` and is never a false `ok`. Absent: no bound
   * beyond the per-request one.
   */
  readonly deadlineAt?: Date;
}

/** Best-effort — NEVER throws (mirrors the F6/F7 cascade ports). */
export interface SubprocessorErasurePort {
  propagate(input: SubprocessorErasureInput): Promise<SubprocessorErasureResult>;
}
