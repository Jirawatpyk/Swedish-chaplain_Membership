'use client';

/**
 * F9 US5 (T083) — directory search filters with URL-state sync (FR-024).
 *
 * The URL is the source of truth (bookmarkable): the keyword input debounces
 * 300 ms; the "listed only" checkbox commits immediately. Any change resets
 * `page` so pagination restarts. Mirrors the `<AuditFilters>` pattern.
 */

// 122 US5a (T506) — AURA FilterBar (board `Admin-directory`): the search and
// the "Listed only" checkbox; the URL (`q`, `listed`, `page`) is unchanged.

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AuraProvider, Button, Checkbox, FilterBar } from '@jirawatpyk/aura-react';

const DEBOUNCE_MS = 300;

export function DirectorySearchFilters(): React.JSX.Element {
  const t = useTranslations('admin.directory.search');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const currentQ = searchParams.get('q') ?? '';
  const listedOnly = searchParams.get('listed') === 'true';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      params.delete('page');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  // The FilterBar keeps the typed draft; it rewrites the box from `search`
  // only when `search` differs from what it last sent. The URL carries the
  // TRIMMED query, so while the box is focused hand back exactly what it sent;
  // unfocused (back/forward, a shared link), the URL wins.
  const [sentQ, setSentQ] = useState(currentQ);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const isSearchInput = (el: EventTarget) =>
    el instanceof HTMLInputElement && el.type === 'search';

  const hasAny = currentQ !== '' || listedOnly;
  // Clear remounts the FilterBar: it keeps the typed text and its own
  // debounce timer, so a query typed just before Clear would otherwise come
  // back when the timer fires. The new search box takes focus (Clear itself
  // unmounts).
  const [barKey, setBarKey] = useState(0);
  const barWrapRef = useRef<HTMLDivElement>(null);
  const clearAll = () => {
    setSentQ('');
    setBarKey((k) => k + 1);
    pushUrl({ q: null, listed: null });
    setTimeout(() => barWrapRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus(), 0);
  };

  const barStrings = useMemo(() => ({ clearFilters: t('clear') }), [t]);

  return (
    <div
      ref={barWrapRef}
      onFocus={(e) => {
        if (isSearchInput(e.target)) setIsSearchFocused(true);
      }}
      onBlur={(e) => {
        if (isSearchInput(e.target)) setIsSearchFocused(false);
      }}
    >
      <AuraProvider strings={barStrings}>
        <FilterBar
          key={barKey}
          label={t('label')}
          // The search fills the row beside "Listed only", as on the board.
          searchGrow
          search={isSearchFocused ? sentQ : currentQ}
          onSearchChange={(value) => {
            setSentQ(value);
            pushUrl({ q: value.trim() || null });
          }}
          searchDelay={DEBOUNCE_MS}
          searchLabel={t('label')}
          searchPlaceholder={t('placeholder')}
        >
          <Checkbox
            checked={listedOnly}
            onChange={(checked) => pushUrl({ listed: checked ? 'true' : null })}
          >
            {t('listedOnly')}
          </Checkbox>
          {hasAny && (
            <Button variant="ghost" size="sm" icon="x" onClick={clearAll}>
              {t('clear')}
            </Button>
          )}
        </FilterBar>
      </AuraProvider>
    </div>
  );
}
