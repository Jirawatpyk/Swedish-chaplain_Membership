/**
 * T084 — PlansTable (US1) + T136–T137 — row-level US4 actions.
 *
 * Plain shadcn `<Table>` rendering the 9 SweCham 2026 plans (or more
 * depending on filter state). Sortable column headers (client-side sort
 * on plan_category + sort_order), filter bar (category / year / search /
 * activeOnly / showDeleted), category badges, and a row-level dropdown
 * menu for US4 actions (Activate/Deactivate/Delete/Undelete).
 *
 * Each US4 action opens a `ConfirmationDialog` per UX standards § 4.1,
 * fires the matching API endpoint with a fresh `Idempotency-Key`, and
 * on success shows a sonner toast + `router.refresh()` to repull the
 * row. On failure we show an error toast — the row is NOT optimistically
 * mutated because the server is the source of truth (FR-018/LWW).
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
import { toast } from 'sonner';
import { MoreHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { MoneyDisplay } from './money-display';
import { LocaleTextDisplay } from './locale-text-display';
import type { PlanListItem } from '@/modules/plans';

type ActionKind = 'activate' | 'deactivate' | 'delete' | 'undelete';

type PendingAction = {
  readonly kind: ActionKind;
  readonly plan: PlanListItem;
};

function endpointFor(kind: ActionKind, plan: PlanListItem): {
  readonly method: 'POST' | 'DELETE';
  readonly url: string;
} {
  const base = `/api/plans/${plan.plan_year}/${plan.plan_id}`;
  switch (kind) {
    case 'activate':
      return { method: 'POST', url: `${base}/activate` };
    case 'deactivate':
      return { method: 'POST', url: `${base}/deactivate` };
    case 'delete':
      return { method: 'DELETE', url: base };
    case 'undelete':
      return { method: 'POST', url: `${base}/undelete` };
  }
}

function freshIdempotencyKey(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `plans-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  const tActions = useTranslations('admin.plans.actions');
  const tConfirm = useTranslations('admin.plans.confirm');
  const tToast = useTranslations('admin.plans.toast');
  const tErrors = useTranslations('admin.plans.errors');
  const tButtons = useTranslations('admin.plans.create.buttons');
  const [isPending, startTransition] = useTransition();

  const [category, setCategory] = useState<'corporate' | 'partnership' | null>(
    initialFilter.category,
  );
  const [q, setQ] = useState(initialFilter.q ?? '');
  const [activeOnly, setActiveOnly] = useState(initialFilter.activeOnly);
  const [showDeleted, setShowDeleted] = useState(initialFilter.showDeleted);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function runAction(action: PendingAction): Promise<void> {
    const { method, url } = endpointFor(action.kind, action.plan);
    setSubmitting(true);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshIdempotencyKey(),
        },
      });
      if (res.ok) {
        const toastKey = (
          {
            activate: 'activated',
            deactivate: 'deactivated',
            delete: 'deleted',
            undelete: 'undeleted',
          } as const
        )[action.kind];
        toast.success(
          tToast(toastKey, { planName: action.plan.plan_name.en }),
        );
        startTransition(() => {
          router.refresh();
        });
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; details?: { affected_member_count?: number } };
        } | null;
        const code = body?.error?.code;
        if (code === 'plan_has_active_members') {
          toast.error(
            tErrors('memberAttached', {
              count: body?.error?.details?.affected_member_count ?? 0,
            }),
          );
        } else if (code === 'not_found') {
          toast.error(tErrors('notFound'));
        } else if (code === 'idempotency_conflict') {
          toast.error(tErrors('idempotencyConflict'));
        } else {
          toast.error(tErrors('generic'));
        }
      }
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
      setPending(null);
    }
  }

  function openDialog(kind: ActionKind, plan: PlanListItem): void {
    // Activate is not destructive and doesn't need a confirmation —
    // click fires the action immediately. The dropdown menu closed
    // already at click, so there's no UI glitch.
    if (kind === 'activate') {
      // Activate is non-destructive — fire immediately, no confirmation.
      // Guard against double-click race before submitting state takes effect.
      if (submitting) return;
      runAction({ kind, plan }).catch(() => {});
      return;
    }
    setPending({ kind, plan });
  }

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
            aria-labelledby="plans-active-only-label"
            onCheckedChange={(v) => {
              setActiveOnly(v);
              updateFilter({ activeOnly: v ? 'true' : null });
            }}
          />
          <Label htmlFor="plans-active-only" id="plans-active-only-label">
            {t('filters.activeOnly')}
          </Label>
        </div>

        {isAdmin ? (
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
            <Label htmlFor="plans-show-deleted" id="plans-show-deleted-label">
              {t('filters.showDeleted')}
            </Label>
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
            {isAdmin ? (
              <TableHead className="w-[48px]">
                <span className="sr-only">{t('columns.actions')}</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={isAdmin ? 7 : 6}
                className="text-center text-muted-foreground"
              >
                {t('empty.title')}
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((plan) => {
              const isDeleted = plan.deleted_at !== null;
              return (
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
                    {isDeleted ? (
                      <Badge variant="outline">{t('badges.deleted')}</Badge>
                    ) : plan.is_active ? (
                      <Badge variant="default">{t('badges.active')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('badges.inactive')}</Badge>
                    )}
                  </TableCell>
                  {isAdmin ? (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={(props) => (
                            <Button
                              {...props}
                              variant="ghost"
                              size="icon"
                              aria-label={t('columns.actions')}
                              data-row-actions-trigger
                            >
                              <MoreHorizontal className="h-4 w-4" />
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
                                data-destructive
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
      {pending ? (
        <ConfirmationDialog
          open={true}
          onOpenChange={(open) => {
            if (!open && !submitting) setPending(null);
          }}
          title={tConfirm(`${pending.kind as 'deactivate' | 'delete' | 'undelete'}.title`, {
            planName: pending.plan.plan_name.en,
          })}
          description={tConfirm(
            `${pending.kind as 'deactivate' | 'delete' | 'undelete'}.description`,
          )}
          confirmLabel={tConfirm(
            `${pending.kind as 'deactivate' | 'delete' | 'undelete'}.confirmCta`,
          )}
          cancelLabel={tButtons('cancel')}
          onConfirm={() => runAction(pending)}
          destructive={pending.kind === 'delete'}
        />
      ) : null}
    </div>
  );
}
