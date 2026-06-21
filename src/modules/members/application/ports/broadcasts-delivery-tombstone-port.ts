/**
 * Application port — F7 broadcast-DELIVERY tombstone for the member-erasure
 * cascade (COMP-1 US2b, GDPR Art. 17 / PDPA §33).
 *
 * Tombstones every `broadcast_deliveries` row the erased member RECEIVED:
 * `recipient_member_id` → NULL, `recipient_email_lower` →
 * `erased+<delivery_id>@erased.invalid`, `error_message` → NULL (raw Resend
 * bounce diagnostics can embed the recipient email). Rows are RETAINED
 * (never deleted) for record-of-processing (PDPA §39 / GDPR Art. 30).
 *
 * RE-DRIVE-STABILITY (the 2026-06-18 2nd /code-review HIGH fix): this runs
 * INSIDE `eraseMember`'s atomic members-scrub tx — while the member's emails
 * are still LIVE — so it co-commits with `erased_at`. The OLD design ran the
 * tombstone in the POST-COMMIT F7 content-scrub cascade, keyed on the
 * member's email set which `eraseMember` rebuilt from LIVE sources. On a
 * RE-DRIVE (reconciler / manual, after a first-pass content-scrub failure)
 * the contacts were already `removed_at`-stamped, so the email set was empty
 * → the post-commit tombstone matched 0 rows, yet the content scrub (keyed on
 * `requested_by_member_id`) still succeeded → `member_erased` was emitted
 * while the delivery's plaintext `recipient_email_lower` + email-bearing
 * `error_message` survived forever. Moving the tombstone INTO the atomic tx
 * removes the "erased but deliveries not tombstoned" window: a first-pass
 * post-commit content-scrub failure can no longer roll the tombstone back,
 * and a re-drive (live emails gone) never needs to re-find them.
 *
 * Cross-module note: `broadcast_deliveries` lives in F7
 * (`broadcasts/infrastructure`). The adapter is the single allowed crossing
 * point for the F3 erasure use-case; the Application-layer caller depends only
 * on this port. The adapter calls F7's barrel + the existing
 * `tombstoneDeliveriesForMemberInTx` repo method, forwarding the SAME `tx`.
 * This file (members Application layer) imports ZERO F7 symbols — only the
 * `TenantTx` infra-handle type (the documented cross-module-atomicity leak,
 * same as `SessionRevocationPort.revokeAllForInTx`).
 *
 * Tx semantics: the caller passes its OWN `runInTenant` tx (the atomic
 * members-scrub tx). The repo method runs a plain GUC-gated UPDATE on that tx
 * (role `chamber_app`, RLS-bound, migration 0225 GUC arm) — no nested
 * transaction, no `ALTER TABLE … DISABLE TRIGGER`. A throw rolls the WHOLE
 * atomic tx back (the caller's existing error handling covers it) — this port
 * is NOT best-effort; it is part of the atomic erasure.
 */
import type { TenantTx } from '@/lib/db';
import type { TenantSlug } from '@/modules/tenants';

export interface BroadcastsDeliveryTombstonePort {
  /**
   * Tombstone every `broadcast_deliveries` row whose `recipient_email_lower`
   * is one of `recipientEmails` (the erased member's LIVE-contact emails —
   * deliveries are only ever addressed to contact emails, so the login axis
   * adds zero coverage and a cross-member over-tombstone risk). Emails are
   * lower-cased inside the repo before matching. An empty set short-circuits
   * to `{ tombstonedCount: 0 }`.
   *
   * Runs on the caller-provided `tx` (the atomic members-scrub tx) so it
   * co-commits with `erased_at`. FAIL-LOUD — a DB error propagates and rolls
   * the caller's tx back.
   *
   * @param tenantSlug — the erasure tenant (a branded `TenantSlug`, threaded
   *   from `deps.tenant.slug` which is already validated). The repo asserts
   *   the `tx` is bound to this tenant (`app.current_tenant`) before mutating.
   *   Carrying the brand here (rather than a raw `string`) lets the caller pass
   *   `deps.tenant.slug` end-to-end with no re-validation, and the adapter
   *   forward it to the repo (which also takes a `TenantSlug`) with no
   *   `asTenantSlug` re-brand.
   */
  tombstoneDeliveriesInTx(
    tx: TenantTx,
    tenantSlug: TenantSlug,
    recipientEmails: readonly string[],
  ): Promise<{ readonly tombstonedCount: number }>;

  /**
   * COMP-1 FIX-9 — element-wise redact the erased member's email out of OTHER
   * authors' `broadcasts.custom_recipient_emails` tenant-wide (the author-scrub,
   * keyed on `requested_by_member_id`, handles the member's OWN rows; the erased
   * member's email sitting in a SIBLING author's custom recipient list is never
   * reached by it and would survive as plaintext PII — the SAME bug-class as the
   * delivery tombstone: the recipient-PII erasure axis in F7 is EMAIL, not author
   * id).
   *
   * Keyed on EMAIL (case-insensitive). The caller passes the erased member's
   * LIVE-contact emails ONLY (the cross-member over-redaction guard — a removed
   * contact's address is ambiguously owned). ELEMENT-WISE (not whole-array) so a
   * sibling author's OTHER legitimate recipients are preserved.
   *
   * Same atomic-tx / FAIL-LOUD contract as `tombstoneDeliveriesInTx`: runs on
   * the caller-provided `tx` (the atomic members-scrub tx) so it co-commits with
   * `erased_at`; the repo sets the GUC and a throw rolls the caller's tx back.
   */
  redactCustomRecipientEmailsInTx(
    tx: TenantTx,
    tenantSlug: TenantSlug,
    recipientEmails: readonly string[],
  ): Promise<{ readonly redactedCount: number }>;
}
