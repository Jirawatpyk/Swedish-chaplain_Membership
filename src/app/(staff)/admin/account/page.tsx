import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';

/**
 * Staff account settings page (T154) at URL `/admin/account`.
 *
 * For F1 the only setting is password change. Future phases will
 * add profile, notification preferences, language selection, etc.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.changePassword');
  return { title: t('title') };
}

export default async function StaffAccountPage() {
  const { user } = await requireSession('staff');
  const t = await getTranslations('auth.changePassword');
  const tShell = await getTranslations('shell.roleBadge');

  return (
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={user.email}
        badge={<Badge variant="secondary">{tShell(user.role)}</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}
