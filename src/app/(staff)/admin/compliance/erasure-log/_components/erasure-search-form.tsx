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
 * the board's visible label and an AURA Search button. A client file only
 * because AURA's fields are; it still renders on the server as the same GET
 * form, so a search before hydration submits too.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { Button, TextField } from '@jirawatpyk/aura-react';

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
    <form
      method="get"
      action={BASE}
      role="search"
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
        className="min-w-0 flex-1 sm:w-60 sm:flex-none"
      />
      <Button type="submit" variant="secondary" icon="search" touchHeight>
        {t('search.submit')}
      </Button>
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
