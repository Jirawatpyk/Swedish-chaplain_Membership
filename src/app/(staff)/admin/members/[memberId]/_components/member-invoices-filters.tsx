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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

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

  return (
    <form
      className="mb-4 flex w-full flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        applyFilters(q, status, year);
      }}
    >
      {/* All controls use project standard h-9 (36px) — matches
        * `--input-height` + Button default per docs/shadcn-
        * customizations. Mobile stacks column, desktop wraps inline. */}
      <Input
        id="member-inv-q"
        type="search"
        inputMode="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('search')}
        aria-label={t('search')}
        className="w-full sm:min-w-[10rem] sm:flex-1"
        autoComplete="off"
      />
      <div className="grid grid-cols-2 gap-3 sm:contents">
        <Select value={status} onValueChange={(v) => setStatus(v ?? 'all')}>
          <SelectTrigger
            className="w-full sm:w-[11rem]"
            aria-label={t('statusAria')}
          >
            <TranslatedSelectValue
              placeholder={t('status.all')}
              translate={(v) =>
                v === 'all' || !v ? t('status.all') : tStatuses(v)
              }
            />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === 'all' ? t('status.all') : tStatuses(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id="member-inv-fy"
          type="number"
          inputMode="numeric"
          min="2020"
          max="2100"
          value={year}
          onChange={(e) => setYear(e.target.value)}
          placeholder={t('fiscalYear')}
          aria-label={t('yearAria')}
          className="w-full sm:w-32"
          autoComplete="off"
        />
      </div>
      <div
        className={`grid gap-3 sm:contents ${
          hasFilters ? 'grid-cols-2' : 'grid-cols-1'
        }`}
      >
        <Button
          type="submit"
          variant="outline"
          disabled={pending}
          aria-busy={pending}
          className="w-full sm:w-auto"
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
              setStatus('all');
              setYear('');
              applyFilters('', 'all', '');
            }}
            className="w-full sm:w-auto"
          >
            {t('clear')}
          </Button>
        )}
      </div>
    </form>
  );
}
