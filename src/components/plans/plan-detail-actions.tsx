/**
 * "⋯" menu on the plan detail header — Activate / Deactivate, Delete and
 * Restore, with the same confirmation dialogs + toasts as the plans list row
 * menu (`usePlanActions`). Render it only for `plans.write` holders; the API
 * enforces the same permission.
 */
'use client';

import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePlanActions, type PlanActionTarget } from './use-plan-actions';

export interface PlanDetailActionsProps {
  readonly plan: PlanActionTarget & {
    readonly is_active: boolean;
    /** ISO timestamp, or `null` when the plan is not deleted. */
    readonly deleted_at: string | null;
  };
}

export function PlanDetailActions({ plan }: PlanDetailActionsProps) {
  const t = useTranslations('admin.plans');
  const tActions = useTranslations('admin.plans.actions');
  const { openAction, dialog } = usePlanActions();
  const isDeleted = plan.deleted_at !== null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(props) => (
            <Button
              {...props}
              variant="outline"
              size="icon"
              // PageHeader stretches actions on mobile; an icon button stays square.
              className="flex-none"
              aria-label={t('columns.actionsFor', { planName: plan.plan_name.en })}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end">
          {isDeleted ? (
            <DropdownMenuItem onClick={() => openAction('undelete', plan)}>
              {tActions('undelete')}
            </DropdownMenuItem>
          ) : (
            <>
              {plan.is_active ? (
                <DropdownMenuItem onClick={() => openAction('deactivate', plan)}>
                  {tActions('deactivate')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => openAction('activate', plan)}>
                  {tActions('activate')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => openAction('delete', plan)}
                variant="destructive"
              >
                {tActions('delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
