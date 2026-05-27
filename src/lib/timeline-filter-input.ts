/**
 * F9 US3 — shared timeline filter-input resolution (review-run R2-7).
 *
 * The two load-more routes and the two SSR pages all turn the same
 * `{source, actorKind, from, to}` query values into the `timelineList` filter
 * fields (with `from`/`to` converted from a YYYY-MM-DD tenant-tz calendar day
 * to UTC bounds). Centralising the spread here removes the 4th copy (the
 * rule-of-three threshold). Each call site still owns its own date-validation
 * REACTION (routes → 400; pages → silently drop), so this helper takes
 * already-validated `fromYmd`/`toYmd`.
 */
import { tenantDayStartUtc, tenantDayEndUtc } from '@/lib/tenant-day-range';
import type { TimelineSource, TimelineActorKind } from '@/lib/timeline-shared';

export type TimelineFilterArgs = {
  readonly source?: TimelineSource | undefined;
  readonly actorKind?: TimelineActorKind | undefined;
  /** Already `isYmd`-validated calendar day, or undefined. */
  readonly fromYmd?: string | undefined;
  readonly toYmd?: string | undefined;
};

/** `timelineList` filter fields with `from`/`to` resolved to UTC bounds. */
export function buildTimelineFilterInput(
  args: TimelineFilterArgs,
  tz: string,
): {
  source?: TimelineSource;
  actorKind?: TimelineActorKind;
  from?: string;
  to?: string;
} {
  return {
    ...(args.source ? { source: args.source } : {}),
    ...(args.actorKind ? { actorKind: args.actorKind } : {}),
    ...(args.fromYmd ? { from: tenantDayStartUtc(args.fromYmd, tz) } : {}),
    ...(args.toYmd ? { to: tenantDayEndUtc(args.toYmd, tz) } : {}),
  };
}

/** Stable remount key for `<TimelineStream key={…}>` on filter change. */
export function timelineFilterKey(args: TimelineFilterArgs): string {
  return `${args.source ?? ''}|${args.actorKind ?? ''}|${args.fromYmd ?? ''}|${args.toYmd ?? ''}`;
}
