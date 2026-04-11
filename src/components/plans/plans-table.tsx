/**
 * T084 — PlansTable (US1).
 *
 * Plain shadcn `<Table>` rendering the 9 SweCham 2026 plans (or more
 * depending on filter state). Sortable column headers (client-side sort
 * on plan_category + sort_order), filter bar (category / year / search /
 * activeOnly / showDeleted), category badges, and a row-level dropdown
 * menu for US4 actions (Activate/Deactivate/Delete/Undelete — wired in
 * later phases but hooks are stubbed out here).
 *
 * **NO inline edit** — US7 deferred to F3 per critique X1c.
 *
 * Client component because the filter bar updates URL query params via
 * `useRouter().push`, which requires client-side navigation.
 */
'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MoneyDisplay } from './money-display';
import { LocaleTextDisplay } from './locale-text-display';
import type { PlanListItem } from '@/modules/plans';

export interface PlansTableProps {
  readonly plans: ReadonlyArray<PlanListItem>;
  readonly currencyCode: string;
  readonly year: number;
  readonly currentUserRole: 'admin' | 'manager' | 'member';
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
  const [isPending, startTransition] = useTransition();

  const [category, setCategory] = useState<'corporate' | 'partnership' | null>(
    initialFilter.category,
  );
  const [q, setQ] = useState(initialFilter.q ?? '');
  const [activeOnly, setActiveOnly] = useState(initialFilter.activeOnly);
  const [showDeleted, setShowDeleted] = useState(initialFilter.showDeleted);

  const sorted = useMemo(() => {
    return [...plans].sort((a, b) => {
      if (a.plan_category !== b.plan_category) {
        // partnership above corporate (historical PDF ordering)
        return a.plan_category === 'partnership' ? -1 : 1;
      }
      return a.sort_order - b.sort_order;
    });
  }, [plans]);

  const isAdmin = currentUserRole === 'admin';

  function updateFilter(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') params.delete(k);
      else params.set(k, v);
    }
    startTransition(() => {
      router.push(`/admin/plans?${params.toString()}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4" data-plans-table>
      {/* Filter bar */}
      <div
        className="flex flex-col gap-3 rounded-lg border border-border bg-card/50 p-3 md:flex-row md:items-center md:gap-4"
        role="region"
        aria-label={t('filters.search.label')}
      >
        <div className="flex-1">
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
            disabled={isPending}
          />
        </div>

        <div>
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
            <SelectTrigger id="plans-category" className="w-[180px]">
              <SelectValue placeholder={t('filters.category.label')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filters.all')}</SelectItem>
              <SelectItem value="corporate">{t('filters.category.corporate')}</SelectItem>
              <SelectItem value="partnership">{t('filters.category.partnership')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="plans-active-only"
            checked={activeOnly}
            onCheckedChange={(v) => {
              setActiveOnly(v);
              updateFilter({ activeOnly: v ? 'true' : null });
            }}
          />
          <Label htmlFor="plans-active-only">{t('filters.activeOnly')}</Label>
        </div>

        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Switch
              id="plans-show-deleted"
              checked={showDeleted}
              onCheckedChange={(v) => {
                setShowDeleted(v);
                updateFilter({ showDeleted: v ? 'true' : null });
              }}
            />
            <Label htmlFor="plans-show-deleted">{t('filters.showDeleted')}</Label>
          </div>
        ) : null}
      </div>

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.name')}</TableHead>
            <TableHead>{t('columns.category')}</TableHead>
            <TableHead>{t('columns.annualFee')}</TableHead>
            <TableHead>{t('columns.memberType')}</TableHead>
            <TableHead>{t('columns.year')}</TableHead>
            <TableHead>{t('columns.status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                {t('empty.title')}
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((plan) => (
              <TableRow
                key={`${plan.plan_year}-${plan.plan_id}`}
                data-plan-id={plan.plan_id}
                data-plan-year={plan.plan_year}
              >
                <TableCell>
                  <LocaleTextDisplay
                    value={plan.plan_name}
                    showMissingBadge={isAdmin}
                    dataAttr="data-plan-name"
                  />
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
                <TableCell className="capitalize">{plan.member_type_scope}</TableCell>
                <TableCell>{plan.plan_year}</TableCell>
                <TableCell>
                  {plan.deleted_at ? (
                    <Badge variant="outline">{t('badges.deleted')}</Badge>
                  ) : plan.is_active ? (
                    <Badge variant="default">{t('badges.active')}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('badges.inactive')}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <p className="text-xs text-muted-foreground">
        {t('subtitle', { total: sorted.length, year })}
      </p>
    </div>
  );
}
