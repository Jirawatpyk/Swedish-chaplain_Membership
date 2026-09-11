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
import { buttonVariants } from '@/components/ui/button';

export default async function ChangeRequestNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.changeRequests.review');
  const tErrors = await getTranslations('errors');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <div data-testid="admin-change-request-not-found" className="rounded-md border p-8 text-center">
        <p className="text-sm text-muted-foreground">{tErrors('notFound')}</p>
        <Link href="/admin/members" className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-4 inline-flex items-center`}>
          <ArrowLeftIcon className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('backToMembers')}
        </Link>
      </div>
    </DetailContainer>
  );
}
