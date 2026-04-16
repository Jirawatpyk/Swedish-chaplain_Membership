'use client';

/**
 * T066 — Directory filters with URL-state sync.
 *
 * URL is the source of truth (bookmarkable per US2 AS2). The search input
 * is uncontrolled; we debounce the commit via a ref-held timer. No local
 * state means no `set-state-in-effect` anti-pattern for the compiler to
 * flag, and the back/forward button Just Works.
 */

import { useCallback, useRef, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const DEBOUNCE_MS = 300;

export function DirectoryFilters() {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const currentQ = searchParams.get('q') ?? '';
  const showArchived = searchParams.get('show_archived') === '1';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      // Clear pagination state whenever filters change — stale page
      // number from a different filter set is meaningless (user lands
      // on page past the new last page or on a cursor from another
      // filter snapshot).
      params.delete('cursor');
      params.delete('page');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  const onSearchChange = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const onToggleArchived = (next: boolean) => {
    pushUrl({ show_archived: next ? '1' : null });
  };

  const hasAnyFilter = Boolean(currentQ) || showArchived;
  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (inputRef.current) inputRef.current.value = '';
    pushUrl({ q: null, show_archived: null });
  };

  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4"
      role="search"
    >
      <div className="relative flex-1 min-w-0">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          // `key` forces React to remount the input when the URL q changes
          // from elsewhere (e.g. back/forward) — gives us URL→input sync
          // without a useEffect that the compiler flags.
          key={currentQ}
          defaultValue={currentQ}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchSrLabel')}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      <label className="flex items-center gap-2 text-sm whitespace-nowrap cursor-pointer select-none">
        <Checkbox
          checked={showArchived}
          onCheckedChange={(v) => onToggleArchived(v === true)}
          aria-label={t('showArchived')}
        />
        <span>{t('showArchived')}</span>
      </label>

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" />
          {t('clearFilters')}
        </Button>
      )}
    </div>
  );
}
