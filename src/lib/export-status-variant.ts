/**
 * Shared `ExportStatus → AURA StatusPill tone` mapping for the F9 directory
 * and data-export panels. The pill's text carries the meaning (WCAG 1.4.1);
 * the tone is a redundant visual cue. (The legacy Badge-variant map went with
 * the last shadcn consumer, 122 US5a.)
 */
import type { ExportStatus } from '@/modules/insights';

/**
 * Spec 122 US3 — the same statuses as AURA StatusPill tones, for the AURA
 * panels (the `Portal-account` boards): in flight = progress ("Preparing"),
 * ready/delivered = ready, failed = blocked, and expired = neutral — a link
 * that timed out is the normal end of an export, not a failure. Keyed by the
 * full `ExportStatus` union via `satisfies`, so a new status is a compile
 * error here, never a silent fall-through.
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
