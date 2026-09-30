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
import { canPerform, requirePagePermission } from '@/lib/rbac';
import type { Role } from '@/modules/auth/domain/role';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listPlans, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { PlansTable } from '@/components/plans/plans-table';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.plans');
  return { title: t('title') };
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
  const { user: currentUser } = await requirePagePermission('plans.read');
  const query = await searchParams;
  const t = await getTranslations('admin.plans');

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('listDescription')}
        actions={
          // 016 re-review D — evaluator-derived ('plans.write').
          canPerform(currentUser.role, 'plans.write') ? (
            <>
              {/* 122 US6 (T602): AURA buttons as the `Admin-plans` board draws
                  them; on a phone "New plan" comes first (`-mobile`). */}
              <Link href="/admin/plans/clone" className={buttonClass({ variant: 'secondary' })}>
                <CopyIcon aria-hidden="true" className="size-4" />
                {t('actions.cloneYear')}
              </Link>
              <Link
                href="/admin/plans/new"
                className={buttonClass({ variant: 'primary', className: 'max-sm:order-first' })}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                {t('actions.new')}
              </Link>
            </>
          ) : null
        }
      />

      {/* One card on a desktop; on a phone the rows are cards of their own,
          so this one drops its frame (AURA `flushBelow`). */}
      <Card flushBelow="sm">
          {/*
            No internal <Suspense> wrapper — the route-level loading.tsx
            is the single Suspense boundary and renders <PlanListSkeleton>
            with the real page shell. Double-wrapping caused the shimmer
            to run twice (once for loading.tsx, once for the inner
            boundary swap).
          */}
          <PlansList
            query={query}
            currentUserRole={currentUser.role}
          />
      </Card>
    </TableContainer>
  );
}

async function PlansList({
  query,
  currentUserRole,
}: {
  query: SearchParams;
  currentUserRole: Role;
}) {
  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const t = await getTranslations('admin.plans');

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
      taxPolicy: deps.taxPolicy,
      clock: deps.clock,
    },
  );

  if (!result.ok) {
    return (
      <p className="text-[var(--aura-fg-danger)]" role="alert">
        {result.error.type === 'fee_config_missing'
          ? t('errors.feeConfigMissing')
          : t('errors.loadFailed')}
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
