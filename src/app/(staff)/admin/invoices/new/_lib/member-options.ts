/**
 * #82 — member options for the /admin/invoices/new membership tab.
 *
 * `directorySearch` returns at most `MEMBER_PRELOAD_LIMIT` rows (its clamp),
 * so the page preloads that many and the picker searches the server for the
 * rest. A deep-linked member (`?memberId=…`, the "New invoice" button on a
 * member page) outside the preload is added once, so the link always lands on
 * that member.
 */
import { formatCalendarYear } from '@/lib/format-date-localised';
import type { MemberOption } from '../../_components/invoice-form';

/** The members directory read's own ceiling (`directory-search.ts`). */
export const MEMBER_PRELOAD_LIMIT = 100;

/** "Company (Plan / year)", with the plan's display name when it is known. */
export function toMemberOption(
  m: {
    readonly memberId: string;
    readonly companyName: string;
    readonly planId: string;
    readonly planYear: number;
  },
  planLabels: ReadonlyMap<string, string>,
  locale: string,
): MemberOption {
  const planLabel = planLabels.get(m.planId) ?? m.planId;
  return {
    memberId: m.memberId,
    label: `${m.companyName} (${planLabel} / ${formatCalendarYear(m.planYear, locale)})`,
    currentPlanId: m.planId,
    currentPlanYear: m.planYear,
  };
}

/**
 * The options with the deep-linked member added at the end when the preload
 * does not hold it. Unchanged (same reference) otherwise.
 */
export function withDeepLinkedMember(
  members: readonly MemberOption[],
  deepLinked: MemberOption | null,
): readonly MemberOption[] {
  if (deepLinked === null) return members;
  if (members.some((m) => m.memberId === deepLinked.memberId)) return members;
  return [...members, deepLinked];
}
