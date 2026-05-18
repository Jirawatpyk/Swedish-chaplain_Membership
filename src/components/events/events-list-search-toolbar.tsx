/**
 * F6.1 follow-up 2026-05-18 — free-text search on /admin/events.
 *
 * Mirrors the `<Input type="search">` + Escape/X-clear pattern from
 * the per-event attendees table at `src/components/events/attendee-table.tsx`
 * lines 215-284. URL-driven server filter: form submit pushes `?q=…`,
 * the native X clear or Escape key strips `q` + `page` inline so the
 * server table re-renders without an explicit submit.
 *
 * Accessibility:
 *   - Form wraps the input + submit button (Enter keyboard semantic).
 *   - aria-busy on the form region while the transition is pending.
 *   - aria-label on the input + i18n placeholder.
 *   - Spinner is motion-reduce-safe.
 *
 * Client component — owns `searchInput` local state and `useTransition`
 * for the pending-spinner. Composes `next/navigation` + next-intl
 * directly; no other module dependencies.
 */
'use client';

import {
  useRouter,
  usePathname,
  useSearchParams,
} from 'next/navigation';
import {
  useTransition,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Props {
  readonly initialSearch: string;
}

export function EventsListSearchToolbar({ initialSearch }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations('admin.events.list');
  const [isPending, startTransition] = useTransition();
  const [searchInput, setSearchInput] = useState(initialSearch);
  // R3-U2 (2026-05-18 /speckit-review Round 3 Final) — focus tracking
  // for the prop-sync useEffect below. WCAG SC 3.2.2 (On Input)
  // forbids changes of context due to user input unless explicitly
  // requested. The pre-R3 useEffect overwrote in-flight typing if a
  // sibling filter chip triggered a server re-render while the user
  // was still editing the input. The ref guards the sync so external
  // URL changes only overwrite the input when the user is NOT
  // actively focused.
  const inputFocused = useRef(false);

  // R2-2a (2026-05-18 /speckit-review Round 2 Blocker) — browser Back/
  // Forward changes the URL `?q=` and re-renders the page server-side
  // with a new `initialSearch` prop, but the local state would
  // otherwise stay stale. Sync on prop change so the input mirrors
  // the URL. Mirrors the equivalent useEffect prop-sync in
  // `attendee-table.tsx` (search `useEffect(() => setSearchInput`).
  useEffect(() => {
    if (!inputFocused.current) {
      // R3-U2 + react-hooks/set-state-in-effect: URL→state sync is
      // the LEGITIMATE use of setState-in-effect (back/forward nav
      // changes the prop). The cascading render is the desired
      // behavior. useSyncExternalStore would be heavier without
      // benefit here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchInput(initialSearch);
    }
  }, [initialSearch]);

  const pushUrl = useCallback(
    (params: URLSearchParams) => {
      const url = params.toString() ? `${pathname}?${params}` : pathname;
      startTransition(() => router.push(url));
    },
    [pathname, router],
  );

  const submitSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const next = new URLSearchParams(searchParams.toString());
      const v = searchInput.trim();
      if (v === '') next.delete('q');
      else next.set('q', v);
      next.delete('page');
      pushUrl(next);
    },
    [searchInput, searchParams, pushUrl],
  );

  // Escape-key clear handler (mirrors the `handleSearchKeyDown`
  // callback in attendee-table.tsx — search `handleSearchKeyDown` for
  // the parity site). Resets local input state AND strips `q` + `page`
  // from the URL so keyboard users have a single-key path to unfiltered.
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Escape') return;
      if (searchInput === '' && !searchParams.has('q')) return;
      e.preventDefault();
      setSearchInput('');
      const next = new URLSearchParams(searchParams.toString());
      next.delete('q');
      next.delete('page');
      pushUrl(next);
    },
    [searchInput, searchParams, pushUrl],
  );

  return (
    <form
      onSubmit={submitSearch}
      // Mobile (<sm): full row width — input + submit button each
      // take their natural share without forcing horizontal scroll.
      // ≥sm: flex-1 fills the row beside the filter chips. `min-w-0`
      // on the form lets the input shrink past its content size when
      // the parent flex is constrained.
      className="flex w-full min-w-0 gap-2 sm:w-auto sm:flex-1"
      aria-busy={isPending}
    >
      <Input
        type="search"
        value={searchInput}
        onFocus={() => {
          inputFocused.current = true;
        }}
        onBlur={() => {
          inputFocused.current = false;
        }}
        onChange={(e) => {
          const v = e.target.value;
          setSearchInput(v);
          // Native X-button clear fires onChange with v='' but does
          // NOT submit the form — strip the URL `q` inline so the
          // server table refreshes without requiring Enter (mirrors
          // the `clearSearchUrl` callback in attendee-table.tsx —
          // search `clearSearchUrl` for the shared pattern).
          if (v === '' && searchParams.has('q')) {
            const next = new URLSearchParams(searchParams.toString());
            next.delete('q');
            next.delete('page');
            pushUrl(next);
          }
        }}
        onKeyDown={handleSearchKeyDown}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchLabel')}
        className="min-w-0 flex-1"
      />
      <Button type="submit" variant="outline" disabled={isPending}>
        {isPending && (
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
        )}
        {t('searchSubmit')}
      </Button>
    </form>
  );
}
