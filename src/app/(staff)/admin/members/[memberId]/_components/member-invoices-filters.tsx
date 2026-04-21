'use client';

/**
 * G-U7F — Status + fiscal-year filter for the member-page invoice
 * section (spec US7 AS1 "sortable, filterable by status + year").
 *
 * Inline compact filter bar (NOT a full directory filter — this
 * lives inside the member-detail page's invoice Card). Two Select
 * controls + Clear button. URL-synced via `?invStatus=` + `?invYear=`
 * so state is bookmarkable and survives page refresh.
 *
 * Auto-applies on Select change (no Apply button needed — Selects
 * are single-click, unlike the debounced text search where the
 * previous credit-note filter revert was about typing noise).
 *
 * URL param prefix `inv` leaves room for future filters on the
 * member page (timeline, contacts) without collision.
 */
import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

type FilterProps = {
  readonly years: readonly number[];
};

export function MemberInvoicesFilters({ years }: FilterProps) {
  const t = useTranslations('admin.members.invoices.filters');
  const tStatuses = useTranslations('admin.members.invoices.statuses');
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const status = sp.get('invStatus') ?? 'all';
  const year = sp.get('invYear') ?? 'all';
  const isFiltered = status !== 'all' || year !== 'all';

  const patch = (key: 'invStatus' | 'invYear', value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  };

  const clear = () => {
    const next = new URLSearchParams(sp.toString());
    next.delete('invStatus');
    next.delete('invYear');
    const qs = next.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pb-3">
      <Select
        value={status}
        onValueChange={(v) => patch('invStatus', v ?? 'all')}
      >
        <SelectTrigger className="h-9 w-[11rem]" aria-label={t('statusAria')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {s === 'all' ? t('status.all') : tStatuses(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={year} onValueChange={(v) => patch('invYear', v ?? 'all')}>
        <SelectTrigger className="h-9 w-[9rem]" aria-label={t('yearAria')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('year.all')}</SelectItem>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {String(y)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isFiltered && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          className="h-9"
          aria-label={t('clear')}
        >
          <XIcon className="size-4" aria-hidden="true" />
          {t('clear')}
        </Button>
      )}
    </div>
  );
}
