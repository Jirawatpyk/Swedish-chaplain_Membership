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
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { DirectoryFilters } from '@/components/members/directory-filters';
import { type MembersTableRow } from '@/components/members/members-table';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';
import {
  MembersZeroState,
  MembersFilteredEmptyState,
  MembersErrorState,
} from '@/components/members/empty-states';
import { DirectoryWithBulk } from './_components/directory-with-bulk';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Members · SweCham' };
}

interface SearchParams {
  readonly q?: string;
  readonly show_archived?: string;
  readonly page?: string;
}

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
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          currentUser.role === 'admin' ? (
            <Link
              href="/admin/members/new"
              className={buttonVariants({ size: 'sm' })}
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {t('addMember')}
            </Link>
          ) : null
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <DirectoryFilters />
          <MembersDirectoryBody
            query={query}
            isAdmin={currentUser.role === 'admin'}
          />
        </CardContent>
      </Card>
    </ContentContainer>
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

  const hasFilters =
    (query.q !== undefined && query.q.trim().length > 0) ||
    query.show_archived === '1';

  const statuses = query.show_archived === '1'
    ? (['active', 'inactive', 'archived'] as const)
    : (['active', 'inactive'] as const);

  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const deps = buildMembersDeps(tenant);
  const result = await directorySearchWithCount(
    { tenant, memberRepo: deps.memberRepo },
    {
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      status: [...statuses],
      limit: PAGE_SIZE,
      offset,
    },
  );

  if (!result.ok) {
    return <MembersErrorState />;
  }

  if (result.value.items.length === 0) {
    return hasFilters ? <MembersFilteredEmptyState /> : <MembersZeroState />;
  }

  const rows: MembersTableRow[] = result.value.items.map((row) => ({
    member_id: row.member.memberId,
    company_name: row.member.companyName,
    country: row.member.country,
    plan_id: row.member.planId,
    plan_year: row.member.planYear,
    plan_display_name: row.planDisplayName,
    status: row.member.status,
    member_risk_flag: null,
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
    <Suspense fallback={<MembersTableSkeleton />}>
      <DirectoryWithBulk
        rows={rows}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.value.total}
        isAdmin={isAdmin}
      />
    </Suspense>
  );
}
