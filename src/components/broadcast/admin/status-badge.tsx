/**
 * Maps F7 BroadcastStatus enum → bilingual badge variant.
 * Reused by queue-table + detail page + audit-timeline.
 *
 * Async server component — uses next-intl/server. `sending` pulse is
 * gated by motion-safe to honour prefers-reduced-motion.
 */
import { getTranslations } from 'next-intl/server';
import { Badge } from '@/components/ui/badge';
import type { BroadcastStatus } from '@/modules/broadcasts';
import { cn } from '@/lib/utils';

interface BadgeStyle {
  readonly variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost';
  readonly className?: string;
}

const STATUS_STYLES: Record<BroadcastStatus, BadgeStyle> = {
  draft: { variant: 'outline', className: 'text-muted-foreground' },
  submitted: { variant: 'secondary' },
  approved: { variant: 'default' },
  sending: { variant: 'default', className: 'motion-safe:animate-pulse' },
  sent: { variant: 'default' },
  rejected: { variant: 'destructive' },
  cancelled: { variant: 'outline', className: 'text-muted-foreground' },
  failed_to_dispatch: { variant: 'destructive' },
};

export interface StatusBadgeProps {
  readonly status: BroadcastStatus;
}

export async function StatusBadge({
  status,
}: StatusBadgeProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue.status');
  const style = STATUS_STYLES[status];
  return (
    <Badge variant={style.variant} className={cn(style.className)}>
      {t(status)}
    </Badge>
  );
}
