/**
 * Plan-change UX P4 — map a tier-upgrade suggestion status to an AURA
 * `StatusPill` tone (122 US7b-1, T725; per-row state uses the shared pill,
 * not a hand-rolled one).
 *
 * The admin queue lists `open` + `accepted_pending_apply` rows, but the full
 * suggestion state machine has six discriminators — all are mapped so a future
 * status surfaced here can never fall through to an untoned pill:
 *   - open                   → progress (actionable, awaiting an admin decision)
 *   - accepted_pending_apply → warning  (in-flight; applies at next renewal)
 *   - applied                → ready    (the upgrade took effect)
 *   - auto_resolved          → ready    (the system resolved it favourably)
 *   - dismissed / superseded → neutral  (closed, no further action)
 *
 * Pure — no React import — so the mapping is unit-testable in isolation.
 */
export type TierUpgradeStatusTone = 'neutral' | 'progress' | 'ready' | 'warning' | 'blocked';

const STATUS_TONE: Readonly<Record<string, TierUpgradeStatusTone>> = {
  open: 'progress',
  accepted_pending_apply: 'warning',
  applied: 'ready',
  auto_resolved: 'ready',
  dismissed: 'neutral',
  superseded: 'neutral',
};

/**
 * Resolve a suggestion status to a pill tone. An unknown status degrades to
 * `neutral` rather than throwing — the pill is presentational and must never
 * crash the queue on an unmapped future state.
 */
export function tierUpgradeStatusTone(status: string): TierUpgradeStatusTone {
  return STATUS_TONE[status] ?? 'neutral';
}
