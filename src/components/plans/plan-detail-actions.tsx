/**
 * "⋯" menu on the plan detail header — Activate / Deactivate, Delete and
 * Restore, with the same confirmation dialogs + toasts as the plans list row
 * menu (`usePlanActions`). Render it only for `plans.write` holders; the API
 * enforces the same permission.
 *
 * 122 US6 (T603): AURA's DropdownMenu behind an IconButton named "More
 * actions for {plan}" (board `Admin-plan-detail`); Delete in the danger tone,
 * last after a separator.
 */
'use client';

import { useTranslations } from 'next-intl';
import { DropdownMenu, IconButton, type MenuItem } from '@jirawatpyk/aura-react';
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
  const label = t('detail.moreActionsFor', { planName: plan.plan_name.en });

  const items: MenuItem[] =
    plan.deleted_at !== null
      ? [{ label: tActions('undelete'), onSelect: () => openAction('undelete', plan) }]
      : [
          plan.is_active
            ? { label: tActions('deactivate'), onSelect: () => openAction('deactivate', plan) }
            : { label: tActions('activate'), onSelect: () => openAction('activate', plan) },
          // plan-state.ts: only an inactive plan can be deleted (#479).
          ...(plan.is_active
            ? []
            : ([
                { separator: true },
                { label: tActions('delete'), tone: 'danger', onSelect: () => openAction('delete', plan) },
              ] satisfies MenuItem[])),
        ];

  return (
    <>
      <DropdownMenu
        label={label}
        items={items}
        // PageHeader stretches actions on a phone; the icon button stays square.
        trigger={<IconButton icon="ellipsis" label={label} touchHeight className="flex-none" />}
      />
      {dialog}
    </>
  );
}
