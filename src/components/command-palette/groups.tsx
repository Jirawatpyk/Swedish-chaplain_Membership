/**
 * T153 — Command palette groups (US6).
 *
 * The staff palette's result groups: Plans, Members, Refund a paid invoice
 * (entity hits), then Actions and Navigate (static registries, pre-filtered
 * on the server). AURA `Command` lists items under their `group` heading in
 * first-seen order and hides a group with no items.
 */
'use client';

import type { useTranslations } from 'next-intl';
import type { CommandItem } from '@jirawatpyk/aura-react';
import { formatCalendarYear } from '@/lib/format-date-localised';
import type { PaletteSearchResponse } from './registry';

type Results = PaletteSearchResponse['results'];
type Translate = ReturnType<typeof useTranslations<'palette'>>;

/**
 * Spec 122 US1 — the staff palette's server results as AURA `Command` items,
 * in the same group order as before (Plans, Members, Refund a paid invoice,
 * Actions, Navigate). Each item goes where its entry's `url` says; the
 * server already filtered the entries per permission, and the client adds no
 * second gate (T064).
 */
export function paletteItems(
  results: Results,
  t: Translate,
  locale: string,
  navigate: (url: string) => void,
): CommandItem[] {
  return [
    ...results.plans.map((plan) => ({
      id: `plan-${plan.plan_year}-${plan.plan_id}`,
      group: t('groups.plans'),
      label: plan.plan_name,
      description: formatCalendarYear(plan.plan_year, locale),
      onSelect: () => navigate(plan.url),
    })),
    ...results.members.map((m) => ({
      id: `member-${m.member_id}`,
      group: t('groups.members'),
      label: m.company_name,
      // 055-member-number — the formatted number tells similar names apart.
      description: [m.member_number_display, m.primary_contact_name].filter(Boolean).join(' · '),
      onSelect: () => navigate(m.url),
    })),
    ...results.refundableInvoices.map((inv) => ({
      id: `refundable-invoice-${inv.invoice_id}`,
      group: t('groups.refundableInvoices'),
      label: inv.invoice_number,
      description: `${inv.member_company_name} · ${inv.total_display}`,
      onSelect: () => navigate(inv.url),
    })),
    ...results.actions.map((action) => ({
      id: action.id,
      group: t('groups.actions'),
      label: resolveLabel(t, action.label, 'actions'),
      onSelect: () => navigate(action.url),
    })),
    ...results.navigate.map((nav) => ({
      id: nav.id,
      group: t('groups.navigate'),
      label: resolveLabel(t, nav.label, 'navigate'),
      onSelect: () => navigate(nav.url),
    })),
  ];
}

function resolveLabel(t: Translate, key: string, group: 'actions' | 'navigate'): string {
  const prefix = `palette.${group}.`;
  if (!key.startsWith(prefix)) return key;
  const tail = key.slice(prefix.length);
  return t(`${group}.${tail}` as 'groups.plans');
}
