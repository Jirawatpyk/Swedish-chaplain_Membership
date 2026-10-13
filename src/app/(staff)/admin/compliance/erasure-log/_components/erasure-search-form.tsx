'use client';

/**
 * Erasure-log UX enhancement — Task 5: `ErasureSearchForm`.
 *
 * Searches the erasure log by member number, beside `ErasureFilterTabs`. A
 * search writes `/admin/compliance/erasure-log?q=…` (plus the current
 * `status`), which the page re-renders server-side. `status=all` and an empty
 * search are left out of the URL.
 *
 * Spec 122 US10b (T1015; maintainer, 13 Oct): the search looks and behaves
 * like every other list's — the AURA `FilterBar` search, its name read out
 * but not shown above the box, the hint inside it, its own × to clear, and no
 * Search button. It searches 300 ms after typing stops and at once on Enter.
 * The bar's region keeps AURA's own name ("Filters"), so the search's name is
 * read once (R43).
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FilterBar } from '@jirawatpyk/aura-react';

const BASE = '/admin/compliance/erasure-log';

/** The log's URL for a status and a search, `status=all` and an empty search left out. */
function searchHref(status: string, q: string): string {
  const params = new URLSearchParams();
  if (status !== 'all') params.set('status', status);
  if (q !== '') params.set('q', q);
  const query = params.toString();
  return query ? `${BASE}?${query}` : BASE;
}

export function ErasureSearchForm({
  status,
  q,
}: {
  readonly status: string;
  readonly q: string;
}): React.JSX.Element {
  const t = useTranslations('admin.compliance.erasureLog');
  const router = useRouter();

  return (
    <FilterBar
      search={q}
      onSearchChange={(value) => router.replace(searchHref(status, value.trim()), { scroll: false })}
      searchLabel={t('search.label')}
      searchPlaceholder={t('search.placeholder')}
      className="w-full sm:w-72"
    />
  );
}
