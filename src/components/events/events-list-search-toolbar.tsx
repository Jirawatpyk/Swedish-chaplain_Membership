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
import { useTransition, useState, useCallback } from 'react';
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

  // Escape-key clear handler (mirrors attendee-table.tsx:222-234).
  // Resets local input state AND strips `q` + `page` from the URL so
  // keyboard users have a single-key path to unfiltered.
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
        onChange={(e) => {
          const v = e.target.value;
          setSearchInput(v);
          // Native X-button clear fires onChange with v='' but does
          // NOT submit the form — strip the URL `q` inline so the
          // server table refreshes without requiring Enter (mirrors
          // attendee-table.tsx:252-274 verbatim).
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
