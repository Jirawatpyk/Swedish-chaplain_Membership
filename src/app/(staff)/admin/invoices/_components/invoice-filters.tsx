'use client';

/**
 * Invoices directory filters with URL-state sync.
 *
 * Parity with `src/components/members/directory-filters.tsx`: URL is the
 * source of truth (bookmarkable) + debounced search + status dropdown +
 * clear-all button. Pagination state (`cursor`, `page`) resets on every
 * filter change.
 */

import { useCallback, useRef, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon, CheckIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const DEBOUNCE_MS = 300;

const STATUS_VALUES = [
  'draft',
  'issued',
  'paid',
  'overdue',
  'void',
  'credited',
  'partially_credited',
] as const;

export function InvoiceFilters() {
  const t = useTranslations('admin.invoices.list');
  const tStatus = useTranslations('admin.invoices.list.statuses');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tReconciliation = useTranslations('admin.paymentReconciliation.filterChip');
  const currentQ = searchParams.get('q') ?? '';
  const currentStatus = searchParams.get('status') ?? 'all';
  const paidOnlineActive = searchParams.get('paidOnline') === '1';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      params.delete('cursor');
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

  const hasAnyFilter =
    currentQ !== '' || currentStatus !== 'all' || paidOnlineActive;

  const togglePaidOnline = () => {
    pushUrl({ paidOnline: paidOnlineActive ? null : '1' });
  };

  return (
    <FilterBar>
      {/* L5: was min-w-[16rem]=256px — overflowed 320px mobile viewports
          after padding + sibling Status dropdown. On mobile (<640px) the
          search input owns the full row (FilterBar rule); on sm+ it
          flex-grows alongside the status dropdown. */}
      <div className="relative min-w-0 sm:flex-1">
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
        value={currentStatus}
        onValueChange={(v) =>
          pushUrl({ status: v && v !== 'all' ? v : null })
        }
      >
        <SelectTrigger
          className="sm:w-[12rem]"
          aria-label={t('columns.status')}
        >
          <TranslatedSelectValue
            placeholder={t('filters.allStatuses')}
            translate={(v) =>
              v === 'all' || !v ? t('filters.allStatuses') : tStatus(v)
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.allStatuses')}</SelectItem>
          {STATUS_VALUES.map((s) => (
            <SelectItem key={s} value={s}>
              {tStatus(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <TooltipProvider>
        <Tooltip>
          {/* R2-fix I1 (2026-04-26): switched to render-function form
              for parity with DropdownMenuTrigger usage elsewhere
              (invoice-more-menu.tsx) and to guarantee Base UI props
              (data-state, refs, ARIA wiring) flow through. The
              element-form variant cloned the Button but is more
              fragile across Base UI prop spreads. */}
          <TooltipTrigger
            render={(triggerProps) => (
              <Button
                {...triggerProps}
                type="button"
                variant={paidOnlineActive ? 'default' : 'outline'}
                size="sm"
                onClick={togglePaidOnline}
                data-testid="paid-online-filter-chip"
                aria-pressed={paidOnlineActive}
                aria-label={tReconciliation('ariaLabel')}
                className={cn('gap-1', paidOnlineActive && 'shadow-sm')}
              >
                {paidOnlineActive && (
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                )}
                {tReconciliation('label')}
              </Button>
            )}
          />
          <TooltipContent>{tReconciliation('tooltip')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {hasAnyFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            pushUrl({ q: null, status: null, paidOnline: null })
          }
          aria-label={t('filters.clearAll')}
        >
          <XIcon className="size-4" />
          {t('filters.clearAll')}
        </Button>
      )}
    </FilterBar>
  );
}
