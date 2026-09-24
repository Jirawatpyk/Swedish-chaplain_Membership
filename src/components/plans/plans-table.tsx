/**
 * T084 — PlansTable (US1) + T136–T137 — row-level US4 actions.
 *
 * Plain shadcn `<Table>` rendering the 9 SweCham 2026 plans (or more
 * depending on filter state). Sortable column headers (client-side sort
 * on plan_category + sort_order), filter bar (category / year / search /
 * activeOnly / showDeleted), category badges, and a row-level dropdown
 * menu for US4 actions (Activate/Deactivate/Delete/Undelete).
 *
 * The US4 actions (confirmation dialog, API call, toasts, refresh) live
 * in `usePlanActions`, shared with the plan detail header menu.
 *
 * **NO inline edit** — US7 deferred to F3 per critique X1c.
 *
 * Client component because the filter bar updates URL query params via
 * `useRouter().push`, which requires client-side navigation.
 */
'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CopyIcon, MoreHorizontal, PlusIcon, SearchIcon } from 'lucide-react';
// Deep PURE-Domain imports (never the auth barrel — this is a client bundle).
import type { Role } from '@/modules/auth/domain/role';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/shell/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MoneyDisplay } from './money-display';
import { LocaleTextDisplay } from './locale-text-display';
import { usePlanActions } from './use-plan-actions';
import type { PlanListItem } from '@/modules/plans';

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

  return (
    <div className="space-y-4" data-plans-table>
      {/* Filter bar — flat, matches members/directory-filters.tsx style */}
      <FilterBar aria-label={t('filters.search.label')}>
        <div className="relative sm:flex-1 min-w-0">
          <SearchIcon
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
            aria-hidden
          />
          <Label htmlFor="plans-search" className="sr-only">
            {t('filters.search.label')}
          </Label>
          <Input
            id="plans-search"
            type="search"
            placeholder={t('filters.search.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => updateFilter({ q: q || null })}
            // Commit the search on Enter too — the FilterBar is a
            // role="search" div (no <form>), so there is no implicit submit
            // and, without this, the term only applied on blur (BUG-007).
            // Ignore Enter during an IME composition (it confirms the
            // candidate, not the search).
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                updateFilter({ q: q || null });
              }
            }}
            disabled={isPending || actionPending}
            className="pl-9"
          />
        </div>

        {/* Label is `sr-only` (screen-reader only) and sits as a direct
            sibling — no wrapping `<div>` — so the SelectTrigger stays a
            direct child of FilterBar, letting the global mobile
            100%-width rule apply to the trigger itself. */}
        <Label htmlFor="plans-category" className="sr-only">
          {t('filters.category.label')}
        </Label>
        <Select
          value={category ?? 'all'}
          onValueChange={(v) => {
            const next = v === 'all' ? null : (v as 'corporate' | 'partnership');
            setCategory(next);
            updateFilter({ category: next });
          }}
        >
          <SelectTrigger id="plans-category" className="sm:w-[180px]">
            <TranslatedSelectValue
              placeholder={t('filters.category.label')}
              translate={(v) => {
                const keys: Record<string, string> = {
                  all: 'filters.all',
                  corporate: 'filters.category.corporate',
                  partnership: 'filters.category.partnership',
                };
                const key = keys[v || 'all'];
                return key ? t(key) : v;
              }}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.all')}</SelectItem>
            <SelectItem value="corporate">{t('filters.category.corporate')}</SelectItem>
            <SelectItem value="partnership">{t('filters.category.partnership')}</SelectItem>
          </SelectContent>
        </Select>

        <Label htmlFor="plans-year" className="sr-only">
          {t('filters.year')}
        </Label>
        <Select value={String(year)} onValueChange={(v) => updateFilter({ year: v })}>
          <SelectTrigger id="plans-year" className="sm:w-[120px]">
            <TranslatedSelectValue
              placeholder={t('filters.year')}
              translate={(v) => v}
            />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Switch
            id="plans-active-only"
            checked={activeOnly}
            aria-labelledby="plans-active-only-label"
            onCheckedChange={(v) => {
              setActiveOnly(v);
              updateFilter({ activeOnly: v ? 'true' : null });
            }}
          />
          <Label htmlFor="plans-active-only" id="plans-active-only-label" className="mb-0">
            {t('filters.activeOnly')}
          </Label>
        </div>

        {canWritePlans ? (
          <div className="flex items-center gap-2">
            <Switch
              id="plans-show-deleted"
              checked={showDeleted}
              aria-labelledby="plans-show-deleted-label"
              onCheckedChange={(v) => {
                setShowDeleted(v);
                updateFilter({ showDeleted: v ? 'true' : null });
              }}
            />
            <Label htmlFor="plans-show-deleted" id="plans-show-deleted-label" className="mb-0">
              {t('filters.showDeleted')}
            </Label>
          </div>
        ) : null}
      </FilterBar>

      {/* Table — matches /admin/members style (uppercase muted header
          + hover row). No outer border: parent <Card> is the container. */}
      <Table aria-label={t('tableCaption')}>
          {/* aria-label above names the scrollable REGION landmark (the
              <Table> wrapper); without it the region fell back to the
              hardcoded English "Data table" for every locale. The
              sr-only <caption> additionally labels the inner <table>
              element itself — both are kept so the table has an
              accessible name whether a SR navigates by region or by
              table. */}
          <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.name')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.category')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.annualFee')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.memberType')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.year')}
              </TableHead>
              <TableHead scope="col" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('columns.status')}
              </TableHead>
              {canWritePlans ? (
                <TableHead scope="col" className="w-[48px] text-xs uppercase tracking-wide text-muted-foreground">
                  <span className="sr-only">{t('columns.actions')}</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={canWritePlans ? 7 : 6} className="py-12">
                <EmptyState
                  icon={PlusIcon}
                  title={t('empty.title')}
                  description={t('empty.description')}
                  action={
                    canWritePlans ? (
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <Link
                          href="/admin/plans/new"
                          className={buttonVariants()}
                        >
                          <PlusIcon className="h-3.5 w-3.5" />
                          {t('empty.newCta')}
                        </Link>
                        <Link
                          href="/admin/plans/clone"
                          className={buttonVariants({ variant: 'outline' })}
                        >
                          <CopyIcon className="h-3.5 w-3.5" />
                          {t('empty.cloneCta', {
                            sourceYear: year - 1,
                            targetYear: year,
                          })}
                        </Link>
                      </div>
                    ) : undefined
                  }
                />
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((plan) => {
              const isDeleted = plan.deleted_at !== null;
              return (
                <TableRow
                  key={`${plan.plan_year}-${plan.plan_id}`}
                  className="hover:bg-accent/40"
                  data-plan-id={plan.plan_id}
                  data-plan-year={plan.plan_year}
                >
                  <TableCell>
                    <a
                      href={`/admin/plans/${plan.plan_year}/${plan.plan_id}`}
                      className="focus-visible:underline"
                    >
                      <LocaleTextDisplay
                        value={plan.plan_name}
                        showMissingBadge={canWritePlans}
                        dataAttr="data-plan-name"
                      />
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={plan.plan_category === 'partnership' ? 'default' : 'secondary'}
                    >
                      {t(`badges.${plan.plan_category}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <MoneyDisplay
                      amountMinorUnits={plan.annual_fee_minor_units}
                      currencyCode={currencyCode}
                    />
                  </TableCell>
                  <TableCell>
                    {tOptions(`memberTypeScope.${plan.member_type_scope}`)}
                  </TableCell>
                  <TableCell>{plan.plan_year}</TableCell>
                  <TableCell>
                    {isDeleted ? (
                      <Badge variant="outline">{t('badges.deleted')}</Badge>
                    ) : plan.is_active ? (
                      <Badge variant="default">{t('badges.active')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('badges.inactive')}</Badge>
                    )}
                  </TableCell>
                  {canWritePlans ? (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={(props) => (
                            <Button
                              {...props}
                              variant="ghost"
                              size="icon"
                              aria-label={t('columns.actionsFor', { planName: plan.plan_name.en })}
                              data-row-actions-trigger
                            >
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          )}
                        />
                        <DropdownMenuContent align="end">
                          {!isDeleted ? (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  router.push(
                                    `/admin/plans/${plan.plan_year}/${plan.plan_id}/edit`,
                                  );
                                }}
                              >
                                {tActions('edit')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {plan.is_active ? (
                                <DropdownMenuItem
                                  onClick={() => openDialog('deactivate', plan)}
                                >
                                  {tActions('deactivate')}
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={() => openDialog('activate', plan)}
                                >
                                  {tActions('activate')}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => openDialog('delete', plan)}
                                variant="destructive"
                              >
                                {tActions('delete')}
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => openDialog('undelete', plan)}
                            >
                              {tActions('undelete')}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <p className="text-xs text-muted-foreground">
        {t('subtitle', { total: sorted.length, year })}
      </p>

      {/* Confirmation dialog for destructive + state-changing US4 actions */}
      {actionDialog}
    </div>
  );
}
