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

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
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
const RISK_BANDS = ['healthy', 'warning', 'at-risk', 'critical'] as const;

// i18n key maps hoisted to module scope so they are not rebuilt on every render.
const STATUS_LABEL_KEYS: Record<string, string> = {
  all: 'filters.status.all',
  active: 'filters.status.active',
  inactive: 'filters.status.inactive',
  archived: 'filters.status.archived',
};
const RISK_LABEL_KEYS: Record<string, string> = {
  all: 'filters.risk.all',
  healthy: 'filters.risk.healthy',
  warning: 'filters.risk.warning',
  'at-risk': 'filters.risk.at-risk',
  critical: 'filters.risk.critical',
};

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
  const currentRisk = searchParams.get('risk_band') ?? 'all';

  // The search box is a CONTROLLED input (Base UI's FieldControl warns on
  // uncontrolled defaultValue being mutated — the previous `key={currentQ}` +
  // manual `ref.value =` approaches both fought it and dropped focus mid-type).
  // Local state holds what the user typed; the debounce below syncs it to the
  // URL. We reconcile FROM the URL only when the input is NOT focused (browser
  // back/forward, a shared link, the Clear button) — never mid-type, so fast
  // typing can't be reverted to an in-flight debounced value.
  const [searchValue, setSearchValue] = useState(currentQ);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setSearchValue(currentQ);
  }, [currentQ]);

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
        // `scroll: false` — a filter change is an in-place refine, NOT a
        // navigation; the default scroll-to-top made the table "jump" on every
        // debounced keystroke.
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [searchParams, router, pathname],
  );

  const onSearchChange = (value: string) => {
    setSearchValue(value); // controlled — reflect the keystroke immediately
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter =
    Boolean(currentQ) ||
    currentStatus !== 'all' ||
    currentPlan !== 'all' ||
    currentRisk !== 'all';
  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchValue('');
    pushUrl({ q: null, status: null, plan_id: null, risk_band: null });
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
          value={searchValue}
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
              const key = STATUS_LABEL_KEYS[v || 'all'];
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

      {/* I1 round-10 ui-design-specialist — quick filter on F8-derived
          at-risk band. One of the marquee F3 smart features per docs/
          smart-chamber-features.md; until now it was visible in the
          column only. With this filter, admins doing renewal triage
          can scan all "at-risk" + "critical" members in one click. */}
      <Select
        value={currentRisk}
        onValueChange={(v) => pushUrl({ risk_band: v === 'all' ? null : v })}
      >
        <SelectTrigger
          className="sm:w-44"
          aria-label={t('filters.risk.label')}
        >
          <TranslatedSelectValue
            placeholder={t('filters.risk.label')}
            translate={(v) => {
              const key = RISK_LABEL_KEYS[v || 'all'];
              return key ? t(key) : v;
            }}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.risk.all')}</SelectItem>
          {RISK_BANDS.map((b) => (
            <SelectItem key={b} value={b}>
              {t(`filters.risk.${b}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
