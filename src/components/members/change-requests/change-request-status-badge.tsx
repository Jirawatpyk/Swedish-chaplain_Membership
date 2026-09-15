/**
 * F114 — the request status as a badge: text + icon, never colour alone
 * (FR-034). One component for the staff queue / member section (`staff`
 * copy) and the portal history (`portal` copy — the same states, the
 * member's own wording). Server- and client-safe (no hooks beyond
 * `useTranslations`, which next-intl serves in both).
 *
 * The status is ONE union (PR-3 polish, types I3): `pending`, `decided` +
 * its outcome, `withdrawn` + its reason — a pair that cannot co-occur on a
 * row (an outcome on a pending row, a reason on a decided one) is not
 * expressible. `changeRequestStatusOf(row)` is the one projection from the
 * flat row / view the pages hold. The fail-soft arm — a `decided` row with
 * no outcome, unreachable under the DB CHECK — renders the pending badge
 * rather than throwing inside a list of 100 rows.
 */
import { useTranslations } from 'next-intl';
import { CheckCircle2Icon, ClockIcon, ListChecksIcon, Undo2Icon, XCircleIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ChangeRequest, ChangeRequestOutcome, WithdrawnReason } from '@/modules/members';

export type ChangeRequestStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'decided'; readonly outcome: ChangeRequestOutcome | null }
  | { readonly state: 'withdrawn'; readonly withdrawnReason: WithdrawnReason | null };

/** The flat row / view → the status union (the only place the three columns are read together). */
export function changeRequestStatusOf(row: Pick<ChangeRequest, 'state' | 'outcome' | 'withdrawnReason'>): ChangeRequestStatus {
  switch (row.state) {
    case 'pending':
      return { state: 'pending' };
    case 'decided':
      return { state: 'decided', outcome: row.outcome };
    case 'withdrawn':
      return { state: 'withdrawn', withdrawnReason: row.withdrawnReason };
    default: {
      // a state outside the union (a widened DB enum) is displayed as pending —
      // a badge, not a decision; the compile-time check is what a new state trips
      const _exhaustive: never = row.state;
      void _exhaustive;
      return { state: 'pending' };
    }
  }
}

export interface ChangeRequestStatusBadgeProps {
  readonly status: ChangeRequestStatus;
  readonly audience: 'staff' | 'portal';
  readonly className?: string;
}

export function ChangeRequestStatusBadge({ status, audience, className }: ChangeRequestStatusBadgeProps) {
  const t = useTranslations(audience === 'staff' ? 'admin.changeRequests.review' : 'portal.changeRequests.history');
  switch (status.state) {
    case 'decided': {
      // the DB CHECK makes a decided row without an outcome unreachable — fail soft to the pending badge below
      if (status.outcome === null) break;
      const outcome = status.outcome;
      const Icon = outcome === 'approved' ? CheckCircle2Icon : outcome === 'rejected' ? XCircleIcon : ListChecksIcon;
      return (
        <Badge variant={outcome === 'rejected' ? 'destructive' : outcome === 'approved' ? 'default' : 'outline'} className={className} data-state={status.state} data-outcome={outcome}>
          <Icon className="mr-1 size-3" aria-hidden="true" />
          {t(`outcome.${outcome}`)}
        </Badge>
      );
    }
    case 'withdrawn':
      return (
        <Badge variant="outline" className={className} data-state={status.state} data-withdrawn-reason={status.withdrawnReason ?? undefined}>
          <Undo2Icon className="mr-1 size-3" aria-hidden="true" />
          {status.withdrawnReason ? t(`withdrawn.${status.withdrawnReason}`) : t('state.withdrawn')}
        </Badge>
      );
    case 'pending':
      break;
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
    }
  }
  return (
    <Badge variant="secondary" className={className} data-state={status.state}>
      <ClockIcon className="mr-1 size-3" aria-hidden="true" />
      {t('state.pending')}
    </Badge>
  );
}
