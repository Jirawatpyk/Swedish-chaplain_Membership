'use client';

/**
 * G-3 — Filter bar for `/admin/credit-notes` directory.
 *
 * Mirror of `admin/invoices/_components/invoice-filters.tsx`:
 *   - Search input with magnifier-icon prefix + 300ms debounce
 *   - Fiscal-year Select with "All years" + a rolling 5-year window
 *     around the current CE year (covers past-year audit + next-year
 *     advance drafts)
 *   - Ghost "Clear filters" button with X-icon when any filter set
 *   - URL is source of truth (bookmarkable); `router.replace` so
 *     every keystroke doesn't pollute browser history
 *   - Resets `page` on any filter change (offsets don't map across
 *     filtered result sets)
 */
import { useCallback, useRef, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

const DEBOUNCE_MS = 300;

/**
 * Build a 5-year window around the current CE year for the fiscal-
 * year select: [current-2, current-1, current, current+1, current+2].
 * At chamber scale (one or two fiscal years of live data) this
 * covers past-year audit + next-year advance drafts without forcing
 * a DB roundtrip to discover the actual distinct years in use.
 */
function buildYearOptions(): readonly number[] {
  const now = new Date().getUTCFullYear();
  return [now - 2, now - 1, now, now + 1, now + 2];
}

export function CreditNoteFilters() {
  const t = useTranslations('admin.creditNotes.list');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentQ = searchParams.get('q') ?? '';
  const currentFy = searchParams.get('fy') ?? 'all';

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

  const onSearchChange = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter = currentQ !== '' || currentFy !== 'all';
  const yearOptions = buildYearOptions();

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="relative flex-1 min-w-[10rem]">
        <SearchIcon
          aria-hidden="true"
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          defaultValue={currentQ}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          className="pl-9"
        />
      </div>
      <Select
        value={currentFy}
        onValueChange={(v) => pushUrl({ fy: v && v !== 'all' ? v : null })}
      >
        <SelectTrigger className="w-[9rem]" aria-label={t('filters.fiscalYear')}>
          <TranslatedSelectValue
            placeholder={t('filters.allYears')}
            translate={(v) => (v === 'all' || !v ? t('filters.allYears') : v)}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.allYears')}</SelectItem>
          {yearOptions.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {String(y)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasAnyFilter && (
        <Button
          variant="ghost"
          onClick={() => pushUrl({ q: null, fy: null })}
          aria-label={t('filters.clearAll')}
        >
          <XIcon className="size-4" />
          {t('filters.clearAll')}
        </Button>
      )}
    </div>
  );
}
