/**
 * T058 — `loadEventDetail` use-case (F6 Application — Phase 4).
 *
 * Returns event metadata + paginated attendee table for the admin event
 * detail surface (FR-021 / US2 AS2-AS4). Composes:
 *
 *   1. `eventsRepo.findById(tenantId, eventId)`   — event metadata
 *   2. `registrationsRepo.findByEventId(...)`      — paginated attendees +
 *                                                    full-event match counts
 *
 * Cross-tenant probe handling: `findById` returns `null` on a
 * tenant-mismatched id (RLS blocks the read). The use-case returns
 * `not_found` so the route handler renders a bare 404 (FR-035 surface
 * disclosure prevention — never leak whether the row exists for another
 * tenant).
 *
 * Output envelope matches `contracts/admin-events-api.md § GET detail`
 * verbatim — UI + route handler share the DTO.
 *
 * Spec authority:
 *   - FR-021 (event detail + paginated attendees + filters)
 *   - US2 AS2 (Match rate: NN% (M of N) header + attendee row shape)
 *   - US2 AS3 (View on EventCreate deep-link)
 *   - US2 AS4 (Show unmatched only + matchTypeFilter + q substring)
 *   - contracts/admin-events-api.md § GET /api/admin/events/{eventId}
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId, MemberId, ContactId } from '@/modules/members';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type {
  RegistrationsRepository,
  RegistrationsRepositoryError,
} from '../ports/registrations-repository';
import type { EventId, RegistrationId } from '../../domain/branded-types';
import type { MatchType } from '../../domain/value-objects/match-type';
import type { PaymentStatus } from '../../domain/value-objects/payment-status';
import { isNonQuotaMatchType } from '../../domain/value-objects/match-type';

export interface LoadEventDetailInput {
  readonly tenantId: TenantId;
  readonly eventId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly unmatchedOnly: boolean;
  readonly matchTypeFilter: MatchType | null;
  readonly q: string | null;
}

export interface EventDetailItem {
  readonly eventId: EventId;
  readonly name: string;
  readonly startDate: string;
  readonly category: string | null;
  readonly totalRegistrations: number;
  readonly matchedRegistrations: number;
  readonly matchRatePct: number;
  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;
  readonly archivedAt: string | null;
  readonly eventcreateUrl: string | null;
}

export interface EventDetailRegistration {
  readonly registrationId: RegistrationId;
  readonly attendeeEmail: string;
  readonly attendeeName: string;
  readonly attendeeCompany: string | null;
  readonly matchType: MatchType;
  readonly matchedMemberId: MemberId | null;
  readonly matchedContactId: ContactId | null;
  readonly ticketType: string | null;
  readonly ticketPriceThb: number | null;
  readonly paymentStatus: PaymentStatus;
  readonly countedAgainstPartnership: boolean;
  readonly countedAgainstCulturalQuota: boolean;
  readonly isOverQuota: boolean;
  readonly registeredAt: string;
}

export interface EventDetailPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
}

export interface LoadEventDetailOutput {
  readonly event: EventDetailItem;
  readonly registrations: ReadonlyArray<EventDetailRegistration>;
  readonly pagination: EventDetailPagination;
}

export type LoadEventDetailError =
  | { readonly kind: 'not_found' }
  | EventsRepositoryError
  | RegistrationsRepositoryError;

export interface LoadEventDetailDeps {
  readonly eventsRepo: EventsRepository;
  readonly registrationsRepo: RegistrationsRepository;
}

function computeMatchRatePct(matched: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((matched / total) * 1000) / 10;
}

export async function loadEventDetail(
  deps: LoadEventDetailDeps,
  input: LoadEventDetailInput,
): Promise<Result<LoadEventDetailOutput, LoadEventDetailError>> {
  // Cross-tenant probe boundary — findById returns null when the row
  // does not exist (or exists in another tenant blocked by RLS).
  const eventResult = await deps.eventsRepo.findById(
    input.tenantId,
    input.eventId as EventId,
  );
  if (!eventResult.ok) return err(eventResult.error);
  const event = eventResult.value;
  if (event === null) return err({ kind: 'not_found' });

  const offset = (input.page - 1) * input.pageSize;
  const regsResult = await deps.registrationsRepo.findByEventId({
    tenantId: input.tenantId,
    eventId: event.eventId,
    unmatchedOnly: input.unmatchedOnly,
    matchTypeFilter: input.matchTypeFilter,
    emailSearch: input.q,
    offset,
    pageSize: input.pageSize,
  });
  if (!regsResult.ok) return err(regsResult.error);

  // Aggregate counters — derived from the full-event match counts
  // (NOT filtered) so the detail header's "Match rate: NN% (M of N)"
  // reflects the event as a whole, matching AS2 verbatim.
  const counts = regsResult.value.matchCounts;
  const totalRegistrations =
    counts.memberContact +
    counts.memberDomain +
    counts.memberFuzzy +
    counts.nonMember +
    counts.unmatched;
  const matchedRegistrations =
    counts.memberContact + counts.memberDomain + counts.memberFuzzy;

  const eventDto: EventDetailItem = {
    eventId: event.eventId,
    name: event.name,
    startDate: event.startDate.toISOString(),
    category: event.category,
    totalRegistrations,
    matchedRegistrations,
    matchRatePct: computeMatchRatePct(matchedRegistrations, totalRegistrations),
    isPartnerBenefit: event.isPartnerBenefit,
    isCulturalEvent: event.isCulturalEvent,
    archivedAt: event.archivedAt ? event.archivedAt.toISOString() : null,
    eventcreateUrl: event.eventcreateUrl,
  };

  const registrations: EventDetailRegistration[] = regsResult.value.items.map(
    (r) => ({
      registrationId: r.registrationId,
      attendeeEmail: r.attendee.email,
      attendeeName: r.attendee.name,
      attendeeCompany: r.attendee.company,
      matchType: r.match.type,
      matchedMemberId: r.match.matchedMemberId,
      matchedContactId: r.match.matchedContactId,
      ticketType: r.ticket.type,
      ticketPriceThb: r.ticket.priceThb,
      paymentStatus: r.ticket.paymentStatus,
      countedAgainstPartnership: r.quotaEffect.countedAgainstPartnership,
      countedAgainstCulturalQuota: r.quotaEffect.countedAgainstCulturalQuota,
      // isOverQuota — a registration is "over quota" when it is a
      // non-quota match (cannot count) AND the originating event is
      // flagged as partner-benefit/cultural. Phase 6 (T085 apply-quota-
      // effect) writes the canonical flags; this derived view surfaces
      // the over-quota signal at the API layer without storing a
      // separate column.
      isOverQuota:
        (event.isPartnerBenefit || event.isCulturalEvent) &&
        isNonQuotaMatchType(r.match.type),
      registeredAt: r.registeredAt.toISOString(),
    }),
  );

  return ok({
    event: eventDto,
    registrations,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      totalCount: regsResult.value.totalCount,
    },
  });
}
