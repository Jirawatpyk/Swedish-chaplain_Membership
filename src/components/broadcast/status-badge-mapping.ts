/**
 * F7 UX hardening — H4: shared broadcast status → badge style mapping.
 *
 * Single source of truth for the BroadcastStatus → Badge variant
 * mapping. Replaces three previously-divergent implementations:
 *   - `src/components/broadcast/admin/status-badge.tsx` (admin view)
 *   - `src/components/broadcast/admin/queue-table.tsx` (inline STATUS_STYLE)
 *   - `src/app/(member)/portal/broadcasts/[id]/page.tsx` (flat `variant="outline"` for all)
 *
 * Pure utility — no React / i18n / framework imports. Server and client
 * components (and tests) can consume it identically.
 *
 * Usage:
 *   const props = getBroadcastStatusBadgeProps(status);
 *   <Badge variant={props.variant} className={cn(props.className)}>{label}</Badge>
 *
 * Spec reference: `BROADCAST_STATUSES` (8-state lifecycle) from
 * `src/modules/broadcasts/domain/value-objects/broadcast-status.ts`.
 * Exhaustiveness guaranteed at compile time via `Record<BroadcastStatus, …>`.
 */
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

export type BroadcastBadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost';

export interface BroadcastBadgeProps {
  readonly variant: BroadcastBadgeVariant;
  readonly className?: string;
}

const STATUS_STYLES: Record<BroadcastStatus, BroadcastBadgeProps> = {
  draft: { variant: 'outline', className: 'text-muted-foreground' },
  submitted: { variant: 'secondary' },
  approved: { variant: 'default' },
  sending: { variant: 'default', className: 'motion-safe:animate-pulse' },
  sent: { variant: 'default' },
  rejected: { variant: 'destructive' },
  cancelled: { variant: 'outline', className: 'text-muted-foreground' },
  failed_to_dispatch: { variant: 'destructive' },
};

export function getBroadcastStatusBadgeProps(
  status: BroadcastStatus,
): BroadcastBadgeProps {
  return STATUS_STYLES[status];
}
