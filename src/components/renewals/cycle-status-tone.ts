/**
 * The AURA `StatusPill` tone for each renewal-cycle status, shared by the
 * cycle detail header and the member-detail Renewal health card (spec 122,
 * Clarifications, Session 2026-10-01 US7b start), so a cycle status reads the
 * same wherever it shows. The word carries the meaning; the tone only groups:
 * neutral before a bill exists, progress while one is open, warning while an
 * admin must decide, ready when renewed, blocked when closed unpaid.
 */
import type { CycleStatus } from '@/modules/renewals/client';

export type CycleStatusTone = 'neutral' | 'progress' | 'ready' | 'warning' | 'blocked';

export const CYCLE_STATUS_TONE: Readonly<Record<CycleStatus, CycleStatusTone>> = {
  upcoming: 'neutral',
  reminded: 'neutral',
  awaiting_payment: 'progress',
  pending_admin_reactivation: 'warning',
  completed: 'ready',
  lapsed: 'blocked',
  cancelled: 'blocked',
};
