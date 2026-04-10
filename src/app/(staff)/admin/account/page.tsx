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
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{user.email}</span>
          <Badge variant="secondary">{tShell(user.role)}</Badge>
        </div>
      </header>

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
    </div>
  );
}
