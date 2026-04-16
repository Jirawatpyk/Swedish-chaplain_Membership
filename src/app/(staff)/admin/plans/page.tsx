/**
 * T086 — /admin/plans list page (US1).
 *
 * Server component — reads directly from `listPlans` use case.
 * The table is a client component (filter bar + sort) but the data
 * loading happens here so the initial HTML ships with rows ready
 * (no skeleton flash on slow connections).
 *
 * Auth guard via `requireSession('staff')` at the staff shell layout;
 * this page re-validates RBAC on the read action via the same call
 * path the API route uses.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PlusIcon, CopyIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listPlans, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { PlansTable } from '@/components/plans/plans-table';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Plans · SweCham' };
}

interface SearchParams {
  readonly year?: string;
  readonly category?: string;
  readonly q?: string;
  readonly activeOnly?: string;
  readonly showDeleted?: string;
}

export default async function PlansListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user: currentUser } = await requireSession('staff');
  const query = await searchParams;
  const t = await getTranslations('admin.plans');

  return (
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('listDescription')}
        actions={
          currentUser.role === 'admin' ? (
            <>
              <Link
                href="/admin/plans/clone"
                className={buttonVariants({ variant: 'outline' })}
              >
                <CopyIcon className="h-3.5 w-3.5" />
                {t('actions.cloneYear')}
              </Link>
              <Link
                href="/admin/plans/new"
                className={buttonVariants()}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {t('actions.new')}
              </Link>
            </>
          ) : null
        }
      />

      <Card>
        <CardContent>
          {/*
            No internal <Suspense> wrapper — the route-level loading.tsx
            is the single Suspense boundary and renders <PlanListSkeleton>
            with the real page shell. Double-wrapping caused the shimmer
            to run twice (once for loading.tsx, once for the inner
            boundary swap).
          */}
          <PlansList
            query={query}
            currentUserRole={currentUser.role as 'admin' | 'manager' | 'member'}
          />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}

async function PlansList({
  query,
  currentUserRole,
}: {
  query: SearchParams;
  currentUserRole: 'admin' | 'manager' | 'member';
}) {
  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);

  const category = query.category === 'corporate' || query.category === 'partnership'
    ? query.category
    : null;

  const parsedYear = query.year ? Number(query.year) : NaN;
  const validYear =
    Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100;

  const filter: Parameters<typeof listPlans>[0]['filter'] = {
    ...(validYear ? { year: asPlanYear(parsedYear) } : {}),
    ...(category ? { category } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.activeOnly === 'true' ? { activeOnly: true } : {}),
    ...(query.showDeleted === 'true' ? { showDeleted: true } : {}),
  };

  const result = await listPlans(
    { filter },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      feeConfigRepo: deps.feeConfigRepo,
      clock: deps.clock,
    },
  );

  if (!result.ok) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {result.error.type === 'fee_config_missing'
          ? 'Tenant fee configuration not yet initialised. Run the seed script.'
          : 'Failed to load plans.'}
      </p>
    );
  }

  return (
    <PlansTable
      plans={result.value.data}
      currencyCode={result.value.meta.currency_code}
      year={result.value.meta.year}
      currentUserRole={currentUserRole}
      initialFilter={{
        category: result.value.meta.filter.category,
        q: result.value.meta.filter.q,
        activeOnly: result.value.meta.filter.activeOnly,
        showDeleted: result.value.meta.filter.showDeleted,
      }}
    />
  );
}
