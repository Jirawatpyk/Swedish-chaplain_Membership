'use client';

/**
 * 108 PR-D (FR-031, FR-031a, FR-051) — per-contact marketing state badge.
 *
 * Shared by the member detail page and the Marketing audience page so both
 * say the same thing in the same words (labels under `shared.marketing.state`).
 * The state is a VISIBLE text label plus an icon — never colour alone
 * (WCAG 1.4.1); the Badge variant is decorative. Non-"on" states carry an
 * explanation as visually-hidden TEXT so a screen reader hears WHY the
 * contact will not receive. `'unavailable'` is the honest badge for a suppression-list
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

// Semantic warning tokens (globals.css `--warning*`, AA-tuned) — never a
// hardcoded amber that ignores theming (review M6, repeat of F7.1a US7).
const OFF_TONE = 'border-warning bg-warning-surface text-warning';
const TONE: Record<MarketingState, string> = {
  on: '',
  off_by_staff: OFF_TONE,
  off_by_contact: OFF_TONE,
  unsubscribed: OFF_TONE,
  unavailable: 'text-muted-foreground',
};

export function MarketingStateBadge({
  state,
}: {
  readonly state: MarketingState;
}): React.ReactElement {
  const t = useTranslations('shared.marketing.state');
  const Icon = ICON[state];
  const explanation = state === 'on' ? undefined : t(`${state}Aria`);
  return (
    <Badge
      variant={VARIANT[state]}
      className={`gap-1 ${TONE[state]}`.trim()}
      data-marketing-state={state}
    >
      <Icon aria-hidden="true" className="size-3" />
      <span>{t(state)}</span>
      {/* The WHY as real (visually hidden) text — `aria-label` on a role-less
          span is ARIA-prohibited: NVDA/JAWS drop it, VoiceOver swaps the
          visible text for it (review M2 / a11y 3). */}
      {explanation !== undefined && <span className="sr-only">{`, ${explanation}`}</span>}
    </Badge>
  );
}
