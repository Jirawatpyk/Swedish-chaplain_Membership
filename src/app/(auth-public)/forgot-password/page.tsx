import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { ThemeToggle } from '@/components/shell/theme-toggle';

/**
 * Forgot-password page (T106) at URL `/forgot-password`.
 *
 * Shared across staff and member portals — no portal prefix in the
 * URL because the user may not remember which portal they belong to,
 * and the API never leaks the difference (spec FR-016).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgotPassword');
  return {
    title: t('title'),
  };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth.forgotPassword');

  return (
    <main className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between p-4">
        <div className="text-sm font-semibold tracking-tight">{process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}</div>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ForgotPasswordForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
