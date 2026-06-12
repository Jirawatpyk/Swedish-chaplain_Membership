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
  directorySearchWithCount,
  formatMemberNumber,
  MEMBER_STATUSES,
  resolveMemberNumberPrefix,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
// F9 (G1) — Engagement Score is projected SERVER-SIDE here (canonical, unit-
// tested) and passed to the client table as a ready value (no client-side
// projection / no insights-barrel import in the client component).
import { projectEngagementScore } from '@/modules/insights';
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
  MembersErrorState,
} from '@/components/members/empty-states';
import { DirectoryWithBulk } from './_components/directory-with-bulk';

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
}

const VALID_STATUSES = new Set<string>(MEMBER_STATUSES);
const VALID_RISK_BANDS = new Set([
  'healthy',
  'warning',
  'at-risk',
  'critical',
]);

const PAGE_SIZE = 50;

/**
 * Parse the `?sort=` URL param into the typed sort column the directory
 * use-case understands. Two server-side sortable columns exist today:
 *   - `engagement` (F9 FR-007a) — orders by the inverted F8 risk score.
 *   - `memberNumber` (055-member-number) — orders by the human-readable
 *     member number (ASC NULLS LAST; `desc` reverses).
 * Any other value (or absent) falls back to the default recency order.
 *
 * Exported + pure so the allow-list is unit-testable in isolation: this
 * boundary previously dropped `memberNumber`, leaving the "Member No."
 * column header a dead control (the arrow/aria-sort toggled but the rows
 * never re-ordered because the value never reached the search).
 */
export function parseDirectorySort(
  raw: string | undefined,
): 'engagement' | 'memberNumber' | undefined {
  return raw === 'engagement' || raw === 'memberNumber' ? raw : undefined;
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
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          currentUser.role === 'admin' ? (
            <Link
              href="/admin/members/new"
              className={buttonVariants()}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {t('addMember')}
            </Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
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

  // Resolve status filter — support new ?status= param + legacy ?show_archived=
  let statuses: readonly ('active' | 'inactive' | 'archived')[];
  if (query.status && VALID_STATUSES.has(query.status)) {
    statuses = [query.status as 'active' | 'inactive' | 'archived'];
  } else if (query.show_archived === '1') {
    statuses = ['active', 'inactive', 'archived'];
  } else {
    statuses = ['active', 'inactive'];
  }

  // S1-P1-6: accept a comma-separated band list (the dashboard "needs
  // attention" KPI drills into critical,at-risk,warning so the count matches
  // the destination). Each value is validated; a single value stays scalar.
  type RiskBandValue = 'healthy' | 'warning' | 'at-risk' | 'critical';
  const riskBandList = (query.risk_band ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter((b): b is RiskBandValue => VALID_RISK_BANDS.has(b));
  const riskBand: RiskBandValue | readonly RiskBandValue[] | undefined =
    riskBandList.length === 0
      ? undefined
      : riskBandList.length === 1
        ? riskBandList[0]
        : riskBandList;

  const hasFilters =
    (query.q !== undefined && query.q.trim().length > 0) ||
    (query.status !== undefined && query.status !== 'all') ||
    (query.plan_id !== undefined && query.plan_id !== 'all') ||
    query.show_archived === '1' ||
    riskBand !== undefined;

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

  const [result, plansResult] = await Promise.all([
    directorySearchWithCount(
      { tenant, memberRepo: deps.memberRepo },
      {
        ...(query.q?.trim() ? { q: query.q.trim() } : {}),
        ...(query.plan_id && query.plan_id !== 'all'
          ? { planId: query.plan_id }
          : {}),
        ...(riskBand ? { riskBand } : {}),
        ...(sort ? { sort, ...(order ? { order } : {}) } : {}),
        status: [...statuses],
        limit: PAGE_SIZE,
        offset,
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
  ]);

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
        <DirectoryFilters plans={planOptions} />
        <MembersErrorState />
      </>
    );
  }

  if (result.value.items.length === 0) {
    return (
      <>
        <DirectoryFilters plans={planOptions} />
        {hasFilters ? <MembersFilteredEmptyState /> : <MembersZeroState />}
      </>
    );
  }

  // 055-member-number — resolve the per-tenant prefix ONCE (RLS-safe shared
  // helper) and format every row's display number (`SCCM-0042`) server-side,
  // mirroring the admin detail page. Falls back to the column DEFAULT 'M'
  // when no settings row exists (no visible error).
  const memberPrefix = await resolveMemberNumberPrefix(
    tenant,
    deps.memberSettings,
  );

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
      <DirectoryFilters plans={planOptions} />
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
