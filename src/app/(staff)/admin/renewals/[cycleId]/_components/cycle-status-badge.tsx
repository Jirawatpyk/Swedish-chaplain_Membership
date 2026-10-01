/**
 * F8 cycle-status badge — Wave K27 / I-1.
 *
 * 122 US7b-1 (T721): an AURA `StatusPill` in the tone the member-detail
 * Renewal health card uses for the same status (`CYCLE_STATUS_TONE`), so a
 * cycle status reads the same in both places. Server-safe.
 */
import { StatusPill } from '@jirawatpyk/aura-react/server';
import type { CycleStatus } from '@/modules/renewals/client';
import { CYCLE_STATUS_TONE } from '@/components/renewals/cycle-status-tone';

export interface CycleStatusBadgeProps {
  readonly status: CycleStatus;
  readonly label: string;
  /**
   * Phase 6 review-round 2 C1 — translated screen-reader severity
   * suffix for severity-bearing statuses (`lapsed`,
   * `pending_admin_reactivation`). Caller resolves the locale; the badge
   * stays presentational + SSR-safe. `null`/`undefined`/empty → no suffix.
   */
  readonly srSuffix?: string | null;
}

export function CycleStatusBadge({ status, label, srSuffix }: CycleStatusBadgeProps) {
  return (
    <StatusPill tone={CYCLE_STATUS_TONE[status]}>
      {label}
      {srSuffix ? <span className="sr-only">{srSuffix}</span> : null}
    </StatusPill>
  );
}
