'use client';

/**
 * Members directory filters with URL-state sync.
 *
 * URL is the source of truth (bookmarkable). Filters:
 *   - Search (q): debounced 300ms text input
 *   - Status: Select dropdown (All / Active / Inactive / Archived)
 *   - Plan: Select dropdown (All plans / dynamic list from F2)
 *   - Clear: resets all filters + pagination
 */

import { useCallback, useRef, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

const DEBOUNCE_MS = 300;

const STATUS_VALUES = ['active', 'inactive', 'archived'] as const;

export type PlanOption = {
  readonly id: string;
  readonly label: string;
};

type Props = {
  readonly plans?: readonly PlanOption[];
};

export function DirectoryFilters({ plans = [] }: Props) {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const currentQ = searchParams.get('q') ?? '';
  const currentStatus = searchParams.get('status') ?? 'all';
  const currentPlan = searchParams.get('plan_id') ?? 'all';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      // Clear pagination state whenever filters change.
      params.delete('cursor');
      params.delete('page');
      // Clean up legacy param
      params.delete('show_archived');
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
    Boolean(currentQ) || currentStatus !== 'all' || currentPlan !== 'all';
  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (inputRef.current) inputRef.current.value = '';
    pushUrl({ q: null, status: null, plan_id: null });
  };

  return (
    <FilterBar>
      <div className="relative sm:flex-1 min-w-0">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          key={currentQ}
          defaultValue={currentQ}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchSrLabel')}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      <Select
        value={currentStatus}
        onValueChange={(v) => pushUrl({ status: v === 'all' ? null : v })}
      >
        <SelectTrigger className="sm:w-36" aria-label={t('filters.status.label')}>
          <TranslatedSelectValue
            placeholder={t('filters.status.label')}
            translate={(v) => {
              const keys: Record<string, string> = {
                all: 'filters.status.all',
                active: 'filters.status.active',
                inactive: 'filters.status.inactive',
                archived: 'filters.status.archived',
              };
              const key = keys[v || 'all'];
              return key ? t(key) : v;
            }}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.status.all')}</SelectItem>
          {STATUS_VALUES.map((s) => (
            <SelectItem key={s} value={s}>
              {t(`filters.status.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {plans.length > 0 && (
        <Select
          value={currentPlan}
          onValueChange={(v) => pushUrl({ plan_id: v === 'all' ? null : v })}
        >
          <SelectTrigger className="sm:w-56" aria-label={t('filters.plan.label')}>
            <TranslatedSelectValue
              placeholder={t('filters.plan.label')}
              translate={(v) => {
                if (!v || v === 'all') return t('filters.plan.all');
                const plan = plans.find((p) => p.id === v);
                return plan?.label ?? v;
              }}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.plan.all')}</SelectItem>
            {plans.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" />
          {t('clearFilters')}
        </Button>
      )}
    </FilterBar>
  );
}
