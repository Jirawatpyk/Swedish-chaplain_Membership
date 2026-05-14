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
import { directorySearchWithCount } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
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
}

const VALID_STATUSES = new Set(['active', 'inactive', 'archived']);

const PAGE_SIZE = 50;

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

async function MembersDirectoryBody({
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

  const hasFilters =
    (query.q !== undefined && query.q.trim().length > 0) ||
    (query.status !== undefined && query.status !== 'all') ||
    (query.plan_id !== undefined && query.plan_id !== 'all') ||
    query.show_archived === '1';

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

  const rows: MembersTableRow[] = result.value.items.map((row) => ({
    member_id: row.member.memberId,
    company_name: row.member.companyName,
    country: row.member.country,
    plan_id: row.member.planId,
    plan_year: row.member.planYear,
    plan_display_name: row.planDisplayName,
    status: row.member.status,
    // F8 Phase 6 Wave H — wire risk score into the F3 column
    // placeholder. Null when at-risk recompute hasn't run yet (FR-035
    // min-tenure gate skips fresh members) → column renders "—".
    member_risk_flag:
      row.riskScore !== null && row.riskScoreBand !== null
        ? { score: row.riskScore, band: row.riskScoreBand }
        : null,
    last_activity_at: row.member.lastActivityAt?.toISOString() ?? null,
    notes: row.member.notes,
    primary_contact: row.primaryContact
      ? {
          contact_id: row.primaryContact.contactId,
          first_name: row.primaryContact.firstName,
          last_name: row.primaryContact.lastName,
          email: row.primaryContact.email,
        }
      : null,
  }));

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
          current role (admin: 10 cols incl. checkbox; manager: 9). */}
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
