/**
 * T153 — Command palette groups (US6).
 *
 * Three `<CommandGroup>` sections rendered inside `<CommandPalette>`:
 *   - Plans (entity hits)
 *   - Actions (static action registry, pre-filtered by role on the server)
 *   - Navigate (static navigate registry)
 *
 * Each group hides itself when its entry list is empty to avoid
 * empty-heading visual noise. The whole palette falls through to a
 * single `<CommandEmpty>` when every group is empty (wired in the
 * root `<CommandPalette>` component).
 */
'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { CommandGroup, CommandItem } from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import type { PaletteSearchResponse } from './registry';

type Results = PaletteSearchResponse['results'];

type GroupsProps = {
  readonly results: Results;
  readonly onAfterNavigate: () => void;
};

export function PaletteGroups({ results, onAfterNavigate }: GroupsProps) {
  const t = useTranslations('palette');
  const router = useRouter();

  const handleNavigate = (url: string) => {
    onAfterNavigate();
    router.push(url);
  };

  return (
    <>
      {results.plans.length > 0 && (
        <CommandGroup heading={t('groups.plans')}>
          {results.plans.map((plan) => (
            <CommandItem
              key={`plan-${plan.plan_year}-${plan.plan_id}`}
              value={`plan ${plan.plan_id} ${plan.plan_name}`}
              onSelect={() => handleNavigate(plan.url)}
            >
              <span>{plan.plan_name}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {plan.plan_year}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {results.members.length > 0 && (
        <CommandGroup heading={t('groups.members')}>
          {results.members.map((m) => (
            <CommandItem
              key={`member-${m.member_id}`}
              // 055-member-number — include the formatted number in the cmdk
              // fuzzy-match string so typing `42`, `0042`, or `SCCM-0042`
              // matches this row in addition to company/contact name.
              value={`member ${m.company_name} ${m.member_number_display} ${m.primary_contact_name ?? ''}`}
              onSelect={() => handleNavigate(m.url)}
            >
              <span className="truncate">{m.company_name}</span>
              {/* 055-member-number — show the formatted number so the admin
                  can confirm which row is #42 when multiple names are similar. */}
              <Badge
                variant="outline"
                className="ml-2 shrink-0 font-mono text-xs"
                data-testid="palette-member-number-badge"
              >
                {m.member_number_display}
              </Badge>
              {m.primary_contact_name ? (
                <span className="ml-auto max-w-[12rem] truncate text-xs text-muted-foreground">
                  {m.primary_contact_name}
                </span>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {results.refundableInvoices.length > 0 && (
        <CommandGroup heading={t('groups.refundableInvoices')}>
          {results.refundableInvoices.map((inv) => (
            <CommandItem
              key={`refundable-invoice-${inv.invoice_id}`}
              // Fuzzy match: invoice number + member company name. The
              // `total_display` is intentionally NOT in the match string —
              // admins searching "53,500" should hit by amount via the
              // member's company name (rare) rather than via decimal
              // matching, which conflicts with invoice-number digits.
              value={`refundable-invoice ${inv.invoice_number} ${inv.member_company_name}`}
              onSelect={() => handleNavigate(inv.url)}
              data-testid="refundable-invoice-cmdk-item"
            >
              <span className="font-mono">{inv.invoice_number}</span>
              <span className="ml-2 truncate text-muted-foreground">
                {inv.member_company_name}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {inv.total_display}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {results.actions.length > 0 && (
        <CommandGroup heading={t('groups.actions')}>
          {results.actions.map((action) => {
            // Resolve the i18n key to the visible, locale-specific label ONCE
            // and use it both for display AND in the cmdk match value, so a
            // TH/SV admin can search an action by the text they actually see
            // (#4). English synonyms cover verbs not in the label (BUG-024).
            const label = resolveLabel(t, action.label, 'actions');
            return (
              <CommandItem
                key={action.id}
                value={`action ${action.id} ${label} ${(action.keywords ?? []).join(' ')}`}
                onSelect={() => handleNavigate(action.url)}
              >
                <span>{label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}

      {results.navigate.length > 0 && (
        <CommandGroup heading={t('groups.navigate')}>
          {results.navigate.map((nav) => {
            // Resolve to the visible localized label + use it in the cmdk match
            // value so navigate items are searchable by the text shown (#4).
            const label = resolveLabel(t, nav.label, 'navigate');
            return (
              <CommandItem
                key={nav.id}
                value={`navigate ${nav.id} ${label}`}
                onSelect={() => handleNavigate(nav.url)}
              >
                <span>{label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
    </>
  );
}

/**
 * The server sends the full i18n key (`palette.actions.newPlan`) but
 * `useTranslations('palette')` is already scoped to that namespace, so
 * we only need the tail segment. Falls back to the raw label if the
 * shape is unexpected so we never render blank text.
 */
function resolveLabel(
  t: ReturnType<typeof useTranslations>,
  key: string,
  group: 'actions' | 'navigate',
): string {
  const prefix = `palette.${group}.`;
  if (!key.startsWith(prefix)) return key;
  const tail = key.slice(prefix.length);
  // next-intl returns the raw key when a translation is missing, which
  // is exactly the fallback we want.
  return t(`${group}.${tail}` as 'groups.plans');
}
