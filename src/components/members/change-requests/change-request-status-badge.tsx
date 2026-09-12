/**
 * F114 — the request status as a badge: text + icon, never colour alone
 * (FR-034). One component for the staff queue / member section (`staff`
 * copy) and the portal history (`portal` copy — the same states, the
 * member's own wording). Server- and client-safe (no hooks beyond
 * `useTranslations`, which next-intl serves in both).
 */
import { useTranslations } from 'next-intl';
import { CheckCircle2Icon, ClockIcon, ListChecksIcon, Undo2Icon, XCircleIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ChangeRequest } from '@/modules/members';

export interface ChangeRequestStatusBadgeProps {
  readonly state: ChangeRequest['state'];
  readonly outcome: ChangeRequest['outcome'];
  readonly withdrawnReason: ChangeRequest['withdrawnReason'];
  readonly audience: 'staff' | 'portal';
  readonly className?: string;
}

export function ChangeRequestStatusBadge({ state, outcome, withdrawnReason, audience, className }: ChangeRequestStatusBadgeProps) {
  const t = useTranslations(audience === 'staff' ? 'admin.changeRequests.review' : 'portal.changeRequests.history');
  if (state === 'decided' && outcome !== null) {
    const Icon = outcome === 'approved' ? CheckCircle2Icon : outcome === 'rejected' ? XCircleIcon : ListChecksIcon;
    return (
      <Badge variant={outcome === 'rejected' ? 'destructive' : outcome === 'approved' ? 'default' : 'secondary'} className={className} data-state={state} data-outcome={outcome}>
        <Icon className="mr-1 size-3" aria-hidden="true" />
        {t(`outcome.${outcome}`)}
      </Badge>
    );
  }
  if (state === 'withdrawn') {
    return (
      <Badge variant="outline" className={className} data-state={state} data-withdrawn-reason={withdrawnReason ?? undefined}>
        <Undo2Icon className="mr-1 size-3" aria-hidden="true" />
        {withdrawnReason ? t(`withdrawn.${withdrawnReason}`) : t('state.withdrawn')}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className={className} data-state={state}>
      <ClockIcon className="mr-1 size-3" aria-hidden="true" />
      {t('state.pending')}
    </Badge>
  );
}
