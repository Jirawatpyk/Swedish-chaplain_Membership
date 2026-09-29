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
import { Badge } from '@jirawatpyk/aura-react';
import type { MarketingState } from '@/modules/members';

const ICON: Record<MarketingState, typeof BellIcon> = {
  on: BellIcon,
  off_by_staff: BellOffIcon,
  off_by_contact: UserRoundXIcon,
  unsubscribed: MailXIcon,
  unavailable: HelpCircleIcon,
};

// Spec 122 US5b-1 — AURA tones: the three "won't receive" states are the
// warning tone (themed and AA-tuned by AURA, never a hardcoded amber — review
// M6); "on" and "unavailable" are neutral. `unavailable` is a STATE, not an
// empty sentinel, so it is never muted (portal toggle rule).
const TONE: Record<MarketingState, 'neutral' | 'warning'> = {
  on: 'neutral',
  off_by_staff: 'warning',
  off_by_contact: 'warning',
  unsubscribed: 'warning',
  unavailable: 'neutral',
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
    <Badge tone={TONE[state]} data-marketing-state={state}>
      <Icon aria-hidden="true" className="size-3" />
      <span>{t(state)}</span>
      {/* The WHY as real (visually hidden) text — `aria-label` on a role-less
          span is ARIA-prohibited: NVDA/JAWS drop it, VoiceOver swaps the
          visible text for it (review M2 / a11y 3). */}
      {explanation !== undefined && <span className="sr-only">{`, ${explanation}`}</span>}
    </Badge>
  );
}
