/**
 * 059-membership-suspension covered-gate fix — shared predicate over
 * `UrgencyBucket` for the two PAST-DEADLINE tail values (`suspended` /
 * `terminated`), where the cycle's covered period has already ENDED and a
 * renewal is effectively owed. The six `t-*` values are the pre-expiry
 * countdown (still within the covered period) — see `urgency-pill.tsx`'s
 * module docstring for the full bucket list + colour rationale.
 *
 * Consumed by `pipeline-table.tsx` + `pipeline-card-list.tsx` (F8 pipeline
 * dashboard) to gate the green "Covered" invoice-cell label to pre-expiry
 * (countdown) urgency only — an anchored cycle whose urgency has already
 * crossed into `suspended`/`terminated` falls through to the existing "—"
 * instead, because there a renewal IS effectively owed and "Covered" would
 * misread as "nothing to do".
 *
 * Exhaustive `Record` (not a `===`/`||` chain) so a FUTURE past-deadline
 * bucket added to `UrgencyBucket`
 * (`src/modules/renewals/application/ports/renewal-cycle-repo.ts`) is a
 * compile error here, never a silent miss.
 */
import type { UrgencyBucket } from '@/modules/renewals/client';

const PAST_DEADLINE_URGENCY: Readonly<Record<UrgencyBucket, boolean>> = {
  't-90': false,
  't-60': false,
  't-30': false,
  't-14': false,
  't-7': false,
  't-0': false,
  suspended: true,
  terminated: true,
};

export function isPastDeadlineUrgency(urgency: UrgencyBucket): boolean {
  return PAST_DEADLINE_URGENCY[urgency];
}
