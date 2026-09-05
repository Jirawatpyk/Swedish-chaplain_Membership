/**
 * 108 PR-D (US4 — FR-027a, FR-035, FR-035b, FR-031a, FR-031b) — one page of
 * the Marketing audience: every non-removed contact of the tenant with its
 * DISPLAYED marketing state, the member facts that decide eligibility, and
 * the shared non-receipt reasons.
 *
 * Why the suppression list is fetched WHOLE for two filters. The state a
 * person sees is suppression > opt-out > on (FR-025), and suppression lives
 * in the broadcasts-owned list, not on `contacts`. A per-page lookup can
 * re-label rows but cannot make `state=on` EXCLUDE suppressed people from
 * the query (the pre-flight preset would then list people who will not
 * receive — the exact mistake FR-027a exists to prevent) or give a truthful
 * count for `state=unsubscribed`. So for those two filters the use case
 * fetches the tenant's suppressed set (bounded: one row per unsubscribe) and
 * hands it to the repo as an email leg. Every other filter resolves
 * suppression for the page's rows only.
 *
 * Degraded suppression (list unreadable): rows are still shown with every
 * state `'unavailable'` and no state reason (FR-031a / FR-035b) — except
 * `state=unsubscribed`, which has nothing truthful to show and returns
 * empty. Dispatch re-resolves suppression itself, so display honesty never
 * costs a delivery.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  deriveMarketingState,
  type ContactId,
  type MarketingOptOutSource,
  type MarketingState,
} from '../../domain/contact';
import type { MemberId, MemberStatus } from '../../domain/member';
import { marketingNonReceiptReasons, type MarketingReason } from '../../domain/marketing-reason';
import type { MarketingSuppressionLookupPort } from '../ports/marketing-suppression-lookup-port';
import type { MarketingAudienceRepoFilter, MemberRepo } from '../ports/member-repo';

/** FR-035: 50 rows per page for tenants with tens of thousands of contacts. */
export const MARKETING_AUDIENCE_PAGE_SIZE = 50;

/** `'unavailable'` is a display outcome, never something staff filter FOR. */
export type MarketingAudienceStateFilter = Exclude<MarketingState, 'unavailable'>;

export type MarketingAudienceFilter = {
  readonly q?: string;
  readonly memberId?: MemberId;
  readonly kind?: 'primary' | 'secondary';
  readonly state?: MarketingAudienceStateFilter;
  /** Member active + not erased + not halted (the default view). */
  readonly eligible: boolean;
};

export type MarketingAudienceRow = {
  readonly contactId: ContactId;
  readonly memberId: MemberId;
  readonly memberNumber: number;
  readonly companyName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly isPrimary: boolean;
  readonly memberStatus: MemberStatus;
  readonly memberHalted: boolean;
  readonly memberErased: boolean;
  readonly state: MarketingState;
  readonly reasons: readonly MarketingReason[];
  /** Who switched it off (a staff user id, or the contact's own login) — null when receiving. */
  readonly changedByUserId: string | null;
  readonly changedSource: MarketingOptOutSource | null;
  readonly changedAt: Date | null;
};

export type ListMarketingAudienceInput = {
  readonly filter: MarketingAudienceFilter;
  /** 1-based; anything below 1 (or NaN) clamps to 1. */
  readonly page: number;
};

export type ListMarketingAudienceDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: Pick<MemberRepo, 'listContactsForMarketingAudience'>;
  readonly marketingSuppression: Pick<
    MarketingSuppressionLookupPort,
    'listSuppressedEmailLowers' | 'lookupSuppressed'
  >;
};

export type ListMarketingAudienceError = {
  readonly type: 'server_error';
  readonly message: string;
};

export type ListMarketingAudienceResult = {
  readonly rows: readonly MarketingAudienceRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** True when the suppression list could not be read (states are `'unavailable'`). */
  readonly degraded: boolean;
};

function clampPage(page: number): number {
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

export async function listMarketingAudience(
  input: ListMarketingAudienceInput,
  deps: ListMarketingAudienceDeps,
): Promise<Result<ListMarketingAudienceResult, ListMarketingAudienceError>> {
  const page = clampPage(input.page);
  const pageSize = MARKETING_AUDIENCE_PAGE_SIZE;
  const { filter } = input;
  let degraded = false;

  // 1. Filters answered from the suppression list need the whole (bounded) set.
  let suppressedAll: ReadonlySet<string> | null = null;
  if (filter.state === 'on' || filter.state === 'unsubscribed') {
    try {
      suppressedAll = await deps.marketingSuppression.listSuppressedEmailLowers();
    } catch {
      degraded = true;
    }
  }

  const empty = (): ListMarketingAudienceResult => ({ rows: [], total: 0, page, pageSize, degraded });

  // `state=unsubscribed` IS the suppression list: unreadable → nothing truthful
  // to show; empty → nobody.
  if (filter.state === 'unsubscribed' && (degraded || suppressedAll!.size === 0)) {
    return ok(empty());
  }

  // 2. Page filter → repo predicate (no undefined keys: exactOptionalPropertyTypes).
  const repoFilter: MarketingAudienceRepoFilter = {
    eligibleOnly: filter.eligible,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    ...(filter.q !== undefined && { q: filter.q }),
    ...(filter.memberId !== undefined && { memberId: filter.memberId }),
    ...(filter.kind !== undefined && { kind: filter.kind }),
    ...(filter.state === 'on' && { optOut: 'none' as const }),
    ...(filter.state === 'off_by_staff' && { optOut: 'staff' as const }),
    ...(filter.state === 'off_by_contact' && { optOut: 'self' as const }),
    ...(filter.state === 'on' &&
      suppressedAll !== null &&
      suppressedAll.size > 0 && { emailLowerNotIn: [...suppressedAll] }),
    ...(filter.state === 'unsubscribed' &&
      suppressedAll !== null && { emailLowerIn: [...suppressedAll] }),
  };

  const listed = await deps.memberRepo.listContactsForMarketingAudience(deps.tenant, repoFilter);
  if (!listed.ok) {
    return err({ type: 'server_error', message: `audience: ${listed.error.code}` });
  }

  // 3. Suppression for the page's rows: reuse the whole set when it was
  //    fetched, else one batch lookup; a failure degrades every row.
  let suppressed: ReadonlySet<string> = new Set();
  if (!degraded && listed.value.rows.length > 0) {
    if (suppressedAll !== null) {
      suppressed = suppressedAll;
    } else {
      try {
        suppressed = await deps.marketingSuppression.lookupSuppressed(
          listed.value.rows.map((r) => r.contact.email.toLowerCase()),
        );
      } catch {
        degraded = true;
      }
    }
  }

  const rows: MarketingAudienceRow[] = listed.value.rows.map((r) => {
    const state = deriveMarketingState(
      r.contact.marketing,
      degraded ? 'unknown' : suppressed.has(r.contact.email.toLowerCase()),
    );
    return {
      contactId: r.contact.contactId,
      memberId: r.member.memberId,
      memberNumber: r.member.memberNumber,
      companyName: r.member.companyName,
      firstName: r.contact.firstName,
      lastName: r.contact.lastName,
      email: r.contact.email,
      isPrimary: r.contact.isPrimary,
      memberStatus: r.member.status,
      memberHalted: r.member.halted,
      memberErased: r.member.erased,
      state,
      reasons: marketingNonReceiptReasons({
        memberStatus: r.member.status,
        memberErased: r.member.erased,
        memberHalted: r.member.halted,
        contactRemoved: r.contact.removedAt !== null,
        state,
      }),
      changedByUserId: r.contact.marketing.byUserId,
      changedSource: r.contact.marketing.source,
      changedAt: r.contact.marketing.optedOutAt,
    };
  });

  return ok({ rows, total: listed.value.total, page, pageSize, degraded });
}
