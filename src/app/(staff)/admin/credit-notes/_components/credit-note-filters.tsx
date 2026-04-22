'use client';

/**
 * G-3 — Filter bar for `/admin/credit-notes` directory.
 *
 * Small client component that syncs two URL search params
 * (`?q=` for document-number substring, `?fy=` for fiscal year)
 * into the current path, with a Clear link that drops both.
 * Page navigation is reset to page=1 on any filter change.
 */
import { useCallback, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function CreditNoteFilters() {
  const t = useTranslations('admin.creditNotes.list.filters');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [q, setQ] = useState(params.get('q') ?? '');
  const [fy, setFy] = useState(params.get('fy') ?? '');

  const hasFilters = useMemo(
    () => (params.get('q') ?? '').length > 0 || (params.get('fy') ?? '').length > 0,
    [params],
  );

  const applyFilters = useCallback(
    (nextQ: string, nextFy: string) => {
      const next = new URLSearchParams(params.toString());
      if (nextQ.trim()) next.set('q', nextQ.trim());
      else next.delete('q');
      if (nextFy.trim()) next.set('fy', nextFy.trim());
      else next.delete('fy');
      // Any filter change resets paging — paged offsets from the
      // previous filter window don't map to the new result set.
      next.delete('page');
      const qs = next.toString();
      startTransition(() => {
        router.push(qs ? `${pathname}?${qs}` : pathname);
      });
    },
    [params, pathname, router],
  );

  return (
    <form
      // `data-slot="filter-bar"` activates the global mobile-only
      // `width: 100%` rule in globals.css (mirrors <FilterBar>).
      // Used directly on <form> instead of wrapping with <FilterBar>
      // because this filter submits on Apply — <FilterBar> renders a
      // <div>, and we need the native <form> submit semantics here.
      data-slot="filter-bar"
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center"
      onSubmit={(e) => {
        e.preventDefault();
        applyFilters(q, fy);
      }}
    >
      {/* Labels above inputs were removed per user feedback — the
        * placeholder ("CN-…" / "2026") plus the aria-label on each
        * Input carry the same semantics without the vertical noise
        * above the filter bar. */}
      <Input
        id="cn-filter-q"
        type="search"
        inputMode="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('search')}
        aria-label={t('search')}
        className="min-w-0 sm:flex-1"
        autoComplete="off"
      />
      <Input
        id="cn-filter-fy"
        type="number"
        inputMode="numeric"
        min="2020"
        max="2100"
        value={fy}
        onChange={(e) => setFy(e.target.value)}
        placeholder={t('fiscalYear')}
        aria-label={t('fiscalYear')}
        className="sm:w-32"
        autoComplete="off"
      />
      <Button
        type="submit"
        variant="outline"
        disabled={pending}
      >
        {t('apply')}
      </Button>
      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setQ('');
            setFy('');
            applyFilters('', '');
          }}
        >
          {t('clear')}
        </Button>
      )}
    </form>
  );
}
