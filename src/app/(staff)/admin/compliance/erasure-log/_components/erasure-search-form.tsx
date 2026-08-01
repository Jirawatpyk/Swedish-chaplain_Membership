/**
 * Erasure-log UX enhancement — Task 5: `ErasureSearchForm`.
 *
 * A plain `<form method="get">` beside `ErasureFilterTabs` that searches the
 * erasure log by member number — NO client JS. Submitting navigates to
 * `/admin/compliance/erasure-log?q=…` (plus the current `status`, preserved
 * via a hidden field), which the page re-renders server-side. Mirrors the
 * "no `'use client'` needed" pattern established by `erasure-filter-tabs.tsx`.
 *
 * The hidden `status` field only renders when `status !== 'all'` so a fresh
 * search from the "All" tab doesn't add a redundant `?status=all` to the URL.
 * The clear-search link only renders when `q !== ''` and returns to the base
 * path (preserving `status` the same way).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const BASE = '/admin/compliance/erasure-log';

export function ErasureSearchForm({
  status,
  q,
}: {
  readonly status: string;
  readonly q: string;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const clearHref = status !== 'all' ? `${BASE}?status=${status}` : BASE;

  return (
    <form method="get" action={BASE} className="flex flex-wrap items-center gap-2">
      {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
      <label htmlFor="erasure-q" className="sr-only">
        {t('search.label')}
      </label>
      <Input
        id="erasure-q"
        name="q"
        type="search"
        defaultValue={q}
        placeholder={t('search.placeholder')}
        className="h-9 w-full min-w-0 sm:w-44 [&::-webkit-search-cancel-button]:appearance-none"
        inputMode="search"
      />
      <Button type="submit" variant="outline" size="sm" className="h-9">
        <SearchIcon className="size-4" aria-hidden />
        <span>{t('search.submit')}</span>
      </Button>
      {q !== '' ? (
        <Link
          href={clearHref}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          <XIcon className="size-3.5" aria-hidden />
          {t('search.clear')}
        </Link>
      ) : null}
    </form>
  );
}
