/**
 * F8 — client-safe re-export surface for the renewals bounded context.
 *
 * The full public barrel (`@/modules/renewals`) re-exports server-side
 * use-cases (cancel-cycle, dispatch-renewal-cycle, retry-failed-reminders,
 * etc.) which transitively pull in `@/lib/db`, `postgres`, `pino` and
 * other Node-only modules. Turbopack 16 walks barrel re-exports
 * eagerly when ANY client component imports from the barrel — even
 * type-only imports — so the result is "Module not found: 'fs' /
 * 'net' / 'worker_threads' / 'child_process'" build failures.
 *
 * This file exposes ONLY the client-safe surface (domain enums + value
 * objects + repo-port row shapes) so client components can import
 * type identifiers and tier-bucket arrays without dragging the
 * server-side graph into the browser bundle.
 *
 * Cross-module rule (Constitution Principle III): `client.ts` lives at
 * the module root — NOT inside `domain/`, `application/`, or
 * `infrastructure/` — so ESLint's no-restricted-imports allows
 * external consumers to import from here.
 *
 * Use this from `src/components/renewals/*`, `src/app/(staff)/admin/
 * renewals/_components/*`, and `src/app/(member)/portal/renewal/*`.
 * Server components + use-case callers should keep using the full
 * barrel (`@/modules/renewals`).
 */
export {
  TIER_BUCKETS,
  type TierBucket,
} from './domain/value-objects/tier-bucket';

export { type CycleStatus } from './domain/value-objects/cycle-status';

// WP3 — plan price-change classifier. Pure Domain TS (zero imports), so it is
// client-bundle-safe. Consumed by the portal renewal grouping + downgrade
// dialog; also exported from the full barrel for the server confirmRenewal gate.
export {
  classifyPlanPriceChange,
  requiresDowngradeAck,
  type PlanPriceChange,
} from './domain/plan-price-change';

// Outreach-channel canonical list — pure Domain TS (imports only
// `@/lib/result`), so it is client-bundle-safe. Consumed by the at-risk
// OutreachDialog channel <Select> (067 #4 review-fix — replaced a
// hand-maintained local copy in outreach-dialog.tsx).
export {
  OUTREACH_CHANNELS,
  type OutreachChannel,
} from './domain/at-risk-outreach';

export type {
  PipelineRow,
  UrgencyBucket,
} from './application/ports/renewal-cycle-repo';

// Renewals-by-month view-model types — pure Domain (client-bundle-safe).
export type {
  RenewalMonthBucket,
  RenewalMonthSummary,
  RenewalMonthAggregation,
} from './domain/renewal-month-bucket';

// Reminder-offset grammar — schedule editor constants and type guards.
// Pure domain, client-bundle-safe; consumed by tier-aware reminder UI.
export {
  RENEWAL_SCHEDULE_OFFSETS,
  TIER_REMINDER_OFFSETS,
  offsetKeyFromDays,
  daysFromOffsetKey,
  isScheduleOffset,
  type RenewalReminderOffset,
} from './domain/value-objects/reminder-offsets';

/**
 * Task-type catalogue (F8 follow-up — `.superpowers/sdd/followup-
 * tasktype-brief.md`). `task_type` is a free-form `string` on the task-
 * channel `ReminderStep` (see `domain/value-objects/reminder-step.ts`) —
 * this list is SUGGESTIONS only, sourced from the seed renewal policies
 * (`tests/integration/helpers/seed-renewal-policies.ts`), not an
 * exhaustive/authoritative production catalogue. The StepCard task-type
 * `<Combobox>` allows custom entry for anything outside this list, and
 * the escalation-task queue's filter falls back to the raw value for
 * unknowns — so an incomplete catalogue never loses or blocks a bespoke
 * value, it only affects whether that value gets a friendly label.
 */
export const RENEWAL_KNOWN_TASK_TYPES = [
  'phone_call',
  'admin_notify',
  'admin_notify_lapsed',
  'director_call',
  'quarterly_review_meeting',
  'meeting_proposed',
  'benefit_fulfillment_report',
  'contract_renewal',
  'in_person_meeting',
  'board_escalation',
] as const;
export type RenewalKnownTaskType = (typeof RENEWAL_KNOWN_TASK_TYPES)[number];
export function isKnownTaskType(v: string | undefined): v is RenewalKnownTaskType {
  return (RENEWAL_KNOWN_TASK_TYPES as readonly string[]).includes(v ?? '');
}
