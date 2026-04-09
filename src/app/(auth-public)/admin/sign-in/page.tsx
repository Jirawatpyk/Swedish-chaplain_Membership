import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { getCurrentSession } from '@/lib/auth-session';

/**
 * Staff portal sign-in page (T073) at URL `/admin/sign-in`.
 *
 * Lives in the `(auth-public)` route group so it does NOT inherit the
 * `(staff)/admin/layout.tsx` auth guard. The route group is invisible
 * in the URL — Next.js resolves `/admin/sign-in` to this file because
 * it is the only `app/admin/sign-in/page.tsx` across all groups.
 *
 * Redirects already-signed-in staff to `/admin`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn');
  return {
    title: t('title'),
  };
}

export default async function StaffSignInPage() {
  const current = await getCurrentSession();
  if (current && (current.user.role === 'admin' || current.user.role === 'manager')) {
    redirect('/admin');
  }

  const t = await getTranslations('auth.signIn');

  return (
    <main className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between p-4">
        <div className="text-sm font-semibold tracking-tight">SweCham · Staff</div>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>
              Thailand-Swedish Chamber of Commerce — staff portal
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignInForm portal="staff" />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
