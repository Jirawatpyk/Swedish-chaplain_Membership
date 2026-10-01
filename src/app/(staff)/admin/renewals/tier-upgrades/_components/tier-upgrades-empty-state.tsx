/**
 * WP6 (BP5 item 3) — tier-upgrade queue empty state.
 *
 * Adopts the shared `EmptyState` primitive (icon + title + explanatory copy +
 * CTA) so this surface reads consistently with every other admin list rather
 * than reinventing its own centred-text block. FR-046a empty-state CTA points
 * at the tier-eligibility settings.
 *
 * 122 US7b-1 (T726): the settings link is an AURA secondary button.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TrendingUp } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';
import { buttonClass } from '@jirawatpyk/aura-react';

export function TierUpgradesEmptyState() {
  const t = useTranslations('admin.renewals.tier_upgrades');
  return (
    <EmptyState
      icon={TrendingUp}
      title={t('empty_state.title')}
      description={t('empty_state.subtitle')}
      data-testid="tier-upgrades-empty"
      action={
        <Link
          href="/admin/settings/renewals/schedules"
          className={buttonClass({ variant: 'secondary', size: 'sm' })}
        >
          {t('empty_state.cta')}
        </Link>
      }
    />
  );
}
