'use client';

/**
 * 124 US3 — the dashboard's four filters in one AURA FilterBar: Invoice type,
 * Fiscal year (the current FY and the two before), Plan (this year's active
 * plans; hidden while the type is Events) and Origin (only while
 * `FEATURE_AUTO_INVOICE` is on). Each applies on pick and writes the URL
 * (`type`, `fy`, `plan`, `origin`); each applied filter is a chip, and Clear
 * all resets them. The values shown are the ones the SERVER parsed (an
 * unknown value already fell back to All / the current FY), so a chip never
 * claims a filter the figures did not apply.
 *
 * The rules (US3.2): a plan is a membership plan, so picking one sets the
 * type to Membership; choosing any other type drops the plan. The default FY
 * carries no param and shows no chip.
 */
import { useCallback, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FilterBar, FilterSelect } from '@jirawatpyk/aura-react';

export interface DashboardFilterValues {
  readonly type: 'all' | 'membership' | 'event';
  readonly fiscalYear: number;
  readonly planId: string | null;
  readonly origin: 'all' | 'manual' | 'auto_renewal';
}

export interface DashboardFiltersProps {
  readonly values: DashboardFilterValues;
  readonly currentFiscalYear: number;
  /** Newest first, with their display labels ("FY 2026 (Jan–Dec)"). */
  readonly fiscalYears: readonly { readonly value: number; readonly label: string }[];
  readonly plans: readonly { readonly id: string; readonly label: string }[];
  readonly showOrigin: boolean;
}

type Patch = Partial<Record<'type' | 'fy' | 'plan' | 'origin', string | null>>;

export function DashboardFilters({ values, currentFiscalYear, fiscalYears, plans, showOrigin }: DashboardFiltersProps) {
  const t = useTranslations('admin.invoiceDashboard.filters');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const pushUrl = useCallback(
    (patch: Patch) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === '') params.delete(key);
        else params.set(key, value);
      }
      const query = params.toString();
      startTransition(() => {
        // Same page, refined figures: keep the scroll position.
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [searchParams, router, pathname],
  );

  const typeLabel = {
    all: t('typeAll'),
    membership: t('typeMembership'),
    event: t('typeEvent'),
  } as const;
  const originLabel = {
    all: t('originAll'),
    manual: t('originManual'),
    auto_renewal: t('originAutoRenewal'),
  } as const;
  const fyLabel = (fy: number) => fiscalYears.find((f) => f.value === fy)?.label ?? String(fy);
  const planLabel = (id: string) => plans.find((p) => p.id === id)?.label ?? id;

  const onType = (v: string) =>
    pushUrl(v === 'membership' ? { type: v } : { type: v === 'event' ? v : null, plan: null });
  const onPlan = (v: string) => pushUrl(v === 'all' ? { plan: null } : { plan: v, type: 'membership' });
  const onFiscalYear = (v: string) => pushUrl({ fy: v === String(currentFiscalYear) ? null : v });
  const onOrigin = (v: string) => pushUrl({ origin: v === 'all' ? null : v });

  const chips = [
    ...(values.type !== 'all'
      ? [{ id: 'type', label: t('chip', { label: t('type'), value: typeLabel[values.type] }), onRemove: () => onType('all') }]
      : []),
    ...(values.fiscalYear !== currentFiscalYear
      ? [
          {
            id: 'fy',
            label: t('chip', { label: t('fiscalYear'), value: fyLabel(values.fiscalYear) }),
            onRemove: () => pushUrl({ fy: null }),
          },
        ]
      : []),
    ...(values.planId !== null
      ? [{ id: 'plan', label: t('chip', { label: t('plan'), value: planLabel(values.planId) }), onRemove: () => pushUrl({ plan: null }) }]
      : []),
    ...(values.origin !== 'all'
      ? [{ id: 'origin', label: t('chip', { label: t('origin'), value: originLabel[values.origin] }), onRemove: () => onOrigin('all') }]
      : []),
  ];

  // An id the plan list does not know still filters (D-l): offer it as an
  // option, so the select shows what the figures apply.
  const planOptions = [
    { value: 'all', label: t('planAll') },
    ...plans.map((p) => ({ value: p.id, label: p.label })),
    ...(values.planId !== null && !plans.some((p) => p.id === values.planId)
      ? [{ value: values.planId, label: values.planId }]
      : []),
  ];

  return (
    <FilterBar
      collapseBelow="sm"
      touchHeight
      label={t('groupLabel')}
      filters={chips}
      filterCount={chips.length}
      {...(chips.length > 0 ? { onClearAll: () => pushUrl({ type: null, fy: null, plan: null, origin: null }) } : {})}
    >
      <FilterSelect
        label={t('type')}
        allLabel={t('allShort')}
        value={values.type}
        onChange={onType}
        options={[
          { value: 'all', label: typeLabel.all },
          { value: 'membership', label: typeLabel.membership },
          { value: 'event', label: typeLabel.event },
        ]}
      />
      <FilterSelect
        label={t('fiscalYear')}
        value={String(values.fiscalYear)}
        onChange={onFiscalYear}
        options={fiscalYears.map((f) => ({ value: String(f.value), label: f.label }))}
      />
      {values.type !== 'event' ? (
        <FilterSelect
          label={t('plan')}
          allLabel={t('allShort')}
          value={values.planId ?? 'all'}
          onChange={onPlan}
          options={planOptions}
        />
      ) : null}
      {showOrigin ? (
        <FilterSelect
          label={t('origin')}
          allLabel={t('allShort')}
          value={values.origin}
          onChange={onOrigin}
          options={[
            { value: 'all', label: originLabel.all },
            { value: 'manual', label: originLabel.manual },
            { value: 'auto_renewal', label: originLabel.auto_renewal },
          ]}
        />
      ) : null}
    </FilterBar>
  );
}
