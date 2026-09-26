/**
 * Shared `ExportStatus → Badge variant` mapping (M4).
 *
 * Text already encodes meaning (WCAG 1.4.1); the variant is a redundant visual
 * cue: ready/delivered = actionable (default), failed/expired = attention
 * (destructive), in-flight = neutral (secondary). Keyed by the full
 * `ExportStatus` union via `satisfies`, so adding a status is a compile error
 * here (no silent fall-through to a neutral badge).
 *
 * Extracted from the F9 directory + data-export panels, which had identical
 * copies of this map.
 */
import type { ExportStatus } from '@/modules/insights';

/** Narrowed subset of the Badge component's variant union used by export rows. */
export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export const STATUS_VARIANT = {
  requested: 'secondary',
  processing: 'secondary',
  ready: 'default',
  delivered: 'default',
  expired: 'destructive',
  failed: 'destructive',
} as const satisfies Record<ExportStatus, BadgeVariant>;

/** Maps an export status to its Badge variant. */
export function exportStatusVariant(status: ExportStatus): BadgeVariant {
  return STATUS_VARIANT[status];
}

/**
 * Spec 122 US3 — the same statuses as AURA Badge tones, for the AURA panels:
 * ready/delivered = done (success), failed/expired = attention (danger),
 * in-flight = neutral. Same `satisfies` guard as the map above.
 */
export type ExportStatusTone = 'neutral' | 'success' | 'danger';

export const STATUS_TONE = {
  requested: 'neutral',
  processing: 'neutral',
  ready: 'success',
  delivered: 'success',
  expired: 'danger',
  failed: 'danger',
} as const satisfies Record<ExportStatus, ExportStatusTone>;

/** Maps an export status to its AURA Badge tone. */
export function exportStatusTone(status: ExportStatus): ExportStatusTone {
  return STATUS_TONE[status];
}
