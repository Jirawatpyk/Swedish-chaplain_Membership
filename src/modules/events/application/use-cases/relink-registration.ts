/**
 * T104 — `relinkRegistration` use-case (F6 Application — Phase 9 / US6).
 *
 * Admin manual-relink action per FR-014. Atomically in one ACID tx:
 *
 *   1. Loads the registration via `registrationsRepo.findById` →
 *      `registration_not_found` if missing.
 *
 *   1b. **Path-eventId guard** (Round-2 code-H1 closure) — when
 *      `eventIdFromPath !== null` and differs from
 *      `registration.eventId`, returns `event_path_mismatch` BEFORE
 *      step 2 / any mutation / lock / audit. Closes a silent-success
 *      class bug where a Round-1 post-commit route check refused the
 *      response AFTER the use-case had already mutated the DB.
 *      `eventIdFromPath: null` (e.g., future bulk-relink endpoint
 *      without URL context) skips the check.
 *
 *   2. Rejects pseudonymised rows EARLY at the Application boundary with
 *      `pseudonymised_row_rejected` — the Drizzle adapter ALSO enforces
 *      this via `WHERE pii_pseudonymised_at IS NULL` (defence-in-depth),
 *      but the Application pre-check avoids wasted lock acquisitions +
 *      audit emissions on a row we are about to refuse and gives the
 *      route handler a clean 409 mapping (vs. surfacing an opaque
 *      `invariant_violation` from the repo path). Matches FR-014 round-2
 *      R4 "disallowed" semantics rather than "racing to fail".
 *
 *   3. Loads the event via `eventsRepo.findById` →
 *      `event_not_found` / `event_archived` short-circuits. Archived
 *      events are quota-neutral so re-evaluation would be meaningless.
 *
 *   4. Short-circuits when `newMatchedMemberId === aggregate.match.matchedMemberId`
 *      with `ok({ noop:true, ... })`. No audit row, no lock, no DB write.
 *      Route handler returns 200 with a no-op flag for client-side
 *      toast guidance.
 *
 *   4b. **Deadlock-safe lock acquisition** (Round-1 polish) — when the
 *      relink touches BOTH OLD + NEW members, acquire both advisory
 *      locks upfront in `LockKey`-sorted order so two concurrent
 *      relinks `A→B` and `B→A` cannot deadlock. Same principle as
 *      archive-event's `ORDER BY matched_member_id ASC` SELECT —
 *      different mechanism (sort 2 keys in-process vs ORDER BY at
 *      SQL layer over N rows). Skipped when OLD has no counted
 *      scope (only NEW lock needed).
 *
 *   5. CREDIT-BACK OLD MEMBER (skipped if old `matchedMemberId === null`,
 *      e.g., previous match was `non_member` / `unmatched`). For each
 *      scope where the row's `previousQuotaEffect.countedAgainst<scope>`
 *      is true:
 *      a. Acquire the per-(tenant, oldMember, event) advisory lock —
 *         same `eventcreate-quota:` namespace ingest + archive + toggle
 *         use, so a concurrent ingest on the same key blocks until this
 *         relink commits.
 *      b. Look up the OLD member's allotment snapshot via
 *         `queryAllotments`. The `allotmentAfter` value posted to the
 *         credit-back audit accounts for THIS row's flag flipping from
 *         counted → uncounted (consumed drops by 1).
 *      c. Emit `quota_credit_back_archive` via the shared
 *         `emitQuotaScopeAudit(action:'credit_back')` helper. The
 *         `_archive` variant is reused intentionally — the F6 audit
 *         taxonomy reserves no `_relink` enum value yet (the comment at
 *         `pino-audit-port.ts § "quota_credit_back_relink reserved"`
 *         documents the reservation for a future migration).
 *         Toggle-event-category uses the same reuse pattern for its
 *         credit-back path — see `toggle-event-category.ts § "Quota-
 *         side audit policy"` for the precedent.
 *         The macro `registration_relinked` audit emitted in step 8
 *         preserves the relink context in the `quotaImpact` payload so
 *         forensic queries are not lossy.
 *
 *   6. DECIDE NEW QUOTA EFFECT FOR NEW MEMBER. Always acquire the
 *      per-(tenant, newMember, event) advisory lock + query allotments
 *      (also serves as the new-member existence check — a missing member
 *      surfaces as `new_member_not_found` BEFORE we touch
 *      `updateMatchAndQuota`). Then, per scope where the event's flag is
 *      true:
 *      a. If new member has room → set `countedAgainst<scope>=true`,
 *         emit `quota_<scope>_decremented` via the shared helper
 *         (`action:'decremented'`).
 *      b. If new member is at allotment → set `countedAgainst<scope>=false`,
 *         emit `quota_over_quota_warning` (`action:'over_quota'`).
 *
 *   7. Persist the new match + quota via
 *      `registrationsRepo.updateMatchAndQuota`. The DB-layer guard
 *      `WHERE pii_pseudonymised_at IS NULL` re-asserts step 2's check
 *      (defence-in-depth against TOCTOU between the load and the write).
 *      `nextMatch = { type:'member_contact', matchedMemberId, matchedContactId:null }`
 *      — admin relink always lands as `member_contact` per FR-014's
 *      surface model (admin asserted "this attendee IS this member").
 *      `matchedContactId` is null because the relink dialog selects by
 *      member, not by contact; the contact-level breadcrumb is not
 *      asserted by admin and a stale or invalid contactId would
 *      contaminate FK integrity.
 *
 *   8. Emit the macro `registration_relinked` audit carrying both sides
 *      of the transition (`previousMatchedMemberId`, `previousMatchType`,
 *      `newMatchedMemberId`, `newMatchType`) and the `quotaImpact` shape:
 *      - `creditedBackFor` — OLD member if any scope was credit-backed,
 *        else null.
 *      - `decrementedFor` — NEW member if any scope was decremented,
 *        else null.
 *      - `scopes` — every scope where EITHER side observed a quota
 *        change (credit-back OR decrement). Over-quota-with-no-room is
 *        NOT a quota change for the new member but IS a credit-back for
 *        the old member if old had it counted; in that case the scope
 *        still appears (because old changed).
 *
 * Constitution Principle III: pure Application — no framework imports.
 * Caller (route handler) owns the tx via `runInTenantWithRollbackOnErr`
 * (`src/lib/events-admin-deps.ts`).
 */
import { ok, err, type Result } from '@/lib/result';
import { safeAuditEmit } from './_helpers/safe-audit-emit';
import type { TenantId, MemberId } from '@/modules/members';
import type { EventId, RegistrationId } from '../../domain/branded-types';
import type {
  EventRegistrationAggregate,
  MatchResolution,
  QuotaEffect,
} from '../../domain/event-registration';
import { isPseudonymised } from '../../domain/event-registration';
import { isQuotaCountedStatus } from '../../domain/value-objects/payment-status';
import type { MatchType } from '../../domain/value-objects/match-type';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type {
  QuotaAccountingPort,
  QuotaAccountingError,
} from '../ports/quota-accounting-port';
import type { F6AuditPort, AuditEmitError } from '../ports/audit-port';
import type {
  AdvisoryLockAcquirer,
  InvalidLockKeyError,
} from '../ports/advisory-lock-acquirer';
import type { UserId } from '@/modules/auth';
import { buildQuotaLockKey } from './apply-quota-effect';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { F6_FISCAL_YEAR_START_MONTH } from './_helpers/fiscal-year-constants';
import {
  eventsRepoErrorMessage,
  registrationsRepoErrorMessage,
  quotaAccountingErrorMessage,
} from './_helpers/repo-error-message';
import {
  wrapAuditEmitFailure,
  wrapLockFailure,
} from './_helpers/error-wrappers';
import { emitQuotaScopeAudit } from './_helpers/emit-quota-scope-audit';
import type { LockKey } from '../ports/advisory-lock-acquirer';

export interface RelinkRegistrationInput {
  readonly tenantId: TenantId;
  readonly registrationId: RegistrationId;
  readonly newMatchedMemberId: MemberId;
  readonly actorUserId: UserId;
  readonly occurredAt: Date;
  /**
   * eventId from the URL path. The use-case
   * verifies that `registration.eventId === eventIdFromPath` BEFORE
   * any mutation (lock acquisition / audit emission / DB write). A
   * mismatch returns `event_path_mismatch` and the route maps to 404,
   * rolling back via `runInTenantWithRollbackOnErr` so no partial
   * state can commit. Without this gate, a misrouted URL would
   * silently relink the registration (the use-case used the row's
   * `eventId` to compose the lock key, so the operation succeeded
   * server-side) while the route returned 404 to the admin — a
   * silent-success class bug.
   *
   * Pass `null` from callers that do not have a URL-path eventId
   * (e.g., a future bulk-relink endpoint); the check is skipped in
   * that case.
   */
  readonly eventIdFromPath: EventId | null;
}

export interface RelinkQuotaImpact {
  readonly creditedBackFor: MemberId | null;
  readonly decrementedFor: MemberId | null;
  readonly scopes: ReadonlyArray<'partnership' | 'cultural'>;
}

export type RelinkRegistrationOutput =
  | {
      /** Short-circuit when new member equals current match. */
      readonly noop: true;
      readonly registrationId: RegistrationId;
      readonly matchedMemberId: MemberId | null;
    }
  | {
      readonly noop: false;
      readonly registrationId: RegistrationId;
      readonly previousMatchedMemberId: MemberId | null;
      readonly newMatchedMemberId: MemberId;
      readonly previousMatchType: MatchType;
      readonly newMatchType: 'member_contact';
      readonly quotaImpact: RelinkQuotaImpact;
      readonly registration: EventRegistrationAggregate;
    };

/**
 * Every variant carries `message` + `cause` (where applicable) so
 * route handlers can extract retry-eligibility context via pino's
 * `err:` key for SRE classification. Shape mirrors `ArchiveEventError`
 * + `ToggleEventCategoryError` for cross-module consistency — see
 * those files for the discriminator-rationale precedent.
 *
 * `pseudonymised_row_rejected` is its OWN discriminator (not wrapped
 * inside `registrations_repo_error`) because the route handler maps it
 * to a distinct 409 status + UX-message-constant per FR-014 round-2 R4,
 * separate from the generic 500 path for repo errors.
 *
 * `new_member_not_found` covers both "memberId unknown" and "member has
 * no plan to query" — `queryAllotments` is the single boundary that
 * surfaces both as `member_not_found` / `plan_not_found`; the use-case
 * collapses them into one 404 for the admin UI because both are
 * equivalent to "this member cannot accept a relink right now".
 */
export type RelinkRegistrationError =
  | {
      readonly kind: 'registration_not_found';
      readonly registrationId: RegistrationId;
    }
  | {
      readonly kind: 'pseudonymised_row_rejected';
      readonly registrationId: RegistrationId;
    }
  | {
      /**
       * URL path's eventId does not match the
       * registration's stored event_id. Returned BEFORE any mutation
       * so `runInTenantWithRollbackOnErr` rolls back cleanly. Route
       * maps to 404 (treat as not-found; the URL is malformed
       * semantically even if both ids are valid UUIDs).
       */
      readonly kind: 'event_path_mismatch';
      readonly registrationId: RegistrationId;
      readonly eventIdInPath: EventId;
      readonly eventIdOnRegistration: EventId;
    }
  | { readonly kind: 'event_not_found'; readonly eventId: EventId }
  | { readonly kind: 'event_archived'; readonly eventId: EventId }
  | {
      readonly kind: 'new_member_not_found';
      readonly memberId: MemberId;
    }
  | {
      readonly kind: 'events_repo_error';
      readonly message: string;
      readonly cause: EventsRepositoryError;
    }
  | {
      readonly kind: 'registrations_repo_error';
      readonly message: string;
      readonly cause: RegistrationsRepositoryError;
    }
  | {
      readonly kind: 'lock_acquisition_failed';
      readonly message: string;
      readonly cause: Error;
    }
  | {
      readonly kind: 'lock_key_invariant_violation';
      readonly message: string;
      readonly cause: InvalidLockKeyError;
    }
  | {
      readonly kind: 'quota_lookup_failed';
      readonly message: string;
      readonly cause: QuotaAccountingError;
    }
  | {
      readonly kind: 'audit_emit_failed';
      readonly message: string;
      readonly cause: AuditEmitError;
    };

export interface RelinkRegistrationDeps {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
  readonly quotaAccountingPort: QuotaAccountingPort;
  readonly advisoryLockAcquirer: AdvisoryLockAcquirer;
  readonly audit: F6AuditPort;
}

export async function relinkRegistration(
  input: RelinkRegistrationInput,
  deps: RelinkRegistrationDeps,
): Promise<Result<RelinkRegistrationOutput, RelinkRegistrationError>> {
  // (1) Load registration
  const regLookup = await deps.registrationsRepo.findById(
    input.tenantId,
    input.registrationId,
  );
  if (!regLookup.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(regLookup.error),
      cause: regLookup.error,
    });
  }
  const registration = regLookup.value;
  if (!registration) {
    return err({
      kind: 'registration_not_found',
      registrationId: input.registrationId,
    });
  }

  // (1b) Round-2 code-H1 closure — verify the URL path's eventId
  // matches the registration's stored event_id. The check fires BEFORE
  // step 2 (pseudonymised guard) and BEFORE any lock acquisition /
  // audit emission / DB mutation, so a misrouted URL fails with no
  // side effects. Rolls back via `runInTenantWithRollbackOnErr`.
  //
  // Callers that lack a URL-path eventId pass `null` (e.g., a future
  // bulk-relink endpoint); the check is skipped in that case.
  if (
    input.eventIdFromPath !== null &&
    input.eventIdFromPath !== registration.eventId
  ) {
    return err({
      kind: 'event_path_mismatch',
      registrationId: input.registrationId,
      eventIdInPath: input.eventIdFromPath,
      eventIdOnRegistration: registration.eventId,
    });
  }

  // (2) Pseudonymisation pre-check (FR-014 round-2 R4)
  if (isPseudonymised(registration)) {
    return err({
      kind: 'pseudonymised_row_rejected',
      registrationId: input.registrationId,
    });
  }

  // (3) Load event
  const eventLookup = await deps.eventsRepo.findById(
    input.tenantId,
    registration.eventId,
  );
  if (!eventLookup.ok) {
    return err({
      kind: 'events_repo_error',
      message: eventsRepoErrorMessage(eventLookup.error),
      cause: eventLookup.error,
    });
  }
  const event = eventLookup.value;
  if (!event) {
    return err({ kind: 'event_not_found', eventId: registration.eventId });
  }
  if (event.archivedAt !== null) {
    return err({ kind: 'event_archived', eventId: registration.eventId });
  }

  // (4) Same-member short-circuit
  const previousMatchedMemberId = registration.match.matchedMemberId;
  if (
    previousMatchedMemberId !== null &&
    previousMatchedMemberId === input.newMatchedMemberId
  ) {
    return ok({
      noop: true,
      registrationId: input.registrationId,
      matchedMemberId: previousMatchedMemberId,
    });
  }

  const previousMatchType = registration.match.type;
  const previousQuotaEffect = registration.quotaEffect;
  const fiscalYear = deriveFiscalYear(
    event.startDate.toISOString(),
    F6_FISCAL_YEAR_START_MONTH,
  );

  const baseAudit = {
    tenantId: input.tenantId,
    actorType: 'admin' as const,
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
  };

  // (4b) Deadlock-safe lock acquisition. The relink touches TWO members
  // (OLD + NEW) on the same event so two concurrent relinks of the
  // form `A→B` and `B→A` could otherwise deadlock — thread1 holds
  // OLD=A waiting for NEW=B, thread2 holds OLD=B waiting for NEW=A.
  // Acquire BOTH locks upfront sorted by `LockKey` string order so
  // concurrent threads always queue on the same lock first.
  //
  // Same _principle_ as archive-event's `ORDER BY matched_member_id
  // ASC` SELECT — but a different mechanism: archive sorts at the SQL
  // layer over N rows × ONE lock per row; relink sorts TWO branded
  // `LockKey` strings in-process via `Array.sort`. Post-#8 the keys are
  // `eventcreate-quota:{tenant}:{member}:{year}` — both keys share the
  // same tenant + year, so they differ (and sort) on the member-id
  // segment, which is exactly the deadlock-order guarantee we need
  // (OLD vs NEW member on the same event/year).
  //
  // The OLD lock is only required when credit-back work is going to
  // happen (counted=true on OLD); skip it otherwise so non_member /
  // unmatched relinks acquire only one lock. The same-member
  // short-circuit above guarantees OLD ≠ NEW when both are computed.
  //
  // `oldMemberToCreditBack` collapses the null check + counted-flag
  // check into a single `MemberId | null` so TS narrowing flows
  // through subsequent uses without `!` non-null assertions.
  const oldMemberToCreditBack: MemberId | null =
    previousMatchedMemberId !== null &&
    (previousQuotaEffect.countedAgainstPartnership ||
      previousQuotaEffect.countedAgainstCulturalQuota)
      ? previousMatchedMemberId
      : null;
  const lockKeys: LockKey[] = [];
  if (oldMemberToCreditBack !== null) {
    lockKeys.push(
      // #8 — year-scoped quota lock (was per-event).
      buildQuotaLockKey(input.tenantId, oldMemberToCreditBack, fiscalYear),
    );
  }
  lockKeys.push(
    buildQuotaLockKey(input.tenantId, input.newMatchedMemberId, fiscalYear),
  );
  // String-compare sort on the branded LockKey; `Array.prototype.sort`
  // preserves the element brand at the type level because the array
  // typing is `LockKey[]` from the start. Sorted-key acquisition
  // guarantees the deadlock-safe order regardless of caller-side
  // member ordering.
  lockKeys.sort();
  for (const key of lockKeys) {
    try {
      await deps.advisoryLockAcquirer.acquire(key);
    } catch (e) {
      return err(wrapLockFailure(e));
    }
  }

  // (5) Credit-back OLD member's counted scopes (if any).
  let creditedBackPartnership = false;
  let creditedBackCultural = false;
  if (oldMemberToCreditBack !== null) {
    const oldLookup = await deps.quotaAccountingPort.queryAllotments({
      tenantId: input.tenantId,
      memberId: oldMemberToCreditBack,
      eventId: registration.eventId,
      fiscalYear,
    });
    if (!oldLookup.ok) {
      // The OLD member SHOULD always be resolvable — we read it from
      // the registration row's FK. If queryAllotments cannot find them
      // it indicates either (a) the member was hard-deleted while a
      // counted registration still referenced them (FK should have
      // prevented this) or (b) a transient DB blip. Either way, this
      // is a 500 / runbook-page event, not a 404 to the admin.
      return err({
        kind: 'quota_lookup_failed',
        message: `relink credit-back ${quotaAccountingErrorMessage(oldLookup.error)}`,
        cause: oldLookup.error,
      });
    }
    const { allotments: oldAllotments, consumed: oldConsumed } = oldLookup.value;

    if (previousQuotaEffect.countedAgainstPartnership) {
      // After credit-back the OLD row no longer counts → consumed
      // drops by 1 → allotmentAfter = allotment - (consumed - 1).
      // R6.W / Round 5 staff-review R019 closure — `Math.max(0, ...)`
      // defends against a hypothetical regression where a row has
      // `counted_against_partnership=true` but `consumed=0` (e.g., a
      // race condition that double-decremented and crashed mid-flush).
      // Without the guard the audit would emit `allotment + 1`.
      const allotmentAfter =
        oldAllotments.partnershipPerEvent -
        Math.max(0, oldConsumed.partnershipConsumedForEvent - 1);
      const r = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'partnership',
        action: 'credit_back',
        registrationId: input.registrationId,
        memberId: oldMemberToCreditBack,
        eventId: registration.eventId,
        allotmentAfter,
        fiscalYear,
      });
      if (!r.ok) return err(r.error);
      creditedBackPartnership = true;
    }

    if (previousQuotaEffect.countedAgainstCulturalQuota) {
      // R6.W / R019 — same defensive Math.max guard as partnership branch.
      const allotmentAfter =
        oldAllotments.culturalPerYear -
        Math.max(0, oldConsumed.culturalConsumedForYear - 1);
      const r = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'cultural',
        action: 'credit_back',
        registrationId: input.registrationId,
        memberId: oldMemberToCreditBack,
        eventId: registration.eventId,
        allotmentAfter,
        fiscalYear,
      });
      if (!r.ok) return err(r.error);
      creditedBackCultural = true;
    }
  }

  // (6) Decide NEW member quota effect. The NEW member's advisory lock
  // was already acquired in step (4b) in deadlock-safe sorted order.
  // queryAllotments doubles as the new-member existence check. A
  // `member_not_found` or `plan_not_found` outcome is mapped to
  // `new_member_not_found` so the admin sees a clean 404 instead of
  // an FK-violation 500 from updateMatchAndQuota downstream.
  const newLookup = await deps.quotaAccountingPort.queryAllotments({
    tenantId: input.tenantId,
    memberId: input.newMatchedMemberId,
    eventId: registration.eventId,
    fiscalYear,
  });
  if (!newLookup.ok) {
    if (
      newLookup.error.kind === 'member_not_found' ||
      newLookup.error.kind === 'plan_not_found'
    ) {
      return err({
        kind: 'new_member_not_found',
        memberId: input.newMatchedMemberId,
      });
    }
    return err({
      kind: 'quota_lookup_failed',
      message: `relink decrement ${quotaAccountingErrorMessage(newLookup.error)}`,
      cause: newLookup.error,
    });
  }
  const { allotments: newAllotments, consumed: newConsumed } = newLookup.value;

  // Decide flags scope-by-scope. The NEW row has not been counted yet
  // (it is the same registration_id but with new matched_member_id), so
  // we compare `consumed < allotment` directly without an
  // exclude-self offset (the row currently counts against the OLD
  // member, not the new one).
  let decrementedPartnership = false;
  let decrementedCultural = false;
  let nextPartnership = false;
  let nextCultural = false;

  // #13 — gate the NEW-member decrement on a `paid|free` ticket, matching
  // the ingest allowlist (`QUOTA_COUNTED_STATUSES` in
  // process-attendee-in-tx). Relinking a refunded/pending/waitlisted/
  // no_show seat must NOT consume a benefit ticket for a non-confirmed
  // seat (SC-004 / FR-018). When the seat does not count, both scope flags
  // stay false and NO quota audit is emitted for the new side — the relink
  // is quota-NEUTRAL, not over-quota. Step 5 (OLD-member credit-back) is
  // deliberately left ungated: it credits back on the row's PRIOR counted
  // flags regardless of the current payment status.
  const seatCountsTowardQuota = isQuotaCountedStatus(
    registration.ticket.paymentStatus,
  );

  if (event.isPartnerBenefit && seatCountsTowardQuota) {
    if (newConsumed.partnershipConsumedForEvent < newAllotments.partnershipPerEvent) {
      nextPartnership = true;
      // R8.W / Staff R3 R053 — replaced silent Math.max(0, ...) with an
      // observable invariant assertion. Outer if-guard at line 555
      // ensures `consumed < perEvent`, so `perEvent - (consumed + 1)`
      // is always ≥ 0. If a future guard regression flipped `<` → `<=`,
      // the previous Math.max would silently produce `allotmentAfter:
      // 0` — structurally indistinguishable from a legitimate
      // `over_quota` audit row. Throwing instead surfaces the violation
      // as an unhandled exception caught by the relink route's outer
      // try-catch (pino-serialised) and the cron handler's per-tenant
      // error counter, turning silent absorption into an alertable
      // signal. Math.max removed — defense-in-depth lives at the
      // application-level invariant boundary.
      const naturalAllotment =
        newAllotments.partnershipPerEvent -
        (newConsumed.partnershipConsumedForEvent + 1);
      if (naturalAllotment < 0) {
        throw new Error(
          `F6 invariant violation (relinkRegistration / partnership scope): naturalAllotment=${naturalAllotment} ` +
            `(perEvent=${newAllotments.partnershipPerEvent}, consumedAfter=${newConsumed.partnershipConsumedForEvent + 1}) — ` +
            `outer if-guard at relink-registration.ts:555 should make this unreachable. Suspect guard regression.`,
        );
      }
      const allotmentAfter = naturalAllotment;
      const r = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'partnership',
        action: 'decremented',
        registrationId: input.registrationId,
        memberId: input.newMatchedMemberId,
        eventId: registration.eventId,
        allotmentAfter,
        fiscalYear,
      });
      if (!r.ok) return err(r.error);
      decrementedPartnership = true;
    } else {
      const r = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'partnership',
        action: 'over_quota',
        registrationId: input.registrationId,
        memberId: input.newMatchedMemberId,
        eventId: registration.eventId,
        allotmentAfter: 0,
        fiscalYear,
      });
      if (!r.ok) return err(r.error);
    }
  }

  if (event.isCulturalEvent && seatCountsTowardQuota) {
    if (newConsumed.culturalConsumedForYear < newAllotments.culturalPerYear) {
      nextCultural = true;
      // R8.W / Staff R3 R053 — same observable invariant pattern as the
      // partnership branch above. See the partnership-branch comment for
      // rationale (silent Math.max → throw-on-invariant for alertability).
      const naturalAllotment =
        newAllotments.culturalPerYear -
        (newConsumed.culturalConsumedForYear + 1);
      if (naturalAllotment < 0) {
        throw new Error(
          `F6 invariant violation (relinkRegistration / cultural scope): naturalAllotment=${naturalAllotment} ` +
            `(perYear=${newAllotments.culturalPerYear}, consumedAfter=${newConsumed.culturalConsumedForYear + 1}) — ` +
            `outer if-guard at relink-registration.ts:592 should make this unreachable. Suspect guard regression.`,
        );
      }
      const allotmentAfter = naturalAllotment;
      const r = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'cultural',
        action: 'decremented',
        registrationId: input.registrationId,
        memberId: input.newMatchedMemberId,
        eventId: registration.eventId,
        allotmentAfter,
        fiscalYear,
      });
      if (!r.ok) return err(r.error);
      decrementedCultural = true;
    } else {
      const r = await emitQuotaScopeAudit(deps.audit, baseAudit, {
        scope: 'cultural',
        action: 'over_quota',
        registrationId: input.registrationId,
        memberId: input.newMatchedMemberId,
        eventId: registration.eventId,
        allotmentAfter: 0,
        fiscalYear,
      });
      if (!r.ok) return err(r.error);
    }
  }

  // (7) Persist the match + quota change atomically.
  const nextMatch: MatchResolution = {
    type: 'member_contact',
    matchedMemberId: input.newMatchedMemberId,
    matchedContactId: null,
  };
  const nextQuotaEffect: QuotaEffect = {
    countedAgainstPartnership: nextPartnership,
    countedAgainstCulturalQuota: nextCultural,
  };
  const updated = await deps.registrationsRepo.updateMatchAndQuota(
    input.tenantId,
    input.registrationId,
    nextMatch,
    nextQuotaEffect,
  );
  if (!updated.ok) {
    // The DB-layer pseudonymised guard can fire here if a concurrent
    // pseudonymisation sweep landed between step 2 and step 7. The
    // discriminator `pseudonymised_row_rejected` is preserved through
    // the registrations_repo_error wrapper but we promote it to the
    // top-level kind so the route handler maps to 409 (same as the
    // step-2 pre-check) instead of a generic 500. This keeps the
    // FR-014 round-2 R4 admin UX consistent across both code paths.
    if (updated.error.kind === 'pseudonymised_row_rejected') {
      return err({
        kind: 'pseudonymised_row_rejected',
        registrationId: input.registrationId,
      });
    }
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(updated.error),
      cause: updated.error,
    });
  }

  // (8) Macro `registration_relinked` audit.
  const scopes: Array<'partnership' | 'cultural'> = [];
  if (creditedBackPartnership || decrementedPartnership) scopes.push('partnership');
  if (creditedBackCultural || decrementedCultural) scopes.push('cultural');

  const quotaImpact: RelinkQuotaImpact = {
    creditedBackFor:
      creditedBackPartnership || creditedBackCultural
        ? previousMatchedMemberId
        : null,
    decrementedFor:
      decrementedPartnership || decrementedCultural
        ? input.newMatchedMemberId
        : null,
    scopes,
  };

  const macroResult = await safeAuditEmit(deps.audit, {
    eventType: 'registration_relinked',
    tenantId: input.tenantId,
    actorType: 'admin',
    actorUserId: input.actorUserId,
    occurredAt: input.occurredAt,
    summary: `registration ${input.registrationId} relinked by admin ${input.actorUserId}: ${previousMatchType}→member_contact, ${previousMatchedMemberId ?? 'none'}→${input.newMatchedMemberId} (scopes touched: ${scopes.join(',') || 'none'})`,
    payload: {
      severity: 'info',
      actorUserId: input.actorUserId,
      registrationId: input.registrationId,
      previousMatchedMemberId,
      newMatchedMemberId: input.newMatchedMemberId,
      previousMatchType,
      newMatchType: 'member_contact',
      quotaImpact,
    },
  });
  if (!macroResult.ok) {
    return err(wrapAuditEmitFailure(macroResult.error));
  }

  return ok({
    noop: false,
    registrationId: input.registrationId,
    previousMatchedMemberId,
    newMatchedMemberId: input.newMatchedMemberId,
    previousMatchType,
    newMatchType: 'member_contact',
    quotaImpact,
    registration: updated.value,
  });
}
