'use client';

/**
 * G-U7F — Status + fiscal-year + doc-number search filter for the
 * member-page invoice section (spec US7 AS1 "sortable, filterable").
 *
 * Form-based Apply/Clear pattern matching `/admin/credit-notes`
 * (`credit-note-filters.tsx`) — three controls stage locally, URL
 * is only patched on Apply (avoids mid-typing router churn).
 *
 *   - Search (`?invQ=`) — document-number substring, ILIKE %q%
 *   - Status (`?invStatus=`) — Select, 7 values + "all"
 *   - Fiscal year (`?invYear=`) — free-text number, matches the
 *     credit-notes `fy` UX (typed is more flexible than a Select
 *     when admins paste a year from an email)
 */
import { useCallback, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Select, TextField } from '@jirawatpyk/aura-react';

const STATUSES = [
  'all',
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
  'partially_credited',
] as const;

export function MemberInvoicesFilters() {
  const t = useTranslations('admin.members.invoices.filters');
  const tStatuses = useTranslations('admin.members.invoices.statuses');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [q, setQ] = useState(params.get('invQ') ?? '');
  const [status, setStatus] = useState(params.get('invStatus') ?? 'all');
  const [year, setYear] = useState(params.get('invYear') ?? '');

  const hasFilters = useMemo(
    () =>
      (params.get('invQ') ?? '').length > 0 ||
      (params.get('invStatus') ?? 'all') !== 'all' ||
      (params.get('invYear') ?? '').length > 0,
    [params],
  );

  const applyFilters = useCallback(
    (nextQ: string, nextStatus: string, nextYear: string) => {
      const next = new URLSearchParams(params.toString());
      if (nextQ.trim()) next.set('invQ', nextQ.trim());
      else next.delete('invQ');
      if (nextStatus && nextStatus !== 'all') next.set('invStatus', nextStatus);
      else next.delete('invStatus');
      if (nextYear.trim()) next.set('invYear', nextYear.trim());
      else next.delete('invYear');
      const qs = next.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [params, pathname, router],
  );

  // Spec 122 US5b-1 — AURA fields in the same staged form: nothing applies
  // until Apply (or Enter), and the URL (`invQ`, `invStatus`, `invYear`) is
  // unchanged. Search full width on a phone, then status and year side by
  // side, then the buttons. Each field has a visible label (it had only an
  // aria-label).
  return (
    <form
      className="mb-4 flex flex-col gap-3 border-b border-[var(--aura-border-default)] pb-4 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        applyFilters(q, status, year);
      }}
    >
      <TextField
        id="member-inv-q"
        type="search"
        inputMode="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        label={t('searchLabel')}
        placeholder={t('search')}
        className="sm:min-w-[10rem] sm:flex-1"
        autoComplete="off"
      />
      <div className="grid grid-cols-2 gap-3 sm:contents">
        <Select
          label={t('statusLabel')}
          value={status}
          onChange={(e) => setStatus(e.target.value || 'all')}
          className="sm:w-44"
          options={STATUSES.map((s) => ({ value: s, label: s === 'all' ? t('status.all') : tStatuses(s) }))}
        />
        <TextField
          id="member-inv-fy"
          type="number"
          inputMode="numeric"
          min="2020"
          max="2100"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          label={t('fiscalYear')}
          className="sm:w-32"
          autoComplete="off"
        />
      </div>
      <div className={`grid gap-3 sm:contents ${hasFilters ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <Button type="submit" variant="secondary" loading={pending}>
          {t('apply')}
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setQ('');
              setStatus('all');
              setYear('');
              applyFilters('', 'all', '');
            }}
          >
            {t('clear')}
          </Button>
        )}
      </div>
    </form>
  );
}
