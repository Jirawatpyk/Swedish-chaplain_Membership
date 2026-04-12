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
import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PlusIcon, CopyIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listPlans, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { PlansTable } from '@/components/plans/plans-table';
import { PlanListSkeleton } from '@/components/plans/plan-list-skeleton';

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
    <main className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('listDescription')}</p>
        </div>
        <div className="flex items-center gap-2">
          {currentUser.role === 'admin' ? (
            <>
              <Link
                href="/admin/plans/clone"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <CopyIcon className="h-3.5 w-3.5" />
                {t('actions.cloneYear')}
              </Link>
              <Link
                href="/admin/plans/new"
                className={buttonVariants({ size: 'sm' })}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {t('actions.new')}
              </Link>
            </>
          ) : null}
          <Badge variant="secondary">{currentUser.role}</Badge>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading')}</CardTitle>
          <CardDescription>{t('refreshHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<PlanListSkeleton />}>
            <PlansList
              query={query}
              currentUserRole={currentUser.role as 'admin' | 'manager' | 'member'}
            />
          </Suspense>
        </CardContent>
      </Card>
    </main>
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

  const filter: Parameters<typeof listPlans>[0]['filter'] = {
    ...(query.year && !Number.isNaN(Number(query.year))
      ? { year: asPlanYear(Number(query.year)) }
      : {}),
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
