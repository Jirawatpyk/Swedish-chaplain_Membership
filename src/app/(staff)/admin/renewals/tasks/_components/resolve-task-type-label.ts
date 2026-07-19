/**
 * F8 follow-up (`.superpowers/sdd/followup-tasktype-brief.md`) — pure
 * task-type label resolver for the escalation-task queue.
 *
 * Mirrors `src/lib/audit-event-label.ts`'s `EventLabelTranslator` +
 * `resolveEventLabel` pattern (and the identical inline
 * `t.has(...) ? t(...) : raw` guard already used for this exact
 * namespace on the cycle-detail page — see
 * `admin/renewals/[cycleId]/page.tsx:852`): the translator is next-
 * intl's `t` scoped to `admin.renewals.tasks` (a callable with a `.has`
 * guard — `useTranslations(...)`'s return value structurally satisfies
 * this), so the resolver defers to next-intl's OWN key-existence check
 * instead of duplicating a static whitelist.
 *
 * Why NOT `@/modules/renewals/client`'s `isKnownTaskType`: that list is
 * the StepCard's SUGGESTION catalogue (10 reminder-schedule task types)
 * — narrower than the full set of task types this queue actually
 * renders. The queue ALSO surfaces escalation-specific task types
 * created by other F8 paths (`verify_pending_tier_upgrade`,
 * `manual_outreach_required`, `termination_warning_blocked`,
 * `post_termination_payment_review`, `manual_admin_reactivation_review`
 * — see `create-escalation-task.ts` callers), which already have real
 * `admin.renewals.tasks.taskType.*` labels but were never part of the
 * reminder-schedule catalogue. Guarding on `isKnownTaskType` alone would
 * wrongly treat those five as "unknown" and regress their EXISTING
 * labels down to raw text — `t.has(...)` checks the actual loaded
 * translation catalogue, so it stays correct for both families at once.
 *
 * Extracted (rather than inlined at both call sites) for a unit-testable
 * seam — no React, no `useTranslations` — mirroring the sibling
 * `describe-error.ts`'s `selectActionErrorKey` convention.
 */

/** next-intl translator scoped to a namespace (callable + `.has` guard). */
export type TaskTypeTranslator = ((key: string) => string) & {
  has: (key: string) => boolean;
};

/**
 * Resolves a task type to its localised `taskType.<value>` label, or
 * falls back to the raw value when no such key exists in the active
 * locale — never throws, never renders next-intl's default dotted-key-
 * path fallback text (e.g. `"taskType.some_bespoke_type"`).
 */
export function resolveTaskTypeLabel(
  t: TaskTypeTranslator,
  taskType: string,
): string {
  const key = `taskType.${taskType}`;
  return t.has(key) ? t(key) : taskType;
}
