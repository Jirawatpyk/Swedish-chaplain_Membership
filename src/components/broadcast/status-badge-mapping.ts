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
  // F7.1a US1 (Phase 3 B0 — added 2026-05-19). `partially_sent` is
  // non-terminal with admin retry/accept actions; use `destructive`
  // variant to signal attention needed. `partial_delivery_accepted`
  // is terminal-after-admin-accept; muted secondary matches `cancelled`
  // visual weight (operational end-state, not error).
  // Phase 3F.7 (UX F-5 fix) — motion-reduce users get a static ring
  // instead of the missed pulse animation. Without this, reduced-
  // motion preference would suppress the "attention needed" visual
  // affordance entirely → admin might miss the partially-sent
  // actionable state.
  // Phase 3F.11.2 (H3 — Round 2 fix) — ring color was
  // `ring-destructive/60` on `bg-destructive` background ≈ <3:1
  // contrast, failing WCAG SC 1.4.11 (Non-text Contrast). Switched
  // to `ring-background` (light ring on red bg) which yields ≥4.5:1.
  partially_sent: {
    variant: 'destructive',
    className:
      'motion-safe:animate-pulse motion-reduce:ring-2 motion-reduce:ring-background motion-reduce:ring-offset-1',
  },
  partial_delivery_accepted: { variant: 'secondary', className: 'text-muted-foreground' },
};

export function getBroadcastStatusBadgeProps(
  status: BroadcastStatus,
): BroadcastBadgeProps {
  return STATUS_STYLES[status];
}
