/**
 * F8 Phase 4 Wave I2a · T092 — `pause-reminders-after-outreach` use-case.
 *
 * Per FR-033 (P5-r1): when an admin records an at-risk outreach
 * ("I emailed them" / "I called them" / "I met them"), the daily
 * reminder cron MUST skip email steps for that member for the next
 * 7 days. Prevents an admin's personal phone call from colliding with
 * a system-dispatched form email.
 *
 * The pause is **stateless and read-derived** — there is no separate
 * `paused_until` column. The dispatcher (T088) calls this use-case
 * once per candidate member; we look at `at_risk_outreach` rows in
 * the last 7 days. Pause auto-expires after 7 days because the
 * window slides forward.
 *
 * Returns:
 *   - `{ paused: false }` when no outreach in window
 *   - `{ paused: true, latestOutreachAt, expiresAt }` when paused
 *
 * This use-case is **NO-AUDIT** — it's a pure read. The dispatcher
 * emits `renewal_reminder_skipped {reason: 'outreach_in_progress'}`
 * with `latest_outreach_at` payload when it acts on the pause result.
 *
 * The audit emit is at the dispatch site (T088), not here, so we
 * preserve the contract that "skip" audit events are owned by the
 * decision site that actually skipped (single-place-of-truth).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

/**
 * Default reminder pause window per FR-033 (P5-r1). Exported so the
 * dispatcher and tests can reference the canonical value.
 */
export const REMINDER_PAUSE_WINDOW_DAYS = 7 as const;

export const pauseRemindersAfterOutreachInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /**
   * Optional override — defaults to FR-033 canonical 7-day window.
   * Tests pass shorter windows to exercise boundary conditions; future
   * per-tenant configurability would land here without port-shape
   * change.
   */
  withinDays: z.number().int().min(1).max(365).optional(),
});

export type PauseRemindersAfterOutreachInput = z.infer<
  typeof pauseRemindersAfterOutreachInputSchema
>;

export interface PausedResult {
  readonly paused: true;
  readonly latestOutreachAt: string;
  readonly windowDays: number;
  /** ISO timestamp = `latestOutreachAt + windowDays`. */
  readonly expiresAt: string;
}

export interface NotPausedResult {
  readonly paused: false;
}

export type PauseRemindersAfterOutreachOutput =
  | PausedResult
  | NotPausedResult;

export type PauseRemindersAfterOutreachError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export async function pauseRemindersAfterOutreach(
  deps: RenewalsDeps,
  rawInput: PauseRemindersAfterOutreachInput,
): Promise<
  Result<
    PauseRemindersAfterOutreachOutput,
    PauseRemindersAfterOutreachError
  >
> {
  return withActiveSpan(
    renewalsTracer(),
    'pause_reminders_check',
    { 'tenant.id': rawInput.tenantId },
    async (span) => {
      const result = await pauseInner();
      if (result.ok) {
        span.setAttribute('renewals.paused', result.value.paused);
      }
      return result;
    },
  );

  async function pauseInner(): Promise<
    Result<
      PauseRemindersAfterOutreachOutput,
      PauseRemindersAfterOutreachError
    >
  > {
  const parsed = pauseRemindersAfterOutreachInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const { tenantId, memberId } = parsed.data;
  const windowDays = parsed.data.withinDays ?? REMINDER_PAUSE_WINDOW_DAYS;

  const window = await deps.atRiskOutreachReadRepo.hasOutreachWithinDays(
    tenantId,
    memberId,
    windowDays,
  );
  if (!window.hasOutreach || window.latestAt === null) {
    return ok({ paused: false });
  }
  // Compute `latestAt + windowDays` as the pause-expiry timestamp.
  const latestMs = new Date(window.latestAt).getTime();
  const expiresMs = latestMs + windowDays * 24 * 60 * 60 * 1000;
  return ok({
    paused: true,
    latestOutreachAt: window.latestAt,
    windowDays,
    expiresAt: new Date(expiresMs).toISOString(),
  });
  }
}
