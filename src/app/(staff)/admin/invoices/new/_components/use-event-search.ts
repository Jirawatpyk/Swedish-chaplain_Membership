/**
 * #732 — server-side event search for the event-fee picker.
 *
 * The page preloads only the newest 200 events, so an older event can only be
 * found by asking the server. Typed text is debounced (200 ms, as the member
 * pickers) and sent to `GET /api/admin/events?q=…`, a tenant-scoped name
 * search. A superseded search is aborted; a failed one is reported, not
 * shown as "no match".
 */
'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { toEventOption } from '../_lib/event-options';
import type { EventOption } from './event-fee-form';

const DEBOUNCE_MS = 200;
/** Enough to pick from without paging; the newest first, as the list route orders. */
export const EVENT_SEARCH_PAGE_SIZE = 25;

const SearchResponseSchema = z.object({
  items: z.array(z.object({ eventId: z.string(), name: z.string(), startDate: z.string() })),
});

export interface EventSearch {
  /** Hand to the Combobox's `onSearch`. */
  readonly onSearch: (text: string) => void;
  /** The trimmed text as typed (not debounced). */
  readonly typed: string;
  /** Results for the last finished search; empty while nothing is typed. */
  readonly results: readonly EventOption[];
  /** From the first keystroke until the matching search finishes. */
  readonly loading: boolean;
  readonly failed: boolean;
}

export function useEventSearch(): EventSearch {
  const [rawText, setRawText] = useState('');
  const query = useDebouncedValue(rawText.trim(), DEBOUNCE_MS);
  const [results, setResults] = useState<readonly EventOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);

  // The state flips live inside the async run, not in the effect body.
  useEffect(() => {
    if (query === '') return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      setSearching(true);
      setFailed(false);
      try {
        const params = new URLSearchParams({ q: query, pageSize: String(EVENT_SEARCH_PAGE_SIZE) });
        const res = await fetch(`/api/admin/events?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`event-search responded ${res.status}`);
        const parsed = SearchResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('event-search response shape invalid');
        if (!cancelled) {
          setResults(
            parsed.data.items.map((e) =>
              toEventOption({ eventId: e.eventId, name: e.name, startDateIso: e.startDate }),
            ),
          );
        }
      } catch (err: unknown) {
        // A superseded search aborts — expected, and not a failure.
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('event-search fetch failed', err);
        setResults([]);
        setFailed(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query]);

  const typed = rawText.trim();
  return {
    onSearch: setRawText,
    typed,
    results: query === '' ? [] : results,
    loading: typed !== '' && (searching || typed !== query),
    failed: typed !== '' && failed,
  };
}
