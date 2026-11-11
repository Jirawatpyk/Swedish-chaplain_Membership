/**
 * #732 — the event-fee picker's server search: the shared
 * `@/hooks/use-event-search` (#89) with each result shaped as the picker's
 * option ("name (Bangkok date)").
 */
'use client';

import { useMemo } from 'react';
import { useEventSearch as useSharedEventSearch, type EventSearch as SharedEventSearch } from '@/hooks/use-event-search';
import { toEventOption } from '../_lib/event-options';
import type { EventOption } from './event-fee-form';

export { EVENT_SEARCH_MAX_CHARS, EVENT_SEARCH_PAGE_SIZE } from '@/hooks/use-event-search';

export interface EventSearch extends Omit<SharedEventSearch, 'results'> {
  /** Server results for exactly `typed`, as picker options; empty until they arrive. */
  readonly results: readonly EventOption[];
}

/**
 * @param startedOnOrBefore the oldest preloaded event's start, or `null` when
 *   every event is preloaded (no server search).
 */
export function useEventSearch(startedOnOrBefore: string | null): EventSearch {
  const search = useSharedEventSearch(startedOnOrBefore);
  const results = useMemo(
    () =>
      search.results.map((e) => toEventOption({ eventId: e.eventId, name: e.name, startDateIso: e.startDate })),
    [search.results],
  );
  return { ...search, results };
}
