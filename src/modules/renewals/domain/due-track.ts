/**
 * 066 Round-2 §3.2 — the DUE-ANCHORED warning track (pure model).
 *
 * Two tier-less, CODE-DEFINED steps anchored on the member's oldest-due
 * unpaid membership bill (design §3.2(2)):
 *   due+7.email  — gentle overdue reminder
 *   due+30.email — firm warning carrying the bylaw termination sentence
 *
 * Deliberately NOT rows in `tenant_renewal_schedule_policies.steps_jsonb`:
 * policy steps are expires_at-anchored, per-tier, and admin-editable — a
 * tenant deleting a step must never be able to freeze terminations (the
 * §3.2(3) dormancy guard depends on these steps existing).
 *
 * NO staleness cutoff (unlike `findDueStepsForDate`'s 7-day
 * REMINDER_CATCH_UP_LOOKBACK_DAYS): a due step stays fireable until sent —
 * safe because (a) the (tenant, cycle, step_id, year_in_cycle) unique index
 * makes sends once-only and (b) the dormancy guard blocks termination until
 * the warning exists, so a late warning is still a pre-termination warning.
 *
 * Domain purity (Principle III): no framework imports — date math only.
 */

export const DUE_TRACK_STEP_IDS = ['due+7.email', 'due+30.email'] as const;
export type DueTrackStepId = (typeof DUE_TRACK_STEP_IDS)[number];

export interface DueTrackStep {
  readonly stepId: DueTrackStepId;
  readonly offsetDays: 7 | 30;
}

export const DUE_TRACK_STEPS: readonly DueTrackStep[] = [
  { stepId: 'due+7.email', offsetDays: 7 },
  { stepId: 'due+30.email', offsetDays: 30 },
];

/**
 * §3.2(3) minimum notice: a due_plus_60 termination may only fire when the
 * qualifying warning was dispatched at least this many days earlier. In the
 * normal path (warning at due+30, termination after due+60) this changes
 * nothing; it only extends runway when a warning fired late.
 */
export const MIN_WARNING_NOTICE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * Steps due as of `nowIso` for a bill due on `billDueDate` (Bangkok
 * 'YYYY-MM-DD', same convention as the invoice-due-bridge). A step is due
 * from (dueDate + offset) onward — no upper bound (see staleness note in
 * the module docblock). A malformed date yields no steps: fail-safe — no
 * send happens and the dormancy guard keeps deferring termination.
 */
export function findDueTrackStepsDue(
  billDueDate: string,
  nowIso: string,
): readonly DueTrackStep[] {
  const dueMs = Date.parse(`${billDueDate}T00:00:00.000Z`);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(dueMs) || !Number.isFinite(nowMs)) return [];
  return DUE_TRACK_STEPS.filter(
    (s) => nowMs >= dueMs + s.offsetDays * MS_PER_DAY,
  );
}

/**
 * §3.2(3) guard acceptance set: the due-track firm warning, or any
 * post-expiry ladder EMAIL step at t+7 or later — all of those bodies carry
 * the bylaw termination warning (§5.5 / copy.ts POST-EXPIRY set). t+0 and
 * pre-due steps deliberately do NOT count (they carry no warning), and
 * task-channel steps never reach the member's inbox.
 */
export function isStatutoryWarningStepId(stepId: string): boolean {
  if (stepId === 'due+30.email') return true;
  const m = /^t\+(\d+)\.email$/.exec(stepId);
  if (!m) return false;
  const days = Number(m[1]);
  return Number.isFinite(days) && days >= 7;
}

/**
 * The dormancy-guard predicate (§3.2(3)): true iff some reminder event is a
 * SENT statutory-warning EMAIL dispatched ≥ MIN_WARNING_NOTICE_DAYS before
 * `nowIso`. Parameter shape matches `ReminderEvent` structurally so the
 * caller can pass `reminderEventRepo.listForCycle(...)` rows straight in.
 */
export function hasSatisfiedWarningRequirement(
  events: ReadonlyArray<{
    readonly stepId: string;
    readonly status: string;
    readonly channel: string;
    readonly dispatchedAt: string | null;
  }>,
  nowIso: string,
): boolean {
  const cutoffMs = Date.parse(nowIso) - MIN_WARNING_NOTICE_DAYS * MS_PER_DAY;
  return events.some((e) => {
    if (e.status !== 'sent' || e.channel !== 'email') return false;
    if (!isStatutoryWarningStepId(e.stepId)) return false;
    if (e.dispatchedAt === null) return false;
    const sentMs = Date.parse(e.dispatchedAt);
    return Number.isFinite(sentMs) && sentMs <= cutoffMs;
  });
}
