/**
 * T084 — PlansTable (US1) + T136–T137 — row-level US4 actions.
 *
 * The plans for one year (partnership first, then sort order), the filter
 * row (search / category / year / active only / show deleted, all in the
 * URL), category badges, and a row menu for the US4 actions
 * (Activate / Deactivate / Delete / Restore).
 *
 * 122 US6 (T602): on AURA as the `Admin-plans` board draws it — AURA's table (each row keeps its
 * `data-plan-id` / `data-plan-year` for the e2e, which DataTable cannot
 * carry), badges, status pills, an IconButton menu per row, and the VAT
 * note under it. The filter row follows the one filter pattern
 * (docs/aura-adoption.md § Filters): AURA's FilterBar with the search, then
 * Year and Category, then the two toggle chips, the result count at its end
 * and a chip for each applied value. Below 640px each row is a card: the name as
 * its title with the status and the menu beside it, the year left out
 * (`Admin-plans-mobile`).
 *
 * The US4 actions (confirmation dialog, API call, toasts, refresh) live
 * in `usePlanActions`, shared with the plan detail header menu.
 *
 * **NO inline edit** — US7 deferred to F3 per critique X1c.
 *
 * Client component because the filter row updates URL query params in place
 * (`router.replace`, no scroll), which requires client-side navigation.
 */
'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CopyIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import {
  AuraProvider,
  Badge,
  Button,
  DropdownMenu,
  FilterBar,
  FilterSelect,
  IconButton,
  StatusPill,
  Table,
  Tag,
  TBody,
  Td,
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
export const HIDE_IN_CARD = '@max-[640px]/aura-tbl:hidden';

export function PlansTable({
  plans,
  currencyCode,
  year,
  currentUserRole,
  initialFilter,
}: PlansTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations('admin.plans');
  // Plan years are stored CE; every visible year goes through the locale
  // (TH reads 2569). Select values, hrefs and keys stay CE.
  const locale = useLocale();
  const tActions = useTranslations('admin.plans.actions');
  const tOptions = useTranslations('admin.plans.create.options');
  const [, startTransition] = useTransition();

  const [category, setCategory] = useState<'corporate' | 'partnership' | null>(
    initialFilter.category,
  );
  const [q, setQ] = useState(initialFilter.q ?? '');
  const [activeOnly, setActiveOnly] = useState(initialFilter.activeOnly);
  const [showDeleted, setShowDeleted] = useState(initialFilter.showDeleted);

  // Row actions (Activate / Deactivate / Delete / Restore) + their
  // confirmation dialog — shared with the plan detail header.
  const { openAction: openDialog, dialog: actionDialog } = usePlanActions();

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
    const query = params.toString();
    startTransition(() => {
      // In place, as every list's filters: no history entry per pick, no jump.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
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

  // A year with no plans at all (board `Admin-state-plans-empty`): only the
  // Year filter, and Show deleted — nothing else can narrow an empty year.
  const yearEmpty = sorted.length === 0 && !filtered;

  // A chip × or Clear unmounts itself; AURA's FilterBar leaves focus to the
  // page, so it moves to the search (or Year, when an empty year has no
  // search) instead of dropping to <body> (UX review H1).
  const barRef = useRef<HTMLDivElement>(null);
  // Bumped by a chip × or Clear; the effect moves focus once the bar has
  // re-rendered without the control that was pressed.
  const [focusRequest, setFocusRequest] = useState(0);
  const focusBar = () => setFocusRequest((n) => n + 1);
  useEffect(() => {
    if (focusRequest === 0) return;
    const bar = barRef.current;
    (bar?.querySelector<HTMLElement>('input[type="search"]') ?? bar?.querySelector<HTMLElement>('[role="combobox"]'))?.focus();
  }, [focusRequest]);

  function clearFilters() {
    focusBar();
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
      // plan-state.ts: only an inactive plan can be deleted (#479).
      ...(plan.is_active
        ? []
        : [{ label: tActions('delete'), tone: 'danger', onSelect: () => openDialog('delete', plan) } satisfies MenuItem]),
    ];
  }

  // Applied values as removable chips (the search and the category); the
  // toggles show their own state, and Year always has one.
  const chips = [
    ...(q.trim()
      ? [{ id: 'q', label: t('filters.chip.search', { q: q.trim() }), onRemove: () => { setQ(''); updateFilter({ q: null }); focusBar(); } }]
      : []),
    ...(category
      ? [{ id: 'category', label: t('filters.chip.category', { value: t(`filters.category.${category}`) }), onRemove: () => { setCategory(null); updateFilter({ category: null }); focusBar(); } }]
      : []),
  ];
  // The bar's Clear and chip × in this app's words.
  const barStrings = useMemo(
    () => ({
      clearFilters: t('empty.clearFilters'),
      remove: (label: string) => t('filters.removeChip', { filter: label }),
    }),
    [t],
  );


  return (
    <div className="space-y-4" data-plans-table>
      {/* The filter pattern (docs/aura-adoption.md § Filters): search, Year
          (it always has a value, so it leads and stays put when an empty year
          hides the rest), Category, then the toggle chips; the count at the
          end, a chip per applied value. */}
      <AuraProvider strings={barStrings}>
        <FilterBar
          ref={barRef}
          label={t('filters.groupLabel')}
          searchGrow
          {...(yearEmpty
            ? {}
            : {
                search: q,
                searchLabel: t('filters.search.label'),
                searchPlaceholder: t('filters.search.placeholder'),
                onSearchChange: (value: string) => {
                  setQ(value);
                  updateFilter({ q: value.trim() || null });
                },
              })}
          filters={chips}
          {...(chips.length > 0 ? { onClearAll: clearFilters } : {})}
          // No "0 results" beside "No plans for this year" (UX review L2).
          {...(yearEmpty ? {} : { resultCount: sorted.length })}
        >
          <FilterSelect
            label={t('filters.year')}
            value={String(year)}
            onChange={(v) => updateFilter({ year: v })}
            options={yearOptions.map((y) => ({ value: String(y), label: formatCalendarYear(y, locale) }))}
          />
          {yearEmpty ? null : (
            <FilterSelect
              label={t('filters.category.label')}
              allLabel={t('filters.all')}
              value={category ?? 'all'}
              onChange={(v) => {
                const next = v === 'all' ? null : (v as 'corporate' | 'partnership');
                setCategory(next);
                updateFilter({ category: next });
              }}
              options={[
                { value: 'all', label: t('filters.all') },
                { value: 'corporate', label: t('filters.category.corporate') },
                { value: 'partnership', label: t('filters.category.partnership') },
              ]}
            />
          )}
          {yearEmpty ? null : (
            <Tag
              selected={activeOnly}
              touchHeight
              onClick={() => {
                setActiveOnly(!activeOnly);
                updateFilter({ activeOnly: activeOnly ? null : 'true' });
              }}
            >
              {t('filters.activeOnly')}
            </Tag>
          )}
          {canWritePlans ? (
            <Tag
              selected={showDeleted}
              touchHeight
              onClick={() => {
                setShowDeleted(!showDeleted);
                updateFilter({ showDeleted: showDeleted ? null : 'true' });
              }}
            >
              {t('filters.showDeleted')}
            </Tag>
          ) : null}
          {/* A toggle chip is not repeated as a removable chip (one control,
              one name), so when only toggles are on, the bar's own Clear has
              nothing to hang on: offer it here (as on the members list). */}
          {(activeOnly || showDeleted) && chips.length === 0 ? (
            <Button variant="ghost" size="sm" icon="x" touchHeight onClick={clearFilters}>
              {t('empty.clearFilters')}
            </Button>
          ) : null}
        </FilterBar>
      </AuraProvider>

      <Table
        caption={t('tableCaption')}
        captionHidden
        stackBelow="sm"
        stackStyle="cards"
        align="middle"
        // FR-020 (spec 004): the column labels stay in view while the rows
        // scroll, pinned under the shell's top bar (AURA 5.26, #129).
        stickyHeader
        // Edge to edge inside the list card from 640px up (AURA 5.27, #130);
        // the VAT note follows, so it does not end the card.
        bleed
      >
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
              {/* No card label on a phone: the empty state is not a field. */}
              <Td colSpan={canWritePlans ? 7 : 6} label="">
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
              <Td colSpan={canWritePlans ? 7 : 6} label="">
                <EmptyState
                  icon={PlusIcon}
                  bordered={false}
                  title={t('empty.title')}
                  description={t('empty.description')}
                  action={
                    canWritePlans ? (
                      // On a phone the two actions stack at one full width, not two ragged ones.
                      <div className="flex flex-wrap items-center justify-center gap-2 max-sm:flex-col max-sm:items-stretch">
                        <Link href="/admin/plans/new" className={buttonClass({ variant: 'primary' })}>
                          <PlusIcon aria-hidden="true" className="size-4" />
                          {t('empty.newCta')}
                        </Link>
                        <Link href={`/admin/plans/clone?from=${year - 1}&to=${year}`} className={buttonClass({ variant: 'secondary' })}>
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
                  {/* Beside the name on a card, as the phone board draws it,
                      centred on the name's 44px line (AURA's card row aligns
                      its items to the top). */}
                  <Td card="action" className="self-center">
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

      {sorted.length > 0 && vatPercent !== null ? (
        <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
          {t('vatNote', { rate: vatPercent })}
        </p>
      ) : null}

      {/* Confirmation dialog for destructive + state-changing US4 actions */}
      {actionDialog}
    </div>
  );
}
