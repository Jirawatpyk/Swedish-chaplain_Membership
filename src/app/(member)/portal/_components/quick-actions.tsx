'use client';

import { useTranslations } from 'next-intl';
import { CreditCard, Gift, RefreshCw, UserPen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { QuickAction } from '@/components/portal/dashboard/quick-action';

/**
 * 057 portal redesign §4.1 — transactional quick-actions card.
 *
 * 2×2 grid on mobile, 4-up on desktop (spec §4.1). The Renew tile renders
 * only when `renewDue` is true — same threshold as the MembershipStatSection
 * (spec: "hide/disable when not due"). Uses the existing `QuickAction`
 * primitive (touch target ≥44px, already-localised label = accessible name).
 *
 * Client component: `useTranslations` is a client hook.
 */
export interface QuickActionsProps {
  readonly memberId: string;
  /** Renew tile renders only when true (mirrors the Membership card threshold). */
  readonly renewDue: boolean;
}

export function QuickActions({ memberId, renewDue }: QuickActionsProps): React.ReactElement {
  const t = useTranslations('portal.dashboard.quickActions');

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-5">
        <h2 className="text-caption font-medium text-muted-foreground">{t('title')}</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <QuickAction
            href="/portal/invoices"
            label={t('pay')}
            icon={CreditCard}
            emphasis="primary"
          />
          <QuickAction
            href="/portal/benefits"
            label={t('benefits')}
            icon={Gift}
            emphasis="secondary"
          />
          {renewDue ? (
            <QuickAction
              href={`/portal/renewal/${memberId}`}
              label={t('renew')}
              icon={RefreshCw}
              emphasis="secondary"
            />
          ) : null}
          <QuickAction
            href="/portal/edit"
            label={t('editProfile')}
            icon={UserPen}
            emphasis="secondary"
          />
        </div>
      </CardContent>
    </Card>
  );
}
