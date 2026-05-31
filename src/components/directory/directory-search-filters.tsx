'use client';

/**
 * F9 US5 (T083) — directory search filters with URL-state sync (FR-024).
 *
 * The URL is the source of truth (bookmarkable): the keyword input debounces
 * 300 ms; the "listed only" checkbox commits immediately. Any change resets
 * `page` so pagination restarts. Mirrors the `<AuditFilters>` pattern.
 */
import { useCallback, useRef, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FilterBar } from '@/components/ui/filter-bar';

const DEBOUNCE_MS = 300;

export function DirectorySearchFilters(): React.JSX.Element {
  const t = useTranslations('admin.directory.search');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const onQ = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => pushUrl({ q: value.trim() || null }), DEBOUNCE_MS);
  };

  const hasAny = currentQ !== '' || listedOnly;

  return (
    <FilterBar aria-label={t('label')}>
      <Input
        key={`q-${currentQ}`}
        defaultValue={currentQ}
        onChange={(e) => onQ(e.target.value)}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        autoComplete="off"
        className="sm:flex-1"
      />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={listedOnly}
          onCheckedChange={(c) => pushUrl({ listed: c === true ? 'true' : null })}
          aria-label={t('listedOnly')}
        />
        {t('listedOnly')}
      </label>
      {hasAny && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            pushUrl({ q: null, listed: null });
          }}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" aria-hidden />
          {t('clear')}
        </Button>
      )}
    </FilterBar>
  );
}
