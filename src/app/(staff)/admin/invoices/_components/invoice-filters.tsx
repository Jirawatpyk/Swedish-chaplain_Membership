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

  const currentQ = searchParams.get('q') ?? '';
  const currentStatus = searchParams.get('status') ?? 'all';

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

  const hasAnyFilter = currentQ !== '' || currentStatus !== 'all';

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="relative flex-1 min-w-[16rem]">
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
          className="w-[12rem]"
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
      {hasAnyFilter && (
        <Button
          variant="ghost"
          onClick={() =>
            pushUrl({ q: null, status: null })
          }
          aria-label={t('filters.clearAll')}
        >
          <XIcon className="size-4" />
          {t('filters.clearAll')}
        </Button>
      )}
    </div>
  );
}
