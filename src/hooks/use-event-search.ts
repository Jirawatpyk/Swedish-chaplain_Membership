/**
 * #732 / #89 — server-side event search, shared by the event-fee picker on
 * /admin/invoices/new and the CSV import's event picker.
 *
 * The page preloads only the newest 200 events, so an older event can only be
 * found by asking the server. Typed text is debounced (200 ms, as the member
 * pickers) and sent to `GET /api/admin/events?q=…`, a tenant-scoped name
 * search bounded to events starting at or before the oldest preloaded one, so
 * a recurring name ("Business Mixer") reaches past the preloaded events
 * instead of returning them again. When the page preloaded fewer than a full
 * page, every event is already listed and nothing is fetched.
 *
 * A superseded search is aborted; a failed one is reported, not shown as
 * "no match". Each outcome is kept with the text it answers, so an earlier
 * query's results or failure never show under newer text.
 */
'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

const DEBOUNCE_MS = 200;
/** The list route's `q` limit; longer text is searched as its first 100 characters. */
export const EVENT_SEARCH_MAX_CHARS = 100;
/** Enough to pick from without paging; the newest first, as the list route orders. */
export const EVENT_SEARCH_PAGE_SIZE = 25;
/** One event as the list route returns it. */
export interface EventSearchItem {
  readonly eventId: string;
  readonly name: string;
  /** ISO 8601 start. */
  readonly startDate: string;
}

const NO_RESULTS: readonly EventSearchItem[] = [];

const SearchResponseSchema = z.object({
  items: z.array(z.object({ eventId: z.string(), name: z.string(), startDate: z.string() })),
});

/** Trimmed, and capped on code points so a surrogate pair is never split. */
function searchText(text: string): string {
  return Array.from(text.trim()).slice(0, EVENT_SEARCH_MAX_CHARS).join('');
}

interface Outcome {
  readonly text: string;
  readonly results: readonly EventSearchItem[];
  readonly failed: boolean;
}

export interface EventSearch {
  /** Hand to the Combobox's `onSearch`. */
  readonly onSearch: (text: string) => void;
  /** Forget the typed text — AURA clears its own on a pick, Escape, blur or close and does not call `onSearch('')`. */
  readonly reset: () => void;
  /** The search text as typed (trimmed, capped; not debounced). */
  readonly typed: string;
  /** Server results for exactly `typed`; empty until they arrive. */
  readonly results: readonly EventSearchItem[];
  /** A server search for `typed` is pending (debounce or request). */
  readonly loading: boolean;
  /** The server search for `typed` failed. */
  readonly failed: boolean;
}

/**
 * @param startedOnOrBefore the oldest preloaded event's start, or `null` when
 *   every event is preloaded (no server search).
 */
export function useEventSearch(startedOnOrBefore: string | null): EventSearch {
  const [rawText, setRawText] = useState('');
  const typed = searchText(rawText);
  const query = useDebouncedValue(typed, DEBOUNCE_MS);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // "Try again" with the same text: the debounced query does not change, so
  // a retry counter re-runs the search.
  const [retry, setRetry] = useState(0);
  const enabled = startedOnOrBefore !== null;

  useEffect(() => {
    if (!enabled || query === '') return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: String(EVENT_SEARCH_PAGE_SIZE),
          startedOnOrBefore,
        });
        const res = await fetch(`/api/admin/events?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`event-search responded ${res.status}`);
        const parsed = SearchResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('event-search response shape invalid');
        if (cancelled) return;
        setOutcome({
          text: query,
          failed: false,
          results: parsed.data.items,
        });
      } catch (err: unknown) {
        // A superseded search aborts — expected, and not a failure.
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('event-search fetch failed', err);
        setOutcome({ text: query, failed: true, results: NO_RESULTS });
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, query, retry, startedOnOrBefore]);

  const current = enabled && typed !== '' && outcome?.text === typed ? outcome : null;
  return {
    onSearch: (text: string) => {
      if (outcome?.failed && outcome.text === searchText(text)) {
        setOutcome(null);
        setRetry((n) => n + 1);
      }
      setRawText(text);
    },
    reset: () => setRawText(''),
    typed,
    results: current?.results ?? NO_RESULTS,
    loading: enabled && typed !== '' && current === null,
    failed: current?.failed ?? false,
  };
}
