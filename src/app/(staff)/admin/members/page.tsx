/**
 * T064 — /admin/members directory page (US2).
 *
 * Server component — loads directly from `directorySearch` use case.
 * Filter bar + table are client components; the query runs server-side
 * so the initial HTML ships with rows ready. Route-level loading.tsx
 * provides the shimmer skeleton on navigation (CLS 0).
 *
 * Three distinct FR-034 empty states:
 *   (a) No filters active + zero rows → onboarding CTA
 *   (b) Filters active + zero rows → "clear filters" CTA
 *   (c) Use case error → error state with retry
 */

import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PlusIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  countMembersNeedingPortalInvite,
  directorySearchWithCount,
  formatMemberNumber,
  loadMembersPortalStatus,
  resolveMemberNumberPrefix,
  type PortalState,
} from '@/modules/members';
import {
  parseDirectoryFilterFromParams,
  parseDirectorySort,
} from '@/lib/members-directory-filter';
// Re-exported so existing page-boundary wiring tests keep importing the
// allow-list from this route module (canonical source now lives in the lib).
export {
  parsePortalFilter,
  parseDirectorySort,
} from '@/lib/members-directory-filter';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
// F9 (G1) — Engagement Score is projected SERVER-SIDE here (canonical, unit-
// tested) and passed to the client table as a ready value (no client-side
// projection / no insights-barrel import in the client component).
import { projectEngagementScore } from '@/modules/insights';
// #4 — lapsed-membership badge enrichment. Renewals is a secondary read on the
// directory hot path; the wrapper below degrades to "no badges" on any failure.
// 067 #4 review-fix — `makeMembersMembershipStatusDeps` builds only the two
// deps this read needs (`cyclesRepo` + `clock`) instead of the full ~20-adapter
// `makeRenewalsDeps` on every directory render.
import {
  loadMembersMembershipStatus,
  makeMembersMembershipStatusDeps,
  type MembersMembershipStatus,
} from '@/modules/renewals';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  DirectoryFilters,
  type PlanOption,
} from '@/components/members/directory-filters';
import { type MembersTableRow } from '@/components/members/members-table';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';
import {
  MembersZeroState,
  MembersFilteredEmptyState,
  MembersAllInvitedEmptyState,
  MembersErrorState,
} from '@/components/members/empty-states';
import { DirectoryWithBulk } from './_components/directory-with-bulk';
import { ExportBackupButton } from './_components/export-backup-button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.members');
  // Layout template appends "· SweCham Membership"; bare title here.
  return { title: t('title') };
}

interface SearchParams {
  readonly q?: string;
  readonly status?: string;
  readonly plan_id?: string;
  readonly show_archived?: string;
  readonly page?: string;
  /** I1 round-10 — quick filter on F8-derived risk score band. */
  readonly risk_band?: string;
  /** F9 FR-007a — engagement column sort. */
  readonly sort?: string;
  readonly order?: string;
  /** Needs-invite chip (design doc §3.6). Only 'needs_invite' is honoured. */
  readonly portal?: string;
}

const PAGE_SIZE = 50;

/** Empty membership-status result — used by the degrade path below. */
const EMPTY_MEMBERSHIP_STATUS: MembersMembershipStatus = {
  lapsed: new Set<string>(),
  suspended: new Set<string>(),
};

/**
 * Best-effort lapsed/suspended-membership enrichment. Renewals is a secondary
 * read on the member-directory hot path — a failure must NEVER take down the
 * directory.
 *
 * The use-case is typed `Result<…, never>`: it has no domain-error branch, so
 * the ONLY live failure mode is a thrown repo call (a `runInTenant` query can
 * throw). `res.ok` is therefore always `true`; the lone live path is the catch,
 * which logs one PII-safe warn (errKind + memberIdsCount, no ids) and degrades
 * to "no badges" (both sets empty).
 */
async function loadMembersMembershipStatusSafe(
  tenant: ReturnType<typeof resolveTenantFromRequest>,
  memberIds: readonly string[],
): Promise<MembersMembershipStatus> {
  try {
    const res = await loadMembersMembershipStatus(
      makeMembersMembershipStatusDeps(tenant.slug),
      { tenantId: tenant.slug, memberIds },
    );
    return res.ok ? res.value : EMPTY_MEMBERSHIP_STATUS;
  } catch (e) {
    logger.warn(
      {
        tenantId: tenant.slug,
        errKind: errKind(e),
        memberIdsCount: memberIds.length,
      },
      '[members-lapsed] loadMembersMembershipStatus threw — badges suppressed',
    );
    return EMPTY_MEMBERSHIP_STATUS;
  }
}

/**
 * Best-effort portal-status enrichment. A failure must NEVER take down the
 * directory — but it must also never look like an answer: on failure every
 * member degrades to 'unknown' (renders nothing), never to 'not_invited',
 * which would claim they still need inviting.
 */
async function loadMembersPortalStatusSafe(
  tenant: ReturnType<typeof resolveTenantFromRequest>,
  memberRepo: ReturnType<typeof buildMembersDeps>['memberRepo'],
  membersOnPage: readonly {
    readonly memberId: string;
    readonly linkedUserId: string | null;
  }[],
  now: Date,
): Promise<ReadonlyMap<string, PortalState> | null> {
  try {
    const res = await loadMembersPortalStatus(
      { tenant, memberRepo },
      { members: membersOnPage, now },
    );
    return res.ok ? res.value : null;
  } catch (e) {
    logger.warn(
      {
        tenantId: tenant.slug,
        errKind: errKind(e),
        memberIdsCount: membersOnPage.length,
      },
      '[members-portal] loadMembersPortalStatus threw — portal badges suppressed',
    );
    return null;
  }
}

/**
 * Best-effort chip count. Returns `null` — NOT 0 — on failure: an absent chip
 * means "everyone has been invited" (D5), so rendering 0 after a failed read
 * would tell the operator the work is done while 12 members are still waiting.
 * The chip renders a disabled "unavailable" state for null.
 */
async function countMembersNeedingPortalInviteSafe(
  tenant: ReturnType<typeof resolveTenantFromRequest>,
  memberRepo: ReturnType<typeof buildMembersDeps>['memberRepo'],
  filter: Parameters<typeof countMembersNeedingPortalInvite>[1],
): Promise<number | null> {
  try {
    const res = await countMembersNeedingPortalInvite(
      { tenant, memberRepo },
      filter,
    );
    return res.ok ? res.value : null;
  } catch (e) {
    logger.warn(
      { tenantId: tenant.slug, errKind: errKind(e) },
      '[members-portal] chip count threw — chip shows unavailable',
    );
    return null;
  }
}

export default async function MembersListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user: currentUser } = await requireSession('staff');
  const query = await searchParams;
  const t = await getTranslations('admin.members');

  return (
    // #7 sticky header (members-directory ONLY). The page is bounded to the
    // viewport height BELOW the app top bar (BreadcrumbNav renders nothing on
    // this route — it needs ≥2 path segments — so the top bar is the only chrome
    // above the page). Everything inside then distributes with flexbox: the
    // table's scroll region (MembersTable → the `containerClassName="flex-1
    // min-h-0"` Table wrapper) grows to fill exactly the space left by the
    // PageHeader + filters + optional chip row + pagination, so the PAGE never
    // scrolls (no outer scrollbar beside the table's own) and there is no dead
    // space regardless of whether the filter-chip row is shown — no magic
    // reserve constant to keep in sync. `min-h-0` at each level lets the table
    // shrink instead of forcing the column past the viewport.
    <TableContainer className="h-[calc(100dvh-var(--top-bar-height))] min-h-0 overflow-hidden">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          currentUser.role === 'admin' ? (
            <div className="flex items-center gap-2">
              <ExportBackupButton />
              <Link
                href="/admin/members/new"
                className={buttonVariants()}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {t('addMember')}
              </Link>
            </div>
          ) : null
        }
      />

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
          <MembersDirectoryBody
            query={query}
            isAdmin={currentUser.role === 'admin'}
          />
        </CardContent>
      </Card>
    </TableContainer>
  );
}

// Exported for the page-boundary wiring test (proves `?sort=memberNumber`
// is forwarded to `directorySearchWithCount`). Not part of the route's
// public contract — the default export is the only rendered entry point.
export async function MembersDirectoryBody({
  query,
  isAdmin,
}: {
  query: SearchParams;
  isAdmin: boolean;
}) {
  const tenant = resolveTenantFromRequest();

  // WHERE-shaping filter (status / risk band / needs-invite / q / planId +
  // hasFilters) — parsed by the shared allow-list so the visible page and the
  // select-all-matching ids endpoint (src/app/api/members/ids/route.ts) can
  // never disagree on what the filter matches. `hasFilters` folding in
  // portalNeedsInvite is what keeps a filtered-to-zero directory from rendering
  // the "add your first member" onboarding screen to a 131-member tenant.
  const {
    q: filterQ,
    planId: filterPlanId,
    status: statuses,
    riskBand,
    portalNeedsInvite,
    hasFilters,
  } = parseDirectoryFilterFromParams(query);

  // Sort allow-list: F9 FR-007a engagement column + 055-member-number's
  // "Member No." column (see parseDirectorySort). Both are server-side sorts
  // handled by searchDirectoryWithCount; any other value falls back to the
  // default recency order.
  const sort = parseDirectorySort(query.sort);
  const order =
    query.order === 'asc' ? ('asc' as const) : query.order === 'desc' ? ('desc' as const) : undefined;

  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // Load plan list for the filter dropdown (parallel with directory query)
  const plansDeps = buildPlansDeps(tenant);
  const deps = buildMembersDeps(tenant);

  // D8 — ONE instant for every expiry decision on this render. Hoisted above
  // the first `Promise.all` (rather than declared beside the badge read
  // below) so the needs-invite chip COUNT and the visible badges judge
  // invitation expiry against the same moment.
  const now = new Date();

  const directoryFilter = {
    ...(filterQ !== undefined ? { q: filterQ } : {}),
    ...(filterPlanId !== undefined ? { planId: filterPlanId } : {}),
    ...(riskBand ? { riskBand } : {}),
    ...(sort ? { sort, ...(order ? { order } : {}) } : {}),
    status: [...statuses],
    limit: PAGE_SIZE,
    offset,
  };

  const [result, plansResult, portalInviteCountRaw] = await Promise.all([
    directorySearchWithCount(
      { tenant, memberRepo: deps.memberRepo },
      {
        ...directoryFilter,
        ...(portalNeedsInvite ? { portalNeedsInvite: { now } } : {}),
      },
    ),
    listPlans(
      { filter: {} },
      {
        tenant: plansDeps.tenant,
        planRepo: plansDeps.planRepo,
        taxPolicy: plansDeps.taxPolicy,
        clock: plansDeps.clock,
      },
    ),
    // Needs-invite chip count (design doc §3.7, D7).
    //
    // When the chip filter is ACTIVE the visible list is ALREADY the
    // needs-invite set, so its total (`result.value.total`) IS the chip count —
    // issuing a second, identical `count(*)` here would just duplicate it, so we
    // skip it and derive the count from the list total below. When the chip is
    // INACTIVE the two genuinely differ (all-members list vs needs-invite
    // subset), so the count runs.
    //
    // The count consumes only the WHERE-shaping fields; `sort`/`order` and the
    // page `offset` are irrelevant to a `count(*)`, so pass a filter without
    // them (limit/offset are still required by DirectoryOffsetFilter's type and
    // are ignored by the count query).
    portalNeedsInvite
      ? Promise.resolve(null)
      : countMembersNeedingPortalInviteSafe(tenant, deps.memberRepo, {
          ...(filterQ !== undefined ? { q: filterQ } : {}),
          ...(filterPlanId !== undefined ? { planId: filterPlanId } : {}),
          ...(riskBand ? { riskBand } : {}),
          status: [...statuses],
          limit: PAGE_SIZE,
          offset: 0,
          portalNeedsInvite: { now },
        }),
  ]);

  // #2 — reuse the list total as the chip count when the chip filtered the list
  // (see the Promise.all comment). On a search error the chip degrades to
  // `null` (unavailable), consistent with the badge/count degrade contract.
  const portalInviteCount = portalNeedsInvite
    ? result.ok
      ? result.value.total
      : null
    : portalInviteCountRaw;

  // Build plan options for the filter dropdown
  const planOptions: PlanOption[] = plansResult.ok
    ? plansResult.value.data.map((p) => ({
        id: p.plan_id,
        label:
          (p.plan_name as Record<string, string>).en ??
          (p.plan_name as Record<string, string>).th ??
          p.plan_id,
      }))
    : [];

  if (!result.ok) {
    return (
      <>
        <DirectoryFilters plans={planOptions} portalInviteCount={portalInviteCount} />
        <MembersErrorState />
      </>
    );
  }

  if (result.value.items.length === 0) {
    return (
      <>
        <DirectoryFilters plans={planOptions} portalInviteCount={portalInviteCount} />
        {/* Task 11 — the needs-invite chip filtered to zero rows gets its own
            "everyone has been invited" state (design doc §3.6/§3.7), distinct
            from the generic "no members match these filters" state used by
            every other filter combination. `hasFilters` (which folds in
            portalNeedsInvite) still gates the zero-members onboarding screen. */}
        {portalNeedsInvite ? (
          <MembersAllInvitedEmptyState />
        ) : hasFilters ? (
          <MembersFilteredEmptyState />
        ) : (
          <MembersZeroState />
        )}
      </>
    );
  }

  // 055-member-number — resolve the per-tenant prefix ONCE (RLS-safe shared
  // helper) and format every row's display number (`SCCM-0042`) server-side,
  // mirroring the admin detail page. Falls back to the column DEFAULT 'M'
  // when no settings row exists (no visible error).
  // #4 / Task 16 — overlap the renewals "lapsed"+"suspended" batch read with
  // the prefix fetch: both depend only on the already-resolved search result,
  // so run them together. The read is best-effort (degrades to both sets
  // empty → no badges).
  const memberIds = result.value.items.map((row) => row.member.memberId);
  const [memberPrefix, membershipStatus, portalStatus] = await Promise.all([
    resolveMemberNumberPrefix(tenant, deps.memberSettings),
    loadMembersMembershipStatusSafe(tenant, memberIds),
    loadMembersPortalStatusSafe(
      tenant,
      deps.memberRepo,
      result.value.items.map((row) => ({
        memberId: row.member.memberId,
        linkedUserId: row.primaryContact?.linkedUserId ?? null,
      })),
      now,
    ),
  ]);

  const rows: MembersTableRow[] = result.value.items.map((row) => {
    // F9 (G1) — server-side engagement projection (inverse of F8 risk).
    const eng = projectEngagementScore({
      riskScore: row.riskScore,
      riskScoreBand: row.riskScoreBand,
    });
    return {
    member_id: row.member.memberId,
    member_number_display: formatMemberNumber(
      memberPrefix,
      row.member.memberNumber,
    ),
    company_name: row.member.companyName,
    country: row.member.country,
    plan_id: row.member.planId,
    plan_year: row.member.planYear,
    plan_display_name: row.planDisplayName,
    status: row.member.status,
    membership_lapsed: membershipStatus.lapsed.has(row.member.memberId),
    membership_suspended: membershipStatus.suspended.has(row.member.memberId),
    portal_state:
      row.primaryContact === null
        ? null
        : portalStatus === null
          ? 'unknown'
          : (portalStatus.get(row.member.memberId) ?? 'unknown'),
    // 056-members-table-compact — engagement (the positive-framed inverse of
    // the F8 risk score) is now the sole at-risk surface in the table; the raw
    // risk score is no longer wired into the row (the Risk column was dropped).
    engagement:
      eng.score !== null && eng.band !== null
        ? { score: eng.score, band: eng.band }
        : null,
    last_activity_at: row.member.lastActivityAt?.toISOString() ?? null,
    primary_contact: row.primaryContact
      ? {
          contact_id: row.primaryContact.contactId,
          first_name: row.primaryContact.firstName,
          last_name: row.primaryContact.lastName,
          email: row.primaryContact.email,
          // Task 10 (staff-invitation-lifecycle) — invite_bounced_at is only
          // meaningful while a user is still linked. A staff Revoke/Prune
          // hard-deletes the pending user, which `ON DELETE SET NULL`s
          // contacts.linked_user_id; without the linkedUserId check a bounce
          // recorded before the revoke would leave this badge stuck forever
          // (resendBouncedInvite requires linkedUserId, so it can never
          // clear the flag). Self-heals the read the moment the FK nulls out.
          invite_bounced:
            row.primaryContact.inviteBouncedAt !== null &&
            row.primaryContact.linkedUserId !== null,
        }
      : null,
    };
  });

  // Round-2 review I-3 + round-3 review S-1: Suspense boundary around the
  // client component that calls useSearchParams — prevents the whole route
  // from bailing out of server rendering. Fallback renders the same
  // shimmer skeleton as /members loading.tsx to avoid CLS during
  // hydration transitions.
  return (
    <>
      <DirectoryFilters plans={planOptions} portalInviteCount={portalInviteCount} />
      {/* C1 round-10 — pass `withSelection={isAdmin}` so the
          shimmer-skeleton column count matches the real table for the
          current role. 056-members-table-compact: admin 8 cols incl.
          checkbox; manager 7. */}
      <Suspense fallback={<MembersTableSkeleton withSelection={isAdmin} />}>
        <DirectoryWithBulk
          rows={rows}
          page={page}
          pageSize={PAGE_SIZE}
          total={result.value.total}
          isAdmin={isAdmin}
        />
      </Suspense>
    </>
  );
}
