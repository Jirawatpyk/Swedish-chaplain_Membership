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

      {results.actions.length > 0 && (
        <CommandGroup heading={t('groups.actions')}>
          {results.actions.map((action) => (
            <CommandItem
              key={action.id}
              value={`action ${action.id} ${action.label}`}
              onSelect={() => handleNavigate(action.url)}
            >
              {/* label is an i18n key like `palette.actions.newPlan` —
                  resolve its last segment via the `palette.actions` namespace */}
              <span>{resolveLabel(t, action.label, 'actions')}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {results.navigate.length > 0 && (
        <CommandGroup heading={t('groups.navigate')}>
          {results.navigate.map((nav) => (
            <CommandItem
              key={nav.id}
              value={`navigate ${nav.id} ${nav.label}`}
              onSelect={() => handleNavigate(nav.url)}
            >
              <span>{resolveLabel(t, nav.label, 'navigate')}</span>
            </CommandItem>
          ))}
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
