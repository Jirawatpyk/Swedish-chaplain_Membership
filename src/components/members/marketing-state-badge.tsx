'use client';

/**
 * 108 PR-D (FR-031, FR-031a, FR-051) — per-contact marketing state badge.
 *
 * Shared by the member detail page and the Marketing audience page so both
 * say the same thing in the same words (labels under `shared.marketing.state`).
 * The state is a VISIBLE text label plus an icon — never colour alone
 * (WCAG 1.4.1); the Badge variant is decorative. Non-"on" states carry an
 * explanatory accessible name so a screen reader hears WHY the contact will
 * not receive. `'unavailable'` is the honest badge for a suppression-list
 * outage (FR-031a): neither on nor off.
 */
import {
  BellIcon,
  BellOffIcon,
  HelpCircleIcon,
  MailXIcon,
  UserRoundXIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import type { MarketingState } from '@/modules/members';

const ICON: Record<MarketingState, typeof BellIcon> = {
  on: BellIcon,
  off_by_staff: BellOffIcon,
  off_by_contact: UserRoundXIcon,
  unsubscribed: MailXIcon,
  unavailable: HelpCircleIcon,
};

const VARIANT: Record<MarketingState, 'secondary' | 'outline'> = {
  on: 'secondary',
  off_by_staff: 'outline',
  off_by_contact: 'outline',
  unsubscribed: 'outline',
  unavailable: 'outline',
};

const TONE: Record<MarketingState, string> = {
  on: '',
  off_by_staff: 'border-amber-600 text-amber-900 dark:border-amber-500 dark:text-amber-100',
  off_by_contact: 'border-amber-600 text-amber-900 dark:border-amber-500 dark:text-amber-100',
  unsubscribed: 'border-amber-600 text-amber-900 dark:border-amber-500 dark:text-amber-100',
  unavailable: 'text-muted-foreground',
};

export function MarketingStateBadge({
  state,
}: {
  readonly state: MarketingState;
}): React.ReactElement {
  const t = useTranslations('shared.marketing.state');
  const Icon = ICON[state];
  const aria = state === 'on' ? undefined : t(`${state}Aria`);
  return (
    <Badge
      variant={VARIANT[state]}
      className={`gap-1 ${TONE[state]}`.trim()}
      data-marketing-state={state}
      {...(aria !== undefined ? { 'aria-label': aria } : {})}
    >
      <Icon aria-hidden="true" className="size-3" />
      <span>{t(state)}</span>
    </Badge>
  );
}
