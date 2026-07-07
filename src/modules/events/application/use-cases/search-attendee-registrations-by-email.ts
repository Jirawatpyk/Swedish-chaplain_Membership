/**
 * F6 remediation PR 2.1 / P2 (FR-032a by-email erasure BACKEND) —
 * `searchAttendeeRegistrationsByEmail` read-only use-case.
 *
 * The admin by-email cross-event erasure surface needs a PREVIEW: given a data
 * subject's email, enumerate every registration sharing that email across the
 * tenant's events so the admin can confirm the set before the destructive bulk
 * erase (P3). This use-case:
 *   1. calls `registrationsRepo.findByEmailLower` (P1) — RLS-scoped exact-email
 *      enumeration; a repo error surfaces as `registrations_repo_error`.
 *   2. enriches each row's `eventId` → `{ eventName, eventStartDateIso }` via a
 *      SINGLE batched `eventDetailsBatchLookup.findByIds` (no N+1 — mirrors
 *      `runListEventNamesByIds`). A batch-lookup error DEGRADES to null
 *      name/date (non-critical enrichment), NOT a use-case error — the erasure
 *      preview must still render the registration ids so the admin can act.
 *
 * `eventStartDateIso` is the CE/UTC ISO instant (Buddhist Era is display-only;
 * storage + this view stay Gregorian — the caller renders the Bangkok-local CE
 * date). `isPseudonymised` flags rows whose PII was already retention-purged
 * (their attendee_email is a salted hash, so they never match a real email in
 * P1 — but the flag is surfaced for completeness in case a caller enumerates a
 * hashed value directly).
 *
 * Constitution Principle III: pure Application — imports Domain + its own ports
 * only. No framework / Drizzle / runInTenant imports (the composition wrapper
 * `runSearchAttendeesByEmail` in `src/lib/events-admin-deps.ts` owns the tx).
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { EventId } from '../../domain/branded-types';
import { isPseudonymised } from '../../domain/event-registration';
import type { MatchType } from '../../domain/value-objects/match-type';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type { EventsRepository } from '../ports/events-repository';
import { registrationsRepoErrorMessage } from './_helpers/repo-error-message';

export interface SearchAttendeeRegistrationsByEmailInput {
  readonly tenantId: TenantId;
  /** Caller-supplied email; matched case-insensitively (lowered by the repo). */
  readonly emailLower: string;
}

export interface AttendeeRegistrationMatch {
  readonly registrationId: string;
  readonly eventId: string;
  /** `null` when the event lookup missed / degraded (non-critical enrichment). */
  readonly eventName: string | null;
  /** CE/UTC ISO instant; `null` when the event lookup missed / degraded. */
  readonly eventStartDateIso: string | null;
  readonly matchType: MatchType;
  readonly countedPartnership: boolean;
  readonly countedCultural: boolean;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly isPseudonymised: boolean;
}

export interface SearchAttendeeRegistrationsByEmailOutput {
  readonly matches: ReadonlyArray<AttendeeRegistrationMatch>;
  /**
   * `true` when the subject has MORE registrations than the repo cap
   * (`FIND_BY_EMAIL_CAP`), so `matches` is a PARTIAL set — the preview UI must
   * warn that the list is incomplete and a follow-up sweep is required (I-1
   * review finding; propagated straight from `findByEmailLower`).
   */
  readonly truncated: boolean;
}

export type SearchAttendeeRegistrationsByEmailError = {
  readonly kind: 'registrations_repo_error';
  readonly message: string;
  readonly cause: RegistrationsRepositoryError;
};

export interface SearchAttendeeRegistrationsByEmailDeps {
  readonly registrationsRepo: Pick<RegistrationsRepository, 'findByEmailLower'>;
  readonly eventDetailsBatchLookup: Pick<EventsRepository, 'findByIds'>;
}

export async function searchAttendeeRegistrationsByEmail(
  input: SearchAttendeeRegistrationsByEmailInput,
  deps: SearchAttendeeRegistrationsByEmailDeps,
): Promise<
  Result<
    SearchAttendeeRegistrationsByEmailOutput,
    SearchAttendeeRegistrationsByEmailError
  >
> {
  const found = await deps.registrationsRepo.findByEmailLower(
    input.tenantId,
    input.emailLower,
  );
  if (!found.ok) {
    return err({
      kind: 'registrations_repo_error',
      message: registrationsRepoErrorMessage(found.error),
      cause: found.error,
    });
  }
  const { rows, truncated } = found.value;
  if (rows.length === 0) {
    // No registrations → skip the event lookup entirely (zero extra DB cost).
    // `truncated` is false here (an empty set is never capped), threaded for shape.
    return ok({ matches: [], truncated });
  }

  // ONE batched event lookup for all unique event ids (no N+1). Mirrors
  // runListEventNamesByIds: a batch-lookup error DEGRADES to an empty map so
  // the enrichment falls back to null name/date rather than failing the whole
  // preview — the registration ids MUST still surface so the admin can erase.
  const uniqueEventIds = [...new Set(rows.map((r) => r.eventId))] as EventId[];
  const detailsResult = await deps.eventDetailsBatchLookup.findByIds(
    input.tenantId,
    uniqueEventIds,
  );
  const detailsById: ReadonlyMap<
    EventId,
    { readonly name: string; readonly startDate: Date }
  > = detailsResult.ok ? detailsResult.value : new Map();

  const matches: AttendeeRegistrationMatch[] = rows.map((r) => {
    const event = detailsById.get(r.eventId);
    return {
      registrationId: String(r.registrationId),
      eventId: String(r.eventId),
      eventName: event ? event.name : null,
      eventStartDateIso: event ? event.startDate.toISOString() : null,
      matchType: r.match.type,
      countedPartnership: r.quotaEffect.countedAgainstPartnership,
      countedCultural: r.quotaEffect.countedAgainstCulturalQuota,
      attendeeName: r.attendee.name,
      attendeeEmail: String(r.attendee.email),
      isPseudonymised: isPseudonymised(r),
    };
  });

  return ok({ matches, truncated });
}
