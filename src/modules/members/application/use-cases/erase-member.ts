/**
 * `erase-member` use case (COMP-1 — GDPR Art. 17 / PDPA §33).
 *
 * Anonymises a member + its contacts IN PLACE (the FK web forbids hard-delete)
 * and re-drives the existing archive cascades with the erasure reason.
 *
 * Flow (design §6):
 *   1. emit `member_erasure_requested` durably (its own committed tx) — starts
 *      the Art. 12 one-month clock and survives a later scrub failure.
 *   2. ATOMIC tx (runInTenant): tombstone F7 broadcast deliveries + capture the
 *      sub-processor (Resend) audience pairs — both while the member's contact
 *      emails are still live — then scrub members + contacts (+ erased_at),
 *      invalidate email-change tokens, cancel pending outbox, and revoke
 *      sessions / soft-consume invitations for linked users.
 *   3. POST-COMMIT best-effort: cancel in-flight F7 broadcasts + F8 renewal
 *      cycles, erase F1 linked logins, scrub F7 broadcast CONTENT, hard-delete
 *      F6 event registrations, and propagate erasure to sub-processors (Resend
 *      audience-contact removal; Stripe no-op).
 *   4. emit `member_erased` ONLY when every cascade reports complete.
 *
 * Idempotent: re-running re-drives incomplete cascades; member_erased is the
 * completion proof. Per-module scrub of F1/F6/F7-content/F8 + the reconciler
 * are US2; the 10y tax-redaction cron is US3.
 */
import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { erasureMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsCascadePort } from '../ports/broadcasts-cascade-port';
import type { BroadcastsContentScrubPort } from '../ports/broadcasts-content-scrub-port';
import type { BroadcastsDeliveryTombstonePort } from '../ports/broadcasts-delivery-tombstone-port';
import type { RenewalsCascadePort } from '../ports/renewals-cascade-port';
import type { ClockPort } from '../ports/clock-port';
import type { InvitationCascadePort } from '../ports/invitation-cascade-port';
import type { SessionRevocationPort } from '../ports/session-revocation-port';
import type { UserErasurePort } from '../ports/user-erasure-port';
import type { EmailChangeTokenPort } from '../ports/email-change-token-port';
import type { UserEmailPort } from '../ports/user-email-port';
import type { OutboxCancelPort } from '../ports/outbox-cancel-port';
import type { EventRegistrationErasurePort } from '../ports/event-registration-erasure-port';
import type { BroadcastsAudienceDerivationPort } from '../ports/broadcasts-audience-derivation-port';
import type {
  SubprocessorErasurePort,
  SubprocessorErasurePropagatedAudit,
} from '../ports/subprocessor-erasure-port';

/**
 * COMP-1 US3-A — the Art.12 identity-verification METHOD (how identity was
 * confirmed), recorded for accountability (compliance H-1: not a bare boolean).
 * The admin route's stricter `eraseRouteSchema` reuses this SCHEMA as its
 * validation enum; the client dialog mirrors the `VerificationMethod` TYPE (it
 * keeps a client-local value list — the barrel can't be value-imported into the
 * client graph). Both anchor to this one definition so the enum never drifts.
 */
export const verificationMethodSchema = z.enum([
  'verified_account_login',
  'in_person',
  'email_confirmation_loop',
  'official_document',
]);
export type VerificationMethod = z.infer<typeof verificationMethodSchema>;

/**
 * COMP-1 US3-A — the erasure legal basis (GDPR Art.17 / PDPA §33), recorded in
 * the append-only `member_erasure_requested` DPO log. The single source of
 * truth for the reason enum — reused by `eraseMemberSchema` below, the admin
 * route's `eraseRouteSchema`, and (type-only) the dialog's `Reason` — so the
 * three never drift on the DPO-relevant legal-basis value.
 */
export const eraseReasonSchema = z.enum([
  'gdpr_erasure_request',
  'pdpa_deletion_request',
]);
export type EraseReason = z.infer<typeof eraseReasonSchema>;

export const eraseMemberSchema = z
  .object({
    reason: eraseReasonSchema,
    // COMP-1 US3-A — OPTIONAL Art.12 accountability fields. OPTIONAL in the
    // CORE schema so the US2d reconciler's `{ reason }`-only re-drive
    // (reconcile-erasures/route.ts) stays valid; REQUIRED at the admin-route
    // boundary (eraseRouteSchema), where the human attestation belongs. A
    // system re-drive does not re-attest.
    identityVerified: z.boolean().optional(),
    verificationMethod: verificationMethodSchema.optional(),
    note: z.string().max(500).nullish(),
  })
  .strict();

export type EraseMemberInput = z.infer<typeof eraseMemberSchema>;

export type EraseMemberError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'not_found' }
  | { type: 'server_error'; message: string };

export type EraseMemberResult = {
  readonly memberId: MemberId;
  readonly erasedAt: Date;
  /**
   * true ⇒ every cascade reported clean AND member_erased was emitted.
   * false ⇒ the scrub committed (row IS erased) but a cascade is pending —
   * the US2 reconciler will finish it. NEVER means 'not erased'.
   */
  readonly cascadesComplete: boolean;
};

export type EraseMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  contactRepo: ContactRepo;
  invitations: InvitationCascadePort;
  sessions: SessionRevocationPort;
  broadcastsCascade: BroadcastsCascadePort;
  renewalsCascade: RenewalsCascadePort;
  // F1 linked-login erasure (COMP-1 US2a). The dep slot + production wiring
  // land in Task 5; the post-commit cascade that consumes it is wired in Task 6.
  userErasure: UserErasurePort;
  // F7 broadcast CONTENT scrub (COMP-1 US2b). Redacts the PII the member
  // AUTHORED into F7 broadcasts. Consumed by the post-commit cascade below
  // (after the F1 user-erasure loop, before the member_erased completion
  // proof). The F7 use-case behind this port runs its OWN atomic tx (content +
  // audit co-commit), keyed on requested_by_member_id, so the cascade is
  // re-drive-safe by construction (a re-drive re-discovers + re-scrubs).
  broadcastsContentScrub: BroadcastsContentScrubPort;
  // F7 broadcast-DELIVERY tombstone (COMP-1 US2b). Tombstones every
  // `broadcast_deliveries` row the member RECEIVED (recipient_email_lower →
  // erased+<id>@erased.invalid, error_message → NULL). Consumed INSIDE the
  // atomic scrub tx below (while the member's emails are still live), co-
  // committing with `erased_at`. Moved here from the post-commit content
  // cascade (the 2026-06-18 2nd /code-review HIGH fix): a re-drive after a
  // first-pass content-scrub failure rebuilt the email set from already-
  // scrubbed (removed_at-stamped) contacts → [] → the post-commit tombstone
  // matched 0 rows while erasure reported complete, leaving the delivery's
  // plaintext recipient email + email-bearing error_message surviving forever.
  broadcastsDeliveryTombstone: BroadcastsDeliveryTombstonePort;
  // COMP-1 US2a (M1) — invalidate the erased member's linked users' active
  // email_change_tokens inside the scrub tx so a live 48h revert token (holding
  // the original email in plaintext) can never be redeemed to resurrect PII.
  tokens: EmailChangeTokenPort;
  // COMP-1 US2a (L1) — read the linked users' real login emails (pre-erasure)
  // to feed the outbox cancel below.
  userEmails: UserEmailPort;
  // COMP-1 US2a (L1) — cancel the erased subject's pending notifications_outbox
  // rows (to_email frozen = real address) so the dispatcher cannot email them
  // post-erasure.
  outboxCancel: OutboxCancelPort;
  // COMP-1 US2c — F6 event-registration fan-out erasure. Hard-deletes every F6
  // event registration matched to the erased member (each carries the
  // attendee's email / name / company), crediting back any consumed benefit
  // quota per registration. Consumed by the post-commit cascade below (order-
  // independent of the F1/F7/F8 cascades). The F6 fan-out keys on
  // `matched_member_id = member` (a member link NOT scrubbed by erasure) and
  // HARD-DELETES, so it is re-drive-stable by construction: a re-drive
  // re-discovers the surviving registrations (deleted ones are gone) and
  // completes the remainder. A `partial`/`failed` outcome (or a throw) flips
  // allCascadesClean=false → member_erased withheld → the US2d reconciler
  // re-drives.
  eventRegistrationErasure: EventRegistrationErasurePort;
  // COMP-1 US3-C — sub-processor erasure propagation (GDPR Art.17 / PDPA §33).
  // `broadcastsAudienceDerivation` reads the member's (Resend audience, email)
  // pairs INSIDE the atomic scrub tx (FAIL-LOUD), while the emails are still
  // live; `subprocessorErasure` removes those pairs from Resend post-commit
  // (best-effort / NON-BLOCKING — see the M-1 asymmetry note at the capture
  // site + the post-commit cascade). The capture must precede the US2b delivery
  // tombstone, which redacts `recipient_email_lower` (the join key).
  broadcastsAudienceDerivation: BroadcastsAudienceDerivationPort;
  subprocessorErasure: SubprocessorErasurePort;
  audit: AuditPort;
  clock: ClockPort;
};

export type EraseMemberMeta = { actorUserId: string; requestId: string };

class EraseNotFoundError extends Error {
  constructor() {
    super('not_found');
  }
}

export async function eraseMember(
  memberId: MemberId,
  input: unknown,
  meta: EraseMemberMeta,
  deps: EraseMemberDeps,
): Promise<Result<EraseMemberResult, EraseMemberError>> {
  const parsed = eraseMemberSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const reason = parsed.data.reason;
  const now = deps.clock.now();

  // 0. PRE-FLIGHT existence + state read (BEFORE the requested-audit emit).
  //    `erased_at` is NOT carried on the Member aggregate, so resolve it via the
  //    narrow `findErasedAtById` read (mirrors `findRiskById`).
  //    - not_found ⇒ bogus / cross-tenant id: short-circuit with `not_found`
  //      emitting NO audit. Without this, the durable `member_erasure_requested`
  //      emit below would write a clock-start for a non-existent subject —
  //      polluting the append-only DPO log and acting as a cross-tenant
  //      member-existence oracle. (LOW finding.)
  //    - already erased (erased_at set) ⇒ a re-drive (idempotent scrub / US2
  //      reconciler): SKIP the requested emit so we do NOT re-log the request and
  //      conceptually restart the Art.12 one-month clock on every pass. (M2.)
  //    The scrub tx's findByIdInTx (FOR UPDATE) below STILL re-checks existence —
  //    it guards the TOCTOU window between this read and the tx.
  const preflight = await deps.memberRepo.findErasedAtById(deps.tenant, memberId);
  if (!preflight.ok) {
    if (preflight.error.code === 'repo.not_found')
      return err({ type: 'not_found' });
    logger.error(
      { err: preflight.error, memberId, requestId: meta.requestId },
      'erase-member: pre-flight existence read failed',
    );
    return err({ type: 'server_error', message: 'erase pre-flight read failed' });
  }
  const alreadyErased = preflight.value.erasedAt !== null;

  // 1. Durable request audit — its OWN committed tx so the DPO log records the
  //    request even if the scrub below fails (Art. 12 clock start). Emitted ONLY
  //    on a FIRST request (member exists + not yet erased); a re-drive over an
  //    already-erased member skips this so the Art.12 clock is not restarted.
  //
  // L2 (known, ACCEPTED, benign edge — NOT an oversight): the pre-flight
  // `findErasedAtById` above runs in its OWN tx, separate from this
  // requested-audit tx. So two CONCURRENT first-erasure requests for the same
  // member can both read `alreadyErased=false` and both emit a durable
  // `member_erasure_requested` (double-starting the Art.12 one-month clock in
  // the append-only DPO log). We DELIBERATELY do not lock here:
  //   - it is benign — the log is append-only (no corruption), the scrub below
  //     serializes via `findByIdInTx FOR UPDATE` (no double-scrub), and a
  //     duplicate `requested` row only means the earliest timestamp wins the
  //     Art.12 clock (the conservative direction);
  //   - erasure is admin-initiated at ~0-2/year, so two concurrent FIRST
  //     requests for the SAME member are vanishingly rare;
  //   - a lock would be disproportionate and would complicate the
  //     durable-requested-before-scrub ordering this design depends on.
  if (!alreadyErased) {
    try {
      await runInTenant(deps.tenant, async (tx) => {
        const requested = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'member_erasure_requested',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `member_erasure_requested ${memberId}`,
          payload: {
            member_id: memberId,
            reason,
            // COMP-1 US3-A — Art.12 accountability record, present ONLY on the
            // originating admin request (the route requires these fields). A
            // US2d reconciler re-drive sends `{ reason }` only AND, being a
            // re-drive over an already-erased member, never reaches this emit —
            // so the attestation is recorded exactly once. Append-only DPO log.
            ...(parsed.data.identityVerified !== undefined
              ? { identity_verified: parsed.data.identityVerified }
              : {}),
            ...(parsed.data.verificationMethod !== undefined
              ? { verification_method: parsed.data.verificationMethod }
              : {}),
            ...(parsed.data.note != null ? { note: parsed.data.note } : {}),
          },
        });
        if (!requested.ok)
          throw new Error('audit_failed', {
            cause: 'cause' in requested.error ? requested.error.cause : undefined,
          });
      });
    } catch (e) {
      logger.error(
        { err: e, memberId, requestId: meta.requestId },
        'erase-member: requested-audit failed',
      );
      return err({ type: 'server_error', message: 'erase request audit failed' });
    }
  }

  // 2. ATOMIC scrub tx — members + contacts (+ linked-user cascade, below).
  //    M1: cascade counts captured inside the tx, surfaced to outer scope for
  //    the post-commit `member_erased` payload (DPO-log observability).
  let sessionsRevokedTotal = 0;
  let invitationsRevokedCount = 0;
  // US2a: the F1 linked-login ERASURE work-list, read INSIDE the scrub tx and
  // surfaced to the post-commit F1 user-erasure cascade. Sourced from the
  // UNFILTERED listAllLinkedUserIdsForMemberInTx (NOT the filtered
  // listLinkedUserIdsForMemberInTx the session/invitation cascade uses) so it
  // survives the contacts removed_at scrub: on a US2d reconciler RE-DRIVE the
  // contacts are already removed_at-stamped, and a filtered read would yield []
  // → the F1 loop would silently skip a login that FAILED to erase on a prior
  // pass while member_erased was emitted as "complete" (Art.17 credential
  // survival — the Critical Task-6 review finding). The unfiltered read is
  // re-drive-stable (linked_user_id is preserved on the removed contact row),
  // which ALSO neutralises the within-pass I-1 hazard as belt-and-suspenders.
  let linkedUserIdsForErasure: readonly string[] = [];
  // US2b: the count of `broadcast_deliveries` rows tombstoned INSIDE the
  // atomic scrub tx below (while the member's contact emails are still live).
  // Surfaced to the post-commit F7 content-scrub cascade so the single
  // `broadcast_content_redacted` audit records BOTH the content-scrub count
  // and this delivery-tombstone count. The tombstone runs in the atomic tx
  // (co-committing with `erased_at`) — NOT post-commit — so a first-pass
  // content-scrub failure can never leave deliveries un-tombstoned and a
  // re-drive (live emails already scrubbed) doesn't need to re-find them
  // (the 2026-06-18 2nd /code-review HIGH fix).
  let tombstonedDeliveriesCount = 0;
  // COMP-1 US3-C — the (Resend audience, email) pairs the member received
  // broadcasts in, captured INSIDE the atomic scrub tx below (FAIL-LOUD) while
  // the emails are still live. Surfaced to the post-commit sub-processor cascade
  // (it cannot be re-derived once the delivery tombstone redacts the emails).
  let capturedSubprocessorPairs: ReadonlyArray<{
    readonly audienceId: string;
    readonly email: string;
  }> = [];
  try {
    await runInTenant(deps.tenant, async (tx) => {
      // findByIdInTx takes a SELECT … FOR UPDATE row lock (mirrors
      // archive-member.ts) — keep it so a concurrent plan-change /
      // inline-edit cannot clobber the row between this read and the scrub.
      const current = await deps.memberRepo.findByIdInTx(tx, memberId);
      if (!current.ok) {
        if (current.error.code === 'repo.not_found')
          throw new EraseNotFoundError();
        // Preserve the repo `cause` (SQLSTATE + Postgres message, present on the
        // `repo.unexpected` variant) so the outer `catch (e)` logs the DB detail,
        // not just the bare code string. (ES2022 Error cause; forensics-only —
        // the operation still fails + rolls back identically.)
        throw new Error(`lookup_failed:${current.error.code}`, {
          cause: 'cause' in current.error ? current.error.cause : undefined,
        });
      }

      // Read linked users FIRST — the contacts scrub below sets removed_at on
      // every contact, and listLinkedUserIdsForMemberInTx filters
      // removed_at IS NULL, so reading after the scrub would yield an empty
      // list and silently skip the session/invitation revocation (the Art.17
      // cascade). Stays in the SAME atomic tx as the scrubs, so this is still
      // a consistent "linked at erasure time" snapshot. (Bug I-1, 2026-06-16.)
      // Dedupe so the same user linked to two contacts yields exactly one
      // user_sessions_revoked audit (mirrors archive-member.ts). This FILTERED
      // set drives the in-tx session/invitation cascade only.
      const linkedUserIds = await deps.contactRepo.listLinkedUserIdsForMemberInTx(tx, memberId);
      const uniqueLinkedUserIds = Array.from(new Set(linkedUserIds));

      // F1 linked-login erasure work-list — a SEPARATE, UNFILTERED read so it
      // survives the contacts removed_at scrub and a re-drive re-attempts a
      // previously-failed login (Critical US2a fix; see the
      // `linkedUserIdsForErasure` declaration above). Deduped independently — a
      // member could have two REMOVED contacts pointing at the same login, so
      // the unfiltered set may contain duplicates the filtered set does not.
      const allLinkedUserIds = await deps.contactRepo.listAllLinkedUserIdsForMemberInTx(tx, memberId);
      linkedUserIdsForErasure = Array.from(new Set(allLinkedUserIds));

      // COMP-1 US2a (L1) — capture the member's REAL contact emails BEFORE the
      // scrub below sentinel-izes them. These are the frozen `to_email` values
      // of pending notifications_outbox rows (member_invitation /
      // email_verification to the contact's address) the erasure must cancel.
      // FAIL-LOUD read (throws → tx rollback). Captured here; the outbox cancel
      // runs after the scrubs (the outbox rows are independent of contact rows).
      //
      // LIVE contacts ONLY (`removed_at IS NULL`). A removed contact's email is
      // AMBIGUOUSLY OWNED: the `contacts_tenant_email_uniq` index is partial
      // (`WHERE removed_at IS NULL`), so a DIFFERENT member's LIVE contact can
      // hold the same address. Cancelling on it would `DELETE … WHERE
      // to_email=X` and silently delete that peer member's legitimate pending
      // mail (the COMP-1 US2a cross-member over-delete). Only LIVE-contact
      // emails are unambiguously this member's right now. The unfiltered
      // `listEmailsForMemberInTx` is correct for the USER-keyed work-lists
      // (no email collision), but NOT for this address-keyed cancel-set.
      // Residual (accepted, documented): a pending row enqueued to an
      // ALREADY-removed contact's email — if not also a live-login/token
      // email — is no longer cancelled; that is the safer failure mode (a
      // possible post-erasure mail to an address this member once used) than
      // deleting a peer member's mail.
      const contactEmailsForCancel =
        await deps.contactRepo.listLiveEmailsForMemberInTx(tx, memberId);

      // COMP-1 FIX-3 — the email set for the EMAIL-KEYED REDACTION ops (delivery
      // tombstone + Resend audience derivation + cross-author custom-recipient
      // redaction). UNLIKE `contactEmailsForCancel` (live-only, the address-
      // keyed OUTBOX cancel), this is ALL of the member's contact emails (ANY
      // removed_at) MINUS any email a PEER member still holds LIVE:
      //   - INCLUDE pre-archived contacts — their identity row IS scrubbed by
      //     the contacts scrub below, so their historical recipient PII (the
      //     delivery's recipient_email_lower, the Resend audience membership, a
      //     sibling author's custom-recipient entry) must be redacted too, or it
      //     survives in plaintext (the FIX-3 gap — live-only missed it).
      //   - EXCLUDE a peer member's live-claimed email — the partial
      //     contacts_tenant_email_uniq index (WHERE removed_at IS NULL) permits
      //     an email X to be both (this member, REMOVED contact) AND (peer
      //     member, LIVE contact). Redacting on X would tombstone the PEER's
      //     live delivery AND drive the post-commit Resend removal on X →
      //     unsubscribe the peer (cross-member data loss). For that collision we
      //     leave the erased member's own datum (accepted safer-failure residual,
      //     same as the live-only outbox guard).
      // FAIL-LOUD (throw → tx rollback). Read while the emails are still live —
      // the redactions below all key on it.
      const tombstoneEmails =
        await deps.contactRepo.listTombstoneEmailsForMemberInTx(tx, memberId);

      // COMP-1 US3-C — capture the (Resend audience, email) pairs the member
      // received broadcasts in, WHILE the emails are still live (the tombstone
      // below redacts recipient_email_lower; recipient_member_id is always
      // NULL). Surfaced to the post-commit subprocessor cascade — it cannot be
      // re-derived post-scrub. Keyed on `tombstoneEmails` (FIX-3): the audience
      // derivation drives an external address-keyed Resend removal, so it MUST
      // cover a pre-archived contact's email but must NOT include a peer's
      // live-claimed email (which would unsubscribe the peer).
      // M-1 (DELIBERATE asymmetry — do NOT "simplify" to best-effort): this
      // in-tx CAPTURE is FAIL-LOUD (throw → rolls back the whole erasure), while
      // the post-commit Resend REMOVAL is best-effort/non-blocking. A
      // derivation-read failure means we don't KNOW the member's audiences →
      // aborting + letting the reconciler retry the WHOLE erasure (the read is
      // re-drivable while contacts are still live) beats silently
      // under-propagating. Once captured, the external removal's inputs don't
      // survive a re-drive, so it is genuinely best-effort.
      capturedSubprocessorPairs =
        await deps.broadcastsAudienceDerivation.listMemberAudienceContactsInTx(
          tx,
          deps.tenant.slug,
          tombstoneEmails,
        );

      // COMP-1 US2b (re-drive-stable delivery tombstone) — tombstone every
      // `broadcast_deliveries` row the member RECEIVED, INSIDE this atomic tx,
      // while the member's contact emails are still LIVE. Keyed on the
      // unambiguous all-contact set MINUS peer-live-claimed emails
      // (`tombstoneEmails`, FIX-3): deliveries are only ever addressed to
      // contact emails — the linked-login axis adds zero coverage; and a contact
      // ARCHIVED before erasure (excluded by the old live-only set) still has a
      // historical delivery whose plaintext recipient_email_lower must be
      // tombstoned, while a peer's live-claimed email must be left alone. The F1
      // user cascade keeps its own linked-login set for the credential erasure.
      // Co-commits with `erased_at` (a throw rolls back the whole atomic tx,
      // caught below), so a first-pass failure of the POST-COMMIT content-scrub
      // cascade can never leave deliveries un-tombstoned, and a re-drive — where
      // the live emails are already removed_at-stamped — never needs to re-find
      // them (the tombstone keys on sentinelised rows that no longer match). The
      // count is surfaced to the post-commit content-scrub cascade so the single
      // `broadcast_content_redacted` audit records both axes. Runs BEFORE the
      // contacts scrub below stamps `removed_at` on those emails.
      const tombstone =
        await deps.broadcastsDeliveryTombstone.tombstoneDeliveriesInTx(
          tx,
          deps.tenant.slug,
          tombstoneEmails,
        );
      tombstonedDeliveriesCount = tombstone.tombstonedCount;

      // COMP-1 FIX-9 — element-wise redact the erased member's email out of
      // OTHER authors' broadcasts.custom_recipient_emails, INSIDE this atomic
      // tx, while the member's contact emails are still LIVE. The post-commit
      // F7 content-scrub (keyed on requested_by_member_id) handles the member's
      // OWN broadcasts, but the member's email sitting in a SIBLING author's
      // custom recipient list is never reached by it → plaintext PII survival
      // on a peer member's row (Art.17 / PDPA §33 gap; the SAME bug-class as
      // the delivery tombstone above — the recipient-PII erasure axis in F7 is
      // EMAIL, not author id). Keyed on the SAME `tombstoneEmails` set as the
      // tombstone (FIX-3 cross-member over-redaction guard — covers a
      // pre-archived contact's email, excludes a peer's live-claimed email).
      // FAIL-LOUD by construction (co-commits with `erased_at`; a throw rolls
      // back the whole atomic tx → member_erased withheld → the US2d reconciler
      // re-drives). The member's OWN custom rows are ALSO element-wise redacted
      // here harmlessly; the post-commit author-scrub subsequently
      // whole-array-replaces them — order-independent, non-conflicting.
      await deps.broadcastsDeliveryTombstone.redactCustomRecipientEmailsInTx(
        tx,
        deps.tenant.slug,
        tombstoneEmails,
      );

      const scrubMember = await deps.memberRepo.scrubPiiInTx(tx, memberId, {
        erasedAt: now,
      });
      if (!scrubMember.ok) {
        if (scrubMember.error.code === 'repo.not_found')
          throw new EraseNotFoundError();
        // Thread the repo `cause` (SQLSTATE + PG message) into the Error so the
        // outer catch's `err: e` log carries the DB detail. Forensics-only.
        throw new Error(`member_scrub_failed:${scrubMember.error.code}`, {
          cause: 'cause' in scrubMember.error ? scrubMember.error.cause : undefined,
        });
      }

      const scrubContacts = await deps.contactRepo.scrubPiiForMemberInTx(
        tx,
        memberId,
        { erasedAt: now },
      );
      if (!scrubContacts.ok)
        throw new Error(`contact_scrub_failed:${scrubContacts.error.code}`, {
          cause:
            'cause' in scrubContacts.error ? scrubContacts.error.cause : undefined,
        });

      // Cascade — revoke the sessions of the users linked at erasure time
      // (snapshot read above, before the scrubs shadowed removed_at).
      for (const userId of uniqueLinkedUserIds) {
        const revoked = await deps.sessions.revokeAllForInTx(tx, userId, 'admin_force');
        if (!revoked.ok)
          throw new Error(`session_revoke_failed:${revoked.error.code}`, {
            cause: 'cause' in revoked.error ? revoked.error.cause : undefined,
          });
        sessionsRevokedTotal += revoked.value.revokedCount;

        const sessionAudit = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'user_sessions_revoked',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `sessions revoked for user ${userId} — member erased`,
          payload: {
            user_id: userId,
            member_id: memberId,
            revoked_count: revoked.value.revokedCount,
            reason: 'admin_force_erase',
          },
        });
        if (!sessionAudit.ok)
          throw new Error('audit_failed', {
            cause:
              'cause' in sessionAudit.error ? sessionAudit.error.cause : undefined,
          });
      }

      // Soft-consume any pending/unredeemed invitations for the linked users so
      // the invite links become dead (defense-in-depth). Cross-module boundary
      // via InvitationCascadePort (Principle III).
      const inv = await deps.invitations.softConsumePendingForUsersInTx(
        tx,
        uniqueLinkedUserIds,
        now,
      );
      invitationsRevokedCount = inv.revokedCount;

      // COMP-1 US2a (M1) — invalidate every active email_change_token (any
      // type) for the member's linked logins, ATOMICALLY with the scrub. A
      // live 48h `revert` token holds the ORIGINAL email in plaintext; left
      // active it could be redeemed post-erasure to restore that email onto
      // users.email + contacts.email (Art.17 PII resurrection). Stamping
      // consumed_at removes it from findActiveByIdInTx's unconsumed filter so
      // it can never be redeemed. Driven by the UNFILTERED erasure work-list
      // (re-drive-stable). The matching frozen-address outbox rows (revert →
      // old_email, verification → new_email) are returned for the cancel below.
      const tokenInvalidation =
        await deps.tokens.invalidateAllActiveForUsersInTx(
          tx,
          linkedUserIdsForErasure,
          now,
        );
      if (!tokenInvalidation.ok)
        throw new Error(
          `token_invalidation_failed:${tokenInvalidation.error.code}`,
          {
            cause:
              'cause' in tokenInvalidation.error
                ? tokenInvalidation.error.cause
                : undefined,
          },
        );

      // COMP-1 US2a (L1) — cancel the erased subject's pending
      // notifications_outbox rows, ATOMICALLY with the scrub (mirrors
      // delete-invited-user.ts). Each row's `to_email` was frozen at enqueue =
      // a real address, and the retry ladder keeps a once-failed row pending up
      // to 12h, so the dispatcher could still email the erased subject. The
      // address set = contact emails (pre-scrub, LIVE-only) ∪ linked-login
      // emails (pre-erasure) ∪ the invalidated tokens' old/new emails. Only
      // `pending` rows are deleted; sent / permanently_failed history survives.
      // notifications_outbox is tenant-scoped (RLS), so this MUST run in this
      // runInTenant tx — NOT the cross-tenant owner-role eraseUser tx.
      //
      // COMP-1 FIX-4 — `memberId` is passed so the adapter's two-pronged
      // cross-member ownership guard protects a PEER member's pending mail on
      // ALL THREE arms: the unguarded linked-login / token arms (a login U
      // shared via contacts on a DIFFERENT live member — contacts.linked_user_id
      // is not unique) would otherwise DELETE a peer's mail to U.email. The
      // live-only `contactEmailsForCancel` already guards the contact arm; the
      // adapter guard now also covers the login/token arms.
      const linkedLoginEmails = await deps.userEmails.listEmailsForUsersInTx(
        tx,
        linkedUserIdsForErasure,
      );
      if (!linkedLoginEmails.ok)
        throw new Error(
          `linked_login_email_read_failed:${linkedLoginEmails.error.code}`,
          {
            cause:
              'cause' in linkedLoginEmails.error
                ? linkedLoginEmails.error.cause
                : undefined,
          },
        );

      const emailsToCancel = Array.from(
        new Set<string>([
          ...contactEmailsForCancel,
          ...linkedLoginEmails.value,
          ...tokenInvalidation.value.invalidatedEmails,
        ]),
      );
      const outboxCancel = await deps.outboxCancel.cancelPendingForEmailsInTx(
        tx,
        emailsToCancel,
        memberId,
      );
      if (!outboxCancel.ok)
        throw new Error(`outbox_cancel_failed:${outboxCancel.error.code}`, {
          cause:
            'cause' in outboxCancel.error
              ? outboxCancel.error.cause
              : undefined,
        });
    });
  } catch (e) {
    if (e instanceof EraseNotFoundError) return err({ type: 'not_found' });
    logger.error(
      { err: e, memberId, requestId: meta.requestId },
      'erase-member: scrub tx failed',
    );
    return err({ type: 'server_error', message: 'erase scrub failed' });
  }

  // Idempotency / resumability (design §6): the scrub is repeatable (stable
  // sentinels), the cascades are individually idempotent, and member_erased is
  // emitted ONLY on a fully-clean run — so a partial erasure is completed by a
  // later call (or the US2 reconciliation sweep), and an incomplete run is never
  // marked done. A re-drive of an already-erased member re-emits member_erased
  // with 0/0 counts (sessions/invitations already revoked on the first pass) —
  // benign, append-only.
  //
  // 3. POST-COMMIT best-effort cascades. Each opens its own tx (in the adapter)
  //    and must NOT roll back the committed scrub. Track whether every cascade
  //    reported a clean outcome — only then is the erasure "complete".
  let allCascadesClean = true;

  try {
    const r = await deps.broadcastsCascade.cancelInFlightForMember(deps.tenant, memberId, {
      cancellationReason: reason,
      initiatedByUserId: meta.actorUserId,
      requestId: meta.requestId,
    });
    // Broadcasts `cascade_partial_failure` is NOT benign (unlike F8 renewals
    // below): it means `unexpectedErrorCount > 0` — one or more broadcasts hit
    // unexpected errors and genuinely remain in-flight. Keep it not-clean so the
    // US2 reconciler retries the stuck rows. LOW finding: log the per-row counts
    // (mirrors archive-member.ts) so the cleanup runbook can grep which
    // broadcasts are stuck, not just the bare outcome label.
    if (r.outcome === 'cascade_partial_failure') {
      allCascadesClean = false;
      logger.error(
        {
          memberId,
          requestId: meta.requestId,
          outcome: r.outcome,
          cancelledCount: r.cancelledCount,
          skippedConcurrentCount: r.skippedConcurrentCount,
          unexpectedErrorCount: r.unexpectedErrorCount,
          cascade: 'f7_in_flight_broadcast_cancel',
        },
        'erase-member: broadcasts cascade partial — some broadcasts remain in flight',
      );
    } else if (r.outcome !== 'ok') {
      allCascadesClean = false;
      logger.error(
        {
          memberId,
          requestId: meta.requestId,
          outcome: r.outcome,
          cascade: 'f7_in_flight_broadcast_cancel',
        },
        'erase-member: broadcasts cascade not clean',
      );
    }
  } catch (cascadeErr) {
    allCascadesClean = false;
    logger.error(
      {
        err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        memberId,
        requestId: meta.requestId,
        cascade: 'f7_in_flight_broadcast_cancel',
      },
      'erase-member: broadcasts cascade threw',
    );
  }

  try {
    const r = await deps.renewalsCascade.cancelInFlightForMember(deps.tenant, memberId, {
      cancellationReason: reason,
      initiatedByUserId: meta.actorUserId,
      requestId: meta.requestId,
    });
    // H2 (refined): the F8 adapter maps TWO distinct situations to the SAME
    // `cascade_partial_failure` outcome, so the bare label is NOT enough to
    // decide benign-ness — `skippedConcurrentCount` is the discriminator.
    // erase-member INTENTIONALLY splits the bucket by `skippedConcurrentCount`;
    // `archive-member.ts` does NOT — it warns for the WHOLE bucket (treats every
    // `cascade_partial_failure` as a benign concurrent_skip, see ~347-367).
    // Only the `> 0` WARN arm below mirrors archive; the `=== 0` not-clean arm is
    // erasure-specific and MUST NOT be collapsed back into a warn (doing so
    // reintroduces the H2 bug — `member_erased` emitted over an in-flight cycle).
    //   (1) `skippedConcurrentCount > 0` → a concurrent admin cancel won the
    //       race and the cycle already reached terminal `cancelled` by a
    //       different actor (the cycle IS cancelled). BENIGN — must NOT block
    //       `member_erased`, else the US2 reconciler re-runs forever on an
    //       erasure that is actually done. This WARN arm mirrors how
    //       `archive-member.ts` handles the same outcome (warn, not fail).
    //   (2) `skippedConcurrentCount === 0` → a generic infra failure
    //       (deadlock 40P01 / statement-timeout 57014 / connection-blip 08006 /
    //       repo bug) OR an audit-emit failure rolled back the per-cycle cancel
    //       tx, so the cycle is STILL in-flight. This is a REAL failure that
    //       also surfaces as `cascade_partial_failure`. Treat it as NOT clean —
    //       mirroring how the broadcasts partial above is handled — so the US2
    //       reconciler re-drives the stuck cycle. (Without this, `member_erased`
    //       could be emitted while a renewal cycle is genuinely in-flight and
    //       the reconciler, which keys on `member_erased`, would never retry.)
    if (r.outcome === 'cascade_partial_failure') {
      if (r.skippedConcurrentCount > 0) {
        logger.warn(
          {
            memberId,
            requestId: meta.requestId,
            cancelledCount: r.cancelledCount,
            skippedConcurrentCount: r.skippedConcurrentCount,
            cascade: 'f8_in_flight_cycle_cancel',
          },
          'erase-member: renewals cascade partial — concurrent admin cancel won race, cycle already terminal',
        );
      } else {
        allCascadesClean = false;
        logger.error(
          {
            memberId,
            requestId: meta.requestId,
            outcome: r.outcome,
            cancelledCount: r.cancelledCount,
            skippedConcurrentCount: r.skippedConcurrentCount,
            cascade: 'f8_in_flight_cycle_cancel',
          },
          'erase-member: renewals cascade partial without concurrent skip — cycle remains in flight (generic tx / audit-emit failure)',
        );
      }
    } else if (r.outcome !== 'ok') {
      allCascadesClean = false;
      logger.error(
        {
          memberId,
          requestId: meta.requestId,
          outcome: r.outcome,
          cascade: 'f8_in_flight_cycle_cancel',
        },
        'erase-member: renewals cascade not clean',
      );
    }
  } catch (cascadeErr) {
    allCascadesClean = false;
    logger.error(
      {
        err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        memberId,
        requestId: meta.requestId,
        cascade: 'f8_in_flight_cycle_cancel',
      },
      'erase-member: renewals cascade threw',
    );
  }

  // F1 linked-user erasure (US2a) — the keystone that closes the US1→US2
  // residual: anonymise each login account linked to the erased member so its
  // email no longer resolves at sign-in (GDPR Art.17 / PDPA §33). Each
  // eraseUser runs in its OWN owner-role tx (the `users` table is cross-tenant
  // — no tenant_id, no RLS — so it cannot join the members scrub tx). Driven by
  // the UNFILTERED work-list captured INSIDE the scrub tx
  // (`listAllLinkedUserIdsForMemberInTx`, surfaced via `linkedUserIdsForErasure`)
  // — re-drive-stable because linked_user_id survives the contacts removed_at
  // scrub. On a re-drive the work-list re-includes already-erased logins; that
  // is intentional — eraseUser is idempotent (byte-identical re-scrub, emits
  // another user_erased; acceptable append-only audit noise on the rare
  // re-drive) and re-attempting them costs nothing, while the previously-FAILED
  // login is finally re-attempted (the Critical Task-6 fix). We deliberately do
  // NOT add per-user already-erased skipping — correctness over audit noise.
  //
  // Best-effort + idempotent: a re-run anonymises an already-sentinel login as
  // a no-op (the auth use-case derives a deterministic sentinel from the id),
  // so the cascade is safely resumable. `erased:false` (the users row was
  // already gone) is a SUCCESS — the erasure goal already holds. Any failure
  // flips allCascadesClean=false, WITHHOLDING member_erased so the US2d
  // reconciler re-drives the linked-user that did not erase — the SAME gating
  // the F7/F8 cascades above use. The per-user try/catch keeps one login's
  // failure from aborting the rest (the adapter is never-throws, but the
  // defensive catch mirrors the F7/F8 cascade structure).
  for (const userId of linkedUserIdsForErasure) {
    try {
      const r = await deps.userErasure.eraseUser(userId, {
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
      });
      if (!r.ok) {
        allCascadesClean = false;
        logger.error(
          {
            memberId,
            userId,
            requestId: meta.requestId,
            code: r.error.code,
            cascade: 'f1_user_erasure',
          },
          'erase-member: F1 user erasure not clean',
        );
      }
    } catch (cascadeErr) {
      allCascadesClean = false;
      logger.error(
        {
          err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
          memberId,
          userId,
          requestId: meta.requestId,
          cascade: 'f1_user_erasure',
        },
        'erase-member: F1 user erasure threw',
      );
    }
  }

  // F7 broadcast CONTENT scrub (US2b) — redact the PII the member AUTHORED
  // into F7 broadcasts: scrub every broadcast the member ORIGINATED
  // (subject/body_html/body_source/from_name/reply_to_email → '[redacted]',
  // custom_recipient_emails → sentinel ['[redacted]'] on custom rows / NULL
  // otherwise, + the nullable reason columns rejection_reason/
  // cancellation_reason/failure_reason → NULL, keyed on
  // requested_by_member_id). The
  // delivery tombstone is NO LONGER here — it ran in the ATOMIC scrub tx above
  // (co-committing with erased_at), so a failure here can never leave
  // deliveries un-tombstoned (the 2026-06-18 2nd /code-review HIGH fix). The
  // `tombstonedCount` from that atomic step is threaded in so the single
  // `broadcast_content_redacted` audit still records BOTH axes. The F7
  // use-case behind this port opens its OWN atomic tx (content + audit
  // co-commit), so this cascade is re-drive-safe: on a US2d reconciler
  // re-drive the content read (requested_by_member_id = memberId) is NOT
  // nulled by erasure → it re-discovers + re-scrubs idempotently. A non-ok
  // outcome / throw flips allCascadesClean=false → member_erased withheld →
  // reconciler re-drives → completes. The erasure `reason` (Art.17 / PDPA §33)
  // is the SAME value threaded to the F7/F8 cancel cascades above, so it passes
  // straight through (`MemberErasureReason` is the strict erasure subset) with
  // no cast. Best-effort: a throw is caught here so it never aborts the other
  // cascades or escapes the use-case (the adapter is documented never-throws;
  // the catch mirrors the F1/F7/F8 cascade structure defensively).
  try {
    const r = await deps.broadcastsContentScrub.scrubContentForMember(deps.tenant, memberId, {
      initiatedByUserId: meta.actorUserId,
      requestId: meta.requestId,
      reason,
      // US2b: the delivery-tombstone count from the ATOMIC scrub tx above, so
      // the single `broadcast_content_redacted` audit records both the content
      // scrub count and this delivery count (no audit split).
      tombstonedCount: tombstonedDeliveriesCount,
    });
    if (r.outcome !== 'ok') {
      allCascadesClean = false;
      logger.error(
        {
          memberId,
          requestId: meta.requestId,
          cascade: 'f7_content_scrub',
        },
        'erase-member: F7 content-scrub cascade not clean',
      );
    }
  } catch (cascadeErr) {
    allCascadesClean = false;
    logger.error(
      {
        err: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        memberId,
        requestId: meta.requestId,
        cascade: 'f7_content_scrub',
      },
      'erase-member: F7 content-scrub cascade threw',
    );
  }

  // F6 event-registration fan-out erasure (US2c) — hard-delete every F6 event
  // registration matched to the erased member (each carries the attendee's
  // email / name / company), crediting back any consumed benefit quota per
  // registration. Order-independent of the F1/F7/F8 cascades above. The F6
  // fan-out (behind this port) opens its OWN per-registration runInTenant tx
  // (one per row, so a single registration's rollback never poisons the
  // others — best-effort) and keys on `matched_member_id = member` (a member
  // link NOT scrubbed by erasure) + HARD-DELETES, so the cascade is re-drive-
  // stable by construction: a re-drive re-discovers the surviving registrations
  // (deleted ones are gone) and completes the remainder. The three-way outcome:
  //   - `'ok'`      → the fan-out ran with NO per-registration failures →
  //                   clean (erasedCount may be 0 when the member had none).
  //   - `'partial'` → ≥1 registration failed (failedCount > 0). The member-row
  //                   erasure still committed, but the cascade is incomplete —
  //                   flip allCascadesClean=false so member_erased is withheld
  //                   and the US2d reconciler re-drives the remaining rows
  //                   (idempotent: a re-run enumerates 0 of the already-deleted
  //                   rows). Log the erased/failed counts (uuids only — NEVER
  //                   attendee PII, which is exactly what we erased).
  //   - `'failed'`  → the fan-out call threw at the calling convention
  //                   (defensive — the fan-out is itself never-erring). Treat
  //                   as not-clean → member_erased withheld.
  // Best-effort: the adapter is documented never-throws, but the defensive
  // catch mirrors the F1/F7/F8 cascade structure so a pathological throw cannot
  // abort the member_erased gating below or escape the use-case.
  //
  // Logging ownership: the cascade-detail error log is emitted by the adapter
  // (`event-registration-erasure-adapter`), the natural owner of the cascade
  // detail — it logs tenantId + memberId + requestId + counts + cascade on a
  // 'partial'/'failed' outcome. This block intentionally does NOT re-log
  // (that was a duplicate); it only flips `allCascadesClean = false` to withhold
  // `member_erased`. The defensive catch still flips the flag (the adapter is
  // documented never-throws, but a pathological throw must not escape or skip
  // the gating); the adapter already logs the underlying cause before any throw.
  try {
    const r = await deps.eventRegistrationErasure.eraseAllForMember(
      deps.tenant,
      memberId,
      { actorUserId: meta.actorUserId, requestId: meta.requestId },
    );
    if (r.outcome !== 'ok') {
      allCascadesClean = false;
    }
  } catch {
    allCascadesClean = false;
  }

  // COMP-1 US3-C — best-effort sub-processor erasure propagation. NON-BLOCKING
  // (does NOT flip allCascadesClean): the Resend-removal inputs were captured
  // only in the first-pass atomic tx and are destroyed by this same erasure, so
  // a US2d reconciler re-drive re-captures an EMPTY set and cannot retry. The
  // outcome is recorded in `subprocessor_erasure_propagated` + the metric for
  // the DPO alert/runbook. member_erased reflects the controller's
  // authoritative-copy erasure; sub-processor propagation is tracked separately.
  // The adapter never throws; a defensive catch guards only the audit-emit.
  try {
    const sub = await deps.subprocessorErasure.propagate({
      memberId,
      reason,
      audienceContacts: capturedSubprocessorPairs,
      tenantSlug: deps.tenant.slug,
      requestId: meta.requestId,
    });
    // Emit the metric for EVERY outcome (ok/partial/failed) so a partial/failed
    // is never silently lost (it pages the DPO runbook).
    erasureMetrics.subprocessorErasure(sub.resendOutcome, deps.tenant.slug);
    await runInTenant(deps.tenant, async (tx) => {
      const done = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'subprocessor_erasure_propagated',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `subprocessor_erasure_propagated ${memberId}`,
        payload: {
          member_id: memberId,
          reason,
          resend_outcome: sub.resendOutcome,
          resend_contacts_removed_count: sub.resendContactsRemoved,
          resend_contacts_failed_count: sub.resendContactsFailed,
          stripe_outcome: sub.stripeOutcome,
        } satisfies SubprocessorErasurePropagatedAudit,
      });
      if (!done.ok) throw new Error('subprocessor_audit_failed');
    });
  } catch (auditErr) {
    // The audit-emit (not the propagation) failed → log; do NOT block
    // member_erased (the propagation outcome is lost from the trail but the
    // erasure is authoritative; the metric above still fired). Named auditErr
    // (not cascadeErr): propagate() is contractually never-throws, so only the
    // recordInTx runInTenant above can reach this catch.
    logger.error(
      {
        err:
          auditErr instanceof Error
            ? auditErr.message
            : String(auditErr),
        memberId,
        requestId: meta.requestId,
        cascade: 'subprocessor_erasure',
      },
      'erase-member: subprocessor cascade audit failed',
    );
  }

  // 4. Completion proof — emit member_erased ONLY when every cascade is clean.
  //    A partial run leaves erased_at set with NO member_erased; the US2
  //    reconciliation sweep re-drives the remainder and emits it then.
  if (allCascadesClean) {
    try {
      await runInTenant(deps.tenant, async (tx) => {
        const done = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'member_erased',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `member_erased ${memberId}`,
          payload: {
            member_id: memberId,
            reason,
            sessions_revoked_total: sessionsRevokedTotal,
            invitations_revoked_count: invitationsRevokedCount,
            // L4 (DPO-log honesty): on a re-drive completion (alreadyErased) the
            // first pass already stamped contacts.removed_at, so this pass's
            // linked-user read is [] and the two counts above are 0/0. The flag
            // tells a DPO/auditor the counts reflect ONLY this completing run —
            // the authoritative session-revocation record is the
            // user_sessions_revoked rows emitted on the FIRST pass.
            re_drive: alreadyErased,
          },
        });
        if (!done.ok)
          throw new Error('audit_failed', {
            cause: 'cause' in done.error ? done.error.cause : undefined,
          });
      });
    } catch (e) {
      allCascadesClean = false;
      logger.error(
        { err: e, memberId, requestId: meta.requestId },
        'erase-member: member_erased audit failed',
      );
    }
  }

  return ok({ memberId, erasedAt: now, cascadesComplete: allCascadesClean });
}
