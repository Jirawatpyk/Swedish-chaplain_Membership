'use client';

/**
 * Erasure-log UX enhancement — Task 5: `ErasureSearchForm`.
 *
 * A plain `<form method="get">` beside `ErasureFilterTabs` that searches the
 * erasure log by member number. Submitting navigates to
 * `/admin/compliance/erasure-log?q=…` (plus the current `status`, preserved
 * via a hidden field), which the page re-renders server-side.
 *
 * The hidden `status` field only renders when `status !== 'all'` so a fresh
 * search from the "All" tab doesn't add a redundant `?status=all` to the URL.
 * The clear-search link only renders when `q !== ''` and returns to the base
 * path (preserving `status` the same way).
 *
 * Spec 122 US10b (T1015; board `Admin-erasure-log`): AURA `TextField` with
 * the board's visible label. No Search button (maintainer, 13 Oct): like
 * every other list it searches 300 ms after typing stops, and Enter searches
 * at once; the URL is the same `?status=…&q=…`. It still renders on the
 * server as the same GET form, so Enter before hydration submits too.
 */
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { TextField } from '@jirawatpyk/aura-react';

const BASE = '/admin/compliance/erasure-log';
const DEBOUNCE_MS = 300;

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
  const clearHref = searchHref(status, '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLFormElement>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  // The URL's search moved without typing here (Clear search, back/forward):
  // show it. Never while the box has focus — a search landing late would
  // overwrite what is being typed.
  useEffect(() => {
    const input = box.current?.elements.namedItem('q');
    if (!(input instanceof HTMLInputElement) || document.activeElement === input) return;
    if (input.value.trim() !== q) input.value = q;
  }, [q]);
  const go = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    router.replace(searchHref(status, value.trim()), { scroll: false });
  };

  return (
    <form
      ref={box}
      method="get"
      action={BASE}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem('q');
        go(input instanceof HTMLInputElement ? input.value : '');
      }}
      className="flex flex-wrap items-end gap-[var(--aura-space-2)]"
    >
      {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
      <TextField
        id="erasure-q"
        name="q"
        type="search"
        label={t('search.label')}
        defaultValue={q}
        placeholder={t('search.placeholder')}
        inputMode="search"
        touchHeight
        className="min-w-0 flex-1 sm:w-72 sm:flex-none"
        onChange={(e) => {
          const value = e.target.value;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => go(value), DEBOUNCE_MS);
        }}
      />
      {q !== '' ? (
        <Link
          href={clearHref}
          className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-[var(--aura-fg-accent)] max-sm:min-h-11 underline-offset-4 hover:underline"
        >
          <XIcon className="size-3.5" aria-hidden />
          {t('search.clear')}
        </Link>
      ) : null}
    </form>
  );
}
