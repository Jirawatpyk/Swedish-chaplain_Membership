/**
 * #82 — server-side member search for the new-invoice membership picker.
 *
 * The page preloads `MEMBER_PRELOAD_LIMIT` members (the directory read's
 * clamp). When that preload is full, typed text is debounced (200 ms) and sent
 * to `GET /api/members?q=…&status=active,inactive`, the tenant-scoped
 * directory search (company, contact name, email, member number; LIKE
 * wildcards literal). Below a full preload every billable member is already
 * listed and nothing is fetched.
 *
 * Same contract as `use-event-search.ts` (#732): a superseded search is
 * aborted, a failed one is reported rather than shown as "no match", and each
 * outcome is kept with the text it answers.
 */
'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { toMemberOption } from '../new/_lib/member-options';
import type { MemberOption } from './invoice-form';

const DEBOUNCE_MS = 200;
/** The list route's `q` limit is 200; a company name never needs more. */
export const MEMBER_SEARCH_MAX_CHARS = 100;
export const MEMBER_SEARCH_LIMIT = 25;
const NO_RESULTS: readonly MemberOption[] = [];

const SearchResponseSchema = z.object({
  items: z.array(
    z.object({
      member_id: z.string(),
      company_name: z.string(),
      plan_id: z.string(),
      plan_year: z.number().int(),
    }),
  ),
});

/** Trimmed, and capped on code points so a surrogate pair is never split. */
function searchText(text: string): string {
  return Array.from(text.trim()).slice(0, MEMBER_SEARCH_MAX_CHARS).join('');
}

interface Outcome {
  readonly text: string;
  readonly results: readonly MemberOption[];
  readonly failed: boolean;
}

export interface MemberSearch {
  /** Hand to the Combobox's `onSearch`. */
  readonly onSearch: (text: string) => void;
  /** Forget the typed text — AURA clears its own on a pick, Escape, blur or close and does not call `onSearch('')`. */
  readonly reset: () => void;
  /** The search text as typed (trimmed, capped; not debounced). */
  readonly typed: string;
  /** Server results for exactly `typed`; empty until they arrive. */
  readonly results: readonly MemberOption[];
  /** A server search for `typed` is pending (debounce or request). */
  readonly loading: boolean;
  /** The server search for `typed` failed. */
  readonly failed: boolean;
}

export function useMemberSearch(
  enabled: boolean,
  planLabels: ReadonlyMap<string, string>,
  locale: string,
): MemberSearch {
  const [rawText, setRawText] = useState('');
  const typed = searchText(rawText);
  const query = useDebouncedValue(typed, DEBOUNCE_MS);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // "Try again" with the same text: the debounced query does not change, so
  // a retry counter re-runs the search.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!enabled || query === '') return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          status: 'active,inactive',
          limit: String(MEMBER_SEARCH_LIMIT),
        });
        const res = await fetch(`/api/members?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`member-search responded ${res.status}`);
        const parsed = SearchResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('member-search response shape invalid');
        if (cancelled) return;
        setOutcome({
          text: query,
          failed: false,
          results: parsed.data.items.map((m) =>
            toMemberOption(
              {
                memberId: m.member_id,
                companyName: m.company_name,
                planId: m.plan_id,
                planYear: m.plan_year,
              },
              planLabels,
              locale,
            ),
          ),
        });
      } catch (err: unknown) {
        // A superseded search aborts — expected, and not a failure.
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('member-search fetch failed', err);
        setOutcome({ text: query, failed: true, results: NO_RESULTS });
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, query, retry, planLabels, locale]);

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
