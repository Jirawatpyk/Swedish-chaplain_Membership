/**
 * Maps F7 BroadcastStatus enum → bilingual badge variant.
 * Reused by queue-table + detail page + audit-timeline.
 *
 * Async server component — uses next-intl/server. Variant + className
 * derived from the shared `getBroadcastStatusBadgeProps` utility (H4)
 * so admin, member, and queue-table surfaces never drift.
 */
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import type { BroadcastStatus } from '@/modules/broadcasts';
import { getBroadcastStatusBadgeProps } from '@/components/broadcast/status-badge-mapping';
import { cn } from '@/lib/utils';

export interface StatusBadgeProps {
  readonly status: BroadcastStatus;
}

export async function StatusBadge({
  status,
}: StatusBadgeProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue.status');
  const { variant, className } = getBroadcastStatusBadgeProps(status);
  return (
    <Badge variant={variant} className={cn(className)}>
      {t(status)}
    </Badge>
  );
}
