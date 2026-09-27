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
 * Spec 122 US3 — the same statuses as AURA StatusPill tones, for the AURA
 * panels (the `Portal-account` boards): in flight = progress ("Preparing"),
 * ready/delivered = ready, failed = blocked, and expired = neutral — a link
 * that timed out is the normal end of an export, not a failure. Same
 * `satisfies` guard as the map above.
 */
export type ExportStatusTone = 'neutral' | 'progress' | 'ready' | 'blocked';

export const STATUS_TONE = {
  requested: 'progress',
  processing: 'progress',
  ready: 'ready',
  delivered: 'ready',
  expired: 'neutral',
  failed: 'blocked',
} as const satisfies Record<ExportStatus, ExportStatusTone>;

/** Maps an export status to its AURA StatusPill tone. */
export function exportStatusTone(status: ExportStatus): ExportStatusTone {
  return STATUS_TONE[status];
}
