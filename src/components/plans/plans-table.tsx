/**
 * T084 — PlansTable (US1) + T136–T137 — row-level US4 actions.
 *
 * The plans for one year (partnership first, then sort order), the filter
 * row (search / category / year / active only / show deleted, all in the
 * URL), category badges, and a row menu for the US4 actions
 * (Activate / Deactivate / Delete / Restore).
 *
 * 122 US6 (T602): on AURA as the `Admin-plans` board draws it — the filters
 * as one labelled group of AURA fields, AURA's table (each row keeps its
 * `data-plan-id` / `data-plan-year` for the e2e, which DataTable cannot
 * carry), badges, status pills, an IconButton menu per row, and the count
 * with the VAT note under it. Below 640px each row is a card: the name as
 * its title with the status and the menu beside it, the year left out
 * (`Admin-plans-mobile`).
 *
 * The US4 actions (confirmation dialog, API call, toasts, refresh) live
 * in `usePlanActions`, shared with the plan detail header menu.
 *
 * **NO inline edit** — US7 deferred to F3 per critique X1c.
 *
 * Client component because the filter row updates URL query params via
 * `useRouter().push`, which requires client-side navigation.
 */
'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CopyIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  Select,
  StatusPill,
  Switch,
  Table,
  TBody,
  Td,
  TextField,
  Th,
  THead,
  Tr,
  buttonClass,
  type MenuItem,
} from '@jirawatpyk/aura-react';
// Deep PURE-Domain imports (never the auth barrel — this is a client bundle).
import type { Role } from '@/modules/auth/domain/role';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import { EmptyState } from '@/components/shell/empty-state';
import { MoneyDisplay } from './money-display';
import { LocaleTextDisplay } from './locale-text-display';
import { usePlanActions } from './use-plan-actions';
import type { PlanListItem } from '@/modules/plans';
import { formatCalendarYear } from '@/lib/format-date-localised';

export interface PlansTableProps {
  readonly plans: ReadonlyArray<PlanListItem>;
  readonly currencyCode: string;
  readonly year: number;
  /** The literal session role; mutation affordances key on `plans.write`
   *  (016 polish, I6 — admin ∪ super_admin today, but the KEY is the truth). */
  readonly currentUserRole: Role;
  readonly initialFilter: {
    readonly category: 'corporate' | 'partnership' | null;
    readonly q: string | null;
    readonly activeOnly: boolean;
    readonly showDeleted: boolean;
  };
}

/**
 * A card hides the year: the page is already one year (`Admin-plans-mobile`).
 * AURA app content: which of this page's fields a phone card leaves out (the
 * static Table's `Td` has title / action / field slots, no "hide").
 */
const HIDE_IN_CARD = '@max-[640px]/aura-tbl:hidden';

export function PlansTable({
  plans,
  currencyCode,
  year,
  currentUserRole,
  initialFilter,
}: PlansTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('admin.plans');
  // Plan years are stored CE; every visible year goes through the locale
  // (TH reads 2569). Select values, hrefs and keys stay CE.
  const locale = useLocale();
  const tActions = useTranslations('admin.plans.actions');
  const tOptions = useTranslations('admin.plans.create.options');
  const [isPending, startTransition] = useTransition();

  const [category, setCategory] = useState<'corporate' | 'partnership' | null>(
    initialFilter.category,
  );
  const [q, setQ] = useState(initialFilter.q ?? '');
  const [activeOnly, setActiveOnly] = useState(initialFilter.activeOnly);
  const [showDeleted, setShowDeleted] = useState(initialFilter.showDeleted);

  // Row actions (Activate / Deactivate / Delete / Restore) + their
  // confirmation dialog — shared with the plan detail header.
  const {
    openAction: openDialog,
    isPending: actionPending,
    dialog: actionDialog,
  } = usePlanActions();

  const sorted = useMemo(() => {
    return [...plans].sort((a, b) => {
      if (a.plan_category !== b.plan_category) {
        // partnership above corporate (historical PDF ordering)
        return a.plan_category === 'partnership' ? -1 : 1;
      }
      return a.sort_order - b.sort_order;
    });
  }, [plans]);

  // 016 polish (I6) — affordances key on `plans.write`, the permission the
  // mutation routes themselves require, so the CTAs can never outrun or lag
  // the API's own gate when a bundle moves.
  const canWritePlans = hasPermission(currentUserRole, 'plans.write');

  // Year filter options — a small window around the viewed year (always
  // included), newest first. Before BUG-009 there was NO visible year
  // control at all (the list defaulted to the current year and the only way
  // to change it was hand-editing the ?year= URL); that param still reaches
  // any year outside this window.
  const yearOptions = useMemo(() => {
    // Clamp the window to the same [2000, 2100] range page.tsx validates, so
    // the dropdown can never offer a year the server will reject and silently
    // drop (which would fall back to the current year).
    const years: number[] = [];
    const top = Math.min(year + 1, 2100);
    const bottom = Math.max(year - 3, 2000);
    for (let y = top; y >= bottom; y -= 1) years.push(y);
    // Always keep the currently-viewed year selectable, even at a boundary.
    if (!years.includes(year)) years.unshift(year);
    return years;
  }, [year]);

  // The tenant's VAT rate travels on every row (the list reads it once);
  // the note under the table names it ("fees exclude 7% VAT").
  const vatPercent =
    sorted[0] !== undefined ? Math.round(sorted[0].vat_rate * 10_000) / 100 : null;

  function updateFilter(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') params.delete(k);
      else params.set(k, v);
    }
    startTransition(() => {
      router.push(`/admin/plans?${params.toString()}`);
    });
  }

  // Filters beyond the year that the shown rows were loaded with: when they
  // hide every plan, the empty state says so and offers to clear them, not a
  // clone the server would refuse for a populated year (UX review, US6).
  const filtered =
    initialFilter.category !== null ||
    Boolean(initialFilter.q) ||
    initialFilter.activeOnly ||
    initialFilter.showDeleted;

  function clearFilters() {
    setCategory(null);
    setQ('');
    setActiveOnly(false);
    setShowDeleted(false);
    updateFilter({ category: null, q: null, activeOnly: null, showDeleted: null });
  }

  function rowActions(plan: PlanListItem): MenuItem[] {
    if (plan.deleted_at !== null) {
      return [{ label: tActions('undelete'), onSelect: () => openDialog('undelete', plan) }];
    }
    return [
      {
        label: tActions('edit'),
        onSelect: () => router.push(`/admin/plans/${plan.plan_year}/${plan.plan_id}/edit`),
      },
      { separator: true },
      plan.is_active
        ? { label: tActions('deactivate'), onSelect: () => openDialog('deactivate', plan) }
        : { label: tActions('activate'), onSelect: () => openDialog('activate', plan) },
      { label: tActions('delete'), tone: 'danger', onSelect: () => openDialog('delete', plan) },
    ];
  }

  const busy = isPending || actionPending;

  return (
    <div className="space-y-4" data-plans-table>
      {/* The board's filter row: labelled AURA fields in one group. On a
          phone the search takes its own row, category and year share the
          next, and the switches stack (`Admin-plans-mobile`). */}
      <div
        role="group"
        aria-label={t('filters.groupLabel')}
        className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap"
      >
        <TextField
          id="plans-search"
          type="search"
          label={t('filters.search.label')}
          placeholder={t('filters.search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onBlur={() => updateFilter({ q: q || null })}
          // Commit the search on Enter too — there is no <form> around the
          // filters, so there is no implicit submit and, without this, the
          // term only applied on blur (BUG-007). Ignore Enter during an IME
          // composition (it confirms the candidate, not the search).
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              updateFilter({ q: q || null });
            }
          }}
          disabled={busy}
          className="col-span-2 sm:min-w-60 sm:flex-1"
        />
        <Select
          id="plans-category"
          label={t('filters.category.label')}
          value={category ?? 'all'}
          onChange={(e) => {
            const v = e.target.value;
            const next = v === 'all' ? null : (v as 'corporate' | 'partnership');
            setCategory(next);
            updateFilter({ category: next });
          }}
          options={[
            { value: 'all', label: t('filters.all') },
            { value: 'corporate', label: t('filters.category.corporate') },
            { value: 'partnership', label: t('filters.category.partnership') },
          ]}
          className="sm:w-44"
        />
        <Select
          id="plans-year"
          label={t('filters.year')}
          value={String(year)}
          onChange={(e) => updateFilter({ year: e.target.value })}
          options={yearOptions.map((y) => ({ value: String(y), label: formatCalendarYear(y, locale) }))}
          className="sm:w-36"
        />
        <Switch
          id="plans-active-only"
          label={t('filters.activeOnly')}
          checked={activeOnly}
          onChange={(v) => {
            setActiveOnly(v);
            updateFilter({ activeOnly: v ? 'true' : null });
          }}
          className="col-span-2 sm:col-auto sm:self-center"
        />
        {canWritePlans ? (
          <Switch
            id="plans-show-deleted"
            label={t('filters.showDeleted')}
            checked={showDeleted}
            onChange={(v) => {
              setShowDeleted(v);
              updateFilter({ showDeleted: v ? 'true' : null });
            }}
            className="col-span-2 sm:col-auto sm:self-center"
          />
        ) : null}
      </div>

      <Table caption={t('tableCaption')} captionHidden stackBelow="sm" stackStyle="cards" align="middle">
        <THead>
          <Tr>
            <Th>{t('columns.name')}</Th>
            <Th>{t('columns.category')}</Th>
            <Th numeric>{t('columns.annualFee')}</Th>
            <Th>{t('columns.memberType')}</Th>
            <Th>{t('columns.year')}</Th>
            <Th>{t('columns.status')}</Th>
            {canWritePlans ? <Th>{t('columns.actions')}</Th> : null}
          </Tr>
        </THead>
        <TBody>
          {sorted.length === 0 && filtered ? (
            <Tr>
              <Td colSpan={canWritePlans ? 7 : 6} className="py-12">
                <EmptyState
                  icon={SearchXIcon}
                  bordered={false}
                  title={t('empty.filteredTitle')}
                  description={t('empty.filteredDescription', { year: formatCalendarYear(year, locale) })}
                  action={
                    <Button variant="secondary" onClick={clearFilters}>
                      {t('empty.clearFilters')}
                    </Button>
                  }
                />
              </Td>
            </Tr>
          ) : sorted.length === 0 ? (
            <Tr>
              <Td colSpan={canWritePlans ? 7 : 6} className="py-12">
                <EmptyState
                  icon={PlusIcon}
                  bordered={false}
                  title={t('empty.title')}
                  description={t('empty.description')}
                  action={
                    canWritePlans ? (
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <Link href="/admin/plans/new" className={buttonClass({ variant: 'primary' })}>
                          <PlusIcon aria-hidden="true" className="size-4" />
                          {t('empty.newCta')}
                        </Link>
                        <Link href="/admin/plans/clone" className={buttonClass({ variant: 'secondary' })}>
                          <CopyIcon aria-hidden="true" className="size-4" />
                          {t('empty.cloneCta', {
                            sourceYear: formatCalendarYear(year - 1, locale),
                            targetYear: formatCalendarYear(year, locale),
                          })}
                        </Link>
                      </div>
                    ) : undefined
                  }
                />
              </Td>
            </Tr>
          ) : (
            sorted.map((plan) => {
              const isDeleted = plan.deleted_at !== null;
              return (
                <Tr
                  key={`${plan.plan_year}-${plan.plan_id}`}
                  data-plan-id={plan.plan_id}
                  data-plan-year={plan.plan_year}
                >
                  <Td card="title">
                    <Link href={`/admin/plans/${plan.plan_year}/${plan.plan_id}`} className="text-[var(--aura-fg-accent)] underline-offset-4 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                      <LocaleTextDisplay
                        value={plan.plan_name}
                        showMissingBadge={canWritePlans}
                        dataAttr="data-plan-name"
                      />
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={plan.plan_category === 'partnership' ? 'accent' : 'neutral'}>
                      {t(`badges.${plan.plan_category}`)}
                    </Badge>
                  </Td>
                  <Td numeric>
                    <MoneyDisplay
                      amountMinorUnits={plan.annual_fee_minor_units}
                      currencyCode={currencyCode}
                    />
                  </Td>
                  <Td>{tOptions(`memberTypeScope.${plan.member_type_scope}`)}</Td>
                  <Td className={HIDE_IN_CARD}>{formatCalendarYear(plan.plan_year, locale)}</Td>
                  {/* Beside the name on a card, as the phone board draws it. */}
                  <Td card="action">
                    {isDeleted ? (
                      <StatusPill tone="blocked">{t('badges.deleted')}</StatusPill>
                    ) : plan.is_active ? (
                      <StatusPill tone="ready">{t('badges.active')}</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">{t('badges.inactive')}</StatusPill>
                    )}
                  </Td>
                  {canWritePlans ? (
                    <Td card="action">
                      <DropdownMenu
                        label={t('columns.actionsFor', { planName: plan.plan_name.en })}
                        items={rowActions(plan)}
                        trigger={
                          <IconButton
                            icon="ellipsis"
                            label={t('columns.actionsFor', { planName: plan.plan_name.en })}
                            touchHeight
                            data-row-actions-trigger
                          />
                        }
                      />
                    </Td>
                  ) : null}
                </Tr>
              );
            })
          )}
        </TBody>
      </Table>

      {sorted.length > 0 ? (
        <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
          {vatPercent !== null
            ? t('subtitleWithVat', {
                total: sorted.length,
                year: formatCalendarYear(year, locale),
                rate: vatPercent,
              })
            : t('subtitle', { total: sorted.length, year: formatCalendarYear(year, locale) })}
        </p>
      ) : null}

      {/* Confirmation dialog for destructive + state-changing US4 actions */}
      {actionDialog}
    </div>
  );
}
