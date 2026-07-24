/**
 * Plan-change UX P4 — map a tier-upgrade suggestion status to a shared
 * `<StatusBadge>` tone (ux-patterns § 6 — per-row state uses the canonical
 * semantic badge, not a hand-rolled `bg-secondary` pill that drifts from every
 * other state surface).
 *
 * The admin queue lists `open` + `accepted_pending_apply` rows, but the full
 * suggestion state machine has six discriminators — all are mapped so a future
 * status surfaced here can never fall through to an untoned pill:
 *   - open                   → info    (actionable, awaiting an admin decision)
 *   - accepted_pending_apply → warning (in-flight; applies at next renewal)
 *   - applied                → success (the upgrade took effect)
 *   - auto_resolved          → success (the system resolved it favourably)
 *   - dismissed / superseded → neutral (closed, no further action)
 *
 * Pure — no React import — so the mapping is unit-testable in isolation.
 */
import type { StatusBadgeProps } from '@/components/ui/status-badge';

type StatusBadgeTone = NonNullable<StatusBadgeProps['tone']>;

const STATUS_TONE: Readonly<Record<string, StatusBadgeTone>> = {
  open: 'info',
  accepted_pending_apply: 'warning',
  applied: 'success',
  auto_resolved: 'success',
  dismissed: 'neutral',
  superseded: 'neutral',
};

/**
 * Resolve a suggestion status to a StatusBadge tone. An unknown status
 * degrades to `neutral` rather than throwing — the pill is presentational and
 * must never crash the queue on an unmapped future state.
 */
export function tierUpgradeStatusTone(status: string): StatusBadgeTone {
  return STATUS_TONE[status] ?? 'neutral';
}
