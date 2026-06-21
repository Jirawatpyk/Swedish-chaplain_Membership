/**
 * Application port — F7 Resend-AUDIENCE contact derivation for the
 * member-erasure cascade (COMP-1 US3-C, GDPR Art. 17 / PDPA §33 sub-processor
 * propagation).
 *
 * In-tx read of the `(Resend audience, email)` pairs the member received
 * broadcasts in. Called inside `eraseMember`'s atomic scrub tx, BEFORE the
 * US2b delivery tombstone (`BroadcastsDeliveryTombstonePort`) redacts the
 * emails. By post-commit time the join keys are destroyed — the tombstone
 * redacts `broadcast_deliveries.recipient_email_lower` and
 * `recipient_member_id` is always NULL in production — so the pairs MUST be
 * captured while the emails are still live, to be handed to a later cascade
 * that removes the member's email from those Resend audiences.
 *
 * Cross-module note: `broadcast_deliveries` + `broadcasts` live in F7
 * (`broadcasts/infrastructure`). The adapter is the single allowed crossing
 * point for the F3 erasure use-case; the Application-layer caller depends only
 * on this port. The adapter forwards the SAME `tx` to F7's barrel
 * (`makeDrizzleBroadcastsRepo`) — zero broadcasts internals leak into members.
 * This file (members Application layer) imports ZERO F7 symbols — only the
 * `TenantTx` / `TenantSlug` infra-handle types (the documented cross-module-
 * atomicity leak, same as `BroadcastsDeliveryTombstonePort.tombstoneDeliveriesInTx`).
 *
 * Tx semantics: the caller passes its OWN `runInTenant` tx (the atomic
 * members-scrub tx). The repo method runs a plain SELECT on that tx (role
 * `chamber_app`, RLS-bound) — this is a READ, no GUC, no nested transaction. A
 * throw rolls the WHOLE atomic tx back (the caller's existing error handling
 * covers it).
 *
 * NB: distinct name (`SubprocessorAudienceContact`) from the broadcasts
 * gateway's `AudienceContact` — they are unrelated shapes.
 */
import type { TenantTx } from '@/lib/db';
import type { TenantSlug } from '@/modules/tenants';

export interface SubprocessorAudienceContact {
  readonly audienceId: string;
  readonly email: string;
}

export interface BroadcastsAudienceDerivationPort {
  /**
   * Read the `(resend_audience_id, recipient_email_lower)` pairs the erased
   * member received broadcasts in, matched by `emails` (the member's
   * LIVE-contact emails — deliveries are only ever addressed to contact
   * emails). Emails are lower-cased + de-duped inside the repo before matching;
   * only audience-bearing broadcasts (`resend_audience_id IS NOT NULL`) yield a
   * pair; pairs are DISTINCT. An empty email set short-circuits to `[]`.
   *
   * Runs on the caller-provided `tx` (the atomic members-scrub tx) so it reads
   * the LIVE emails BEFORE the same tx's delivery tombstone redacts them.
   * FAIL-LOUD — a DB error propagates and rolls the caller's tx back.
   *
   * @param tenantSlug — the erasure tenant (a branded `TenantSlug`, threaded
   *   from `deps.tenant.slug`). The repo asserts the `tx` is bound to this
   *   tenant (`app.current_tenant`) before reading. Carrying the brand here lets
   *   the adapter forward it to the repo (which also takes a `TenantSlug`) with
   *   no `asTenantSlug` re-brand.
   */
  listMemberAudienceContactsInTx(
    tx: TenantTx,
    tenantSlug: TenantSlug,
    emails: readonly string[],
  ): Promise<ReadonlyArray<SubprocessorAudienceContact>>;
}
