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
/** The list route's `q` limit; longer text is searched as its first 100. */
export const EVENT_SEARCH_MAX_CHARS = 100;
/** Enough to pick from without paging; the newest first, as the list route orders. */
export const EVENT_SEARCH_PAGE_SIZE = 25;

const SearchResponseSchema = z.object({
  items: z.array(z.object({ eventId: z.string(), name: z.string(), startDate: z.string() })),
});

export interface EventSearch {
  /** Hand to the Combobox's `onSearch`. */
  readonly onSearch: (text: string) => void;
  /** Forget the typed text — AURA clears its own on a pick, blur or close and does not call `onSearch('')`. */
  readonly reset: () => void;
  /** The trimmed text as typed (not debounced, capped). */
  readonly typed: string;
  /** Results for the last finished search; empty while nothing is typed. */
  readonly results: readonly EventOption[];
  /** From the first keystroke until the matching search finishes. */
  readonly loading: boolean;
  readonly failed: boolean;
}

export function useEventSearch(): EventSearch {
  const [rawText, setRawText] = useState('');
  // A retry after a failure re-sends the same text, so the attempt is part of
  // what is debounced (otherwise the effect never runs again).
  const [attempt, setAttempt] = useState(0);
  const typed = rawText.trim().slice(0, EVENT_SEARCH_MAX_CHARS);
  const debounced = useDebouncedValue(`${attempt}\u0000${typed}`, DEBOUNCE_MS);
  const query = debounced.slice(debounced.indexOf('\u0000') + 1);
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
  }, [query, debounced]);

  return {
    onSearch: (text: string) => {
      if (failed) setAttempt((a) => a + 1);
      setRawText(text);
    },
    reset: () => setRawText(''),
    typed,
    results: query === '' ? [] : results,
    loading: typed !== '' && (searching || typed !== query),
    failed: typed !== '' && failed,
  };
}
