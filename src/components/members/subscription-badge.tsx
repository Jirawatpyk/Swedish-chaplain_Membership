'use client';

/**
 * Pass A · Section 3 — contact marketing-subscription badge.
 *
 * Shows whether a contact has unsubscribed from F7 E-Blasts (PDPA §32 /
 * GDPR Art. 21) so an admin never wrongly assumes a member is reachable by
 * broadcast. The status is a visible TEXT label, never colour-alone (FR-035
 * / WCAG 1.4.1): the Badge variant is decorative, the label carries the
 * meaning.
 */
import { BellOffIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

export function SubscriptionBadge({
  subscribed,
}: {
  readonly subscribed: boolean;
}): React.ReactElement {
  const t = useTranslations('admin.members.detail.subscription');
  if (subscribed) {
    return <Badge variant="secondary">{t('subscribed')}</Badge>;
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-600 text-amber-900 dark:border-amber-500 dark:text-amber-100"
      aria-label={t('unsubscribedAria')}
    >
      <BellOffIcon aria-hidden="true" className="size-3" />
      <span>{t('unsubscribed')}</span>
    </Badge>
  );
}
