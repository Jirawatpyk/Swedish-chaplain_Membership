/**
 * T057 — `listEvents` use-case (F6 Application — Phase 4).
 *
 * Returns a paginated list of imported events for the admin events list
 * surface (FR-020 / US2 AS1). Composes three port calls:
 *
 *   1. `eventsRepo.list(...)`               — paginated rows + total count
 *   2. `eventsRepo.getMatchCountsByEventIds(...)` — batched match aggregates
 *   3. `eventsRepo.getEmptyContext(tenantId)` — 3-variant empty-state hints
 *
 * The repo is invoked OUTSIDE the use-case via `runInTenant(ctx, fn)` in
 * the composition root (`src/lib/events-admin-deps.ts`). The use-case
 * itself is framework-agnostic per Constitution Principle III.
 *
 * Output envelope shape matches `contracts/admin-events-api.md § GET list`
 * verbatim — UI consumers and the route handler share the same DTO.
 *
 * Spec authority:
 *   - FR-020 (events list + match-rate + sort + filters + 3-variant empty)
 *   - US2 AS1 (Date / Name / Category / Registrations / Partner Benefit / Match Rate)
 *   - US2 AS5 (3-variant empty state: integrationConfigured /
 *              everReceivedDelivery / totalArchived)
 *   - contracts/admin-events-api.md § GET /api/admin/events
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type { EventId } from '../../domain/branded-types';
import { computeMatchRatePct } from '../../domain/match-rate';

export interface ListEventsInput {
  readonly tenantId: TenantId;
  readonly page: number;
  readonly pageSize: number;
  readonly includeArchived: boolean;
  readonly partnerBenefitOnly: boolean;
  readonly culturalEventOnly: boolean;
  readonly categoryFilter: string | null;
}

export interface ListEventsItem {
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
  // M1 fix: `eventcreateUrl` retained
  // because `contracts/admin-events-api.md` example envelope includes
  // it; future smart-feature work may surface it as an inline icon
  // link on the list row. Currently consumed only by the detail
  // header — kept for contract-stability.
  readonly eventcreateUrl: string | null;
}

export interface ListEventsPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
}

export interface ListEventsEmptyStateContext {
  readonly integrationConfigured: boolean;
  readonly everReceivedDelivery: boolean;
  readonly totalArchived: number;
}

export interface ListEventsOutput {
  readonly items: ReadonlyArray<ListEventsItem>;
  readonly pagination: ListEventsPagination;
  readonly emptyStateContext: ListEventsEmptyStateContext;
}

export interface ListEventsDeps {
  readonly eventsRepo: EventsRepository;
}

export type ListEventsError = EventsRepositoryError;

export async function listEvents(
  deps: ListEventsDeps,
  input: ListEventsInput,
): Promise<Result<ListEventsOutput, ListEventsError>> {
  const offset = (input.page - 1) * input.pageSize;

  const listResult = await deps.eventsRepo.list({
    tenantId: input.tenantId,
    includeArchived: input.includeArchived,
    partnerBenefitOnly: input.partnerBenefitOnly,
    culturalEventOnly: input.culturalEventOnly,
    categoryFilter: input.categoryFilter,
    offset,
    pageSize: input.pageSize,
  });
  if (!listResult.ok) return err(listResult.error);

  const { items: events, totalCount } = listResult.value;

  // Empty-state context is always returned (the contract requires it
  // even when items.length > 0 so paginated views landing on empty
  // pages can render context-aware empty UI).
  const emptyContextResult = await deps.eventsRepo.getEmptyContext(
    input.tenantId,
  );
  if (!emptyContextResult.ok) return err(emptyContextResult.error);
  const emptyStateContext = emptyContextResult.value;

  // Skip the match-counts roundtrip when the page has no rows — saves
  // an unnecessary index scan on the empty-state path.
  //
  // E7: when getMatchCountsByEventIds fails
  // the use-case currently propagates `err` → API 500 → page renders
  // generic error. The display layer DOES support `total = 0 → 0` /
  // "—" rendering. Choice is intentional — FR-020 implies match-rate
  // is a required column, so partial render is semantically wrong
  // (admin would see "—" and think "no attendees" when in fact the
  // count query failed). Loud-over-silent on this surface.
  let matchCountsMap: ReadonlyMap<
    EventId,
    { totalRegistrations: number; matchedRegistrations: number }
  > = new Map();
  if (events.length > 0) {
    const eventIds = events.map((e) => e.eventId);
    const countsResult = await deps.eventsRepo.getMatchCountsByEventIds(
      input.tenantId,
      eventIds,
    );
    if (!countsResult.ok) return err(countsResult.error);
    matchCountsMap = countsResult.value;
  }

  const items: ListEventsItem[] = events.map((e) => {
    const counts = matchCountsMap.get(e.eventId) ?? {
      totalRegistrations: 0,
      matchedRegistrations: 0,
    };
    return {
      eventId: e.eventId,
      name: e.name,
      startDate: e.startDate.toISOString(),
      category: e.category,
      totalRegistrations: counts.totalRegistrations,
      matchedRegistrations: counts.matchedRegistrations,
      matchRatePct: computeMatchRatePct(
        counts.matchedRegistrations,
        counts.totalRegistrations,
      ),
      isPartnerBenefit: e.isPartnerBenefit,
      isCulturalEvent: e.isCulturalEvent,
      archivedAt: e.archivedAt ? e.archivedAt.toISOString() : null,
      eventcreateUrl: e.eventcreateUrl,
    };
  });

  return ok({
    items,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      totalCount,
    },
    emptyStateContext,
  });
}
