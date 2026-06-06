'use client';

/**
 * Pass A · Section 3 / S1 — contact marketing-subscription badge.
 *
 * Shows whether a contact has unsubscribed from F7 E-Blasts (PDPA §32 /
 * GDPR Art. 21) so an admin never wrongly assumes a member is reachable by
 * broadcast. The status is a visible TEXT label, never colour-alone (FR-035
 * / WCAG 1.4.1): the Badge variant is decorative, the label carries the
 * meaning.
 *
 * `subscribed` is a tri-state: `true` (Subscribed) / `false` (Unsubscribed) /
 * `'unknown'` — the latter renders a NEUTRAL "Status unavailable" badge when
 * the marketing-suppression read was degraded (DB outage), so the UI never
 * falsely asserts "Subscribed" when the system does not actually know. The
 * caller still omits the badge entirely for contacts with no email.
 */
import { BellOffIcon, HelpCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

export function SubscriptionBadge({
  subscribed,
}: {
  readonly subscribed: boolean | 'unknown';
}): React.ReactElement {
  const t = useTranslations('admin.members.detail.subscription');
  if (subscribed === 'unknown') {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-muted-foreground"
        aria-label={t('unknownAria')}
      >
        <HelpCircleIcon aria-hidden="true" className="size-3" />
        <span>{t('unknown')}</span>
      </Badge>
    );
  }
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
