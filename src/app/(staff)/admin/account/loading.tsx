/**
 * Spec 122 US10c (T1025): the account page's loading frame on AURA — the real
 * header with the email and role skeletoned, then the AURA card with the
 * explanation and the form skeleton.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('auth.changePassword');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer align="start" aria-busy="true">
        <PageHeader
          title={t('title')}
          subtitle={<SkeletonBlock className="h-4 w-56" />}
          badge={<SkeletonBlock className="h-5 w-20 rounded-full" />}
        />
        <Card>
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            <p className="aura-text-sm text-[var(--aura-fg-secondary)]">{t('description')}</p>
            <ChangePasswordFormSkeleton />
          </div>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
