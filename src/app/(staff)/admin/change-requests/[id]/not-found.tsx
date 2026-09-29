/**
 * F114 — /admin/change-requests/[id] not-found UI: an unknown id, another
 * tenant's id (invisible under RLS) or the platform flag being off all land
 * here with a real 404 status (anti-enumeration, Principle I).
 */
import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';

export default async function ChangeRequestNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.changeRequests.review');
  const tErrors = await getTranslations('errors');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <div data-testid="admin-change-request-not-found">
        <EmptyState
          bordered
          headingLevel={2}
          icon="search"
          title={tErrors('notFound')}
          action={
            <Link href="/admin/members" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              {t('backToMembers')}
            </Link>
          }
        />
      </div>
    </DetailContainer>
  );
}
