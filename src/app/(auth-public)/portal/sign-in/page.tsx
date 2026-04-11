import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { getCurrentSession } from '@/lib/auth-session';
import { safeReturnTo } from '@/lib/return-url';

/**
 * Member portal sign-in page (T143) at URL `/portal/sign-in`.
 *
 * Mirrors the staff pattern — lives in the `(auth-public)` route
 * group so it does NOT inherit `(member)/portal/layout.tsx`'s auth
 * guard. Reuses the shared `<SignInForm portal="member">` component.
 *
 * Reads the optional `returnTo` query param and validates via the
 * open-redirect guard before forwarding it to the form. Already
 * signed-in members skip straight to the preserved URL (or `/portal`
 * if none). Admins / managers who land here accidentally are
 * bounced to their own sign-in page (no auto-cross-portal auth).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn');
  return { title: t('title') };
}

interface MemberSignInPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}

export default async function MemberSignInPage({
  searchParams,
}: MemberSignInPageProps) {
  const { returnTo: rawReturnTo } = await searchParams;
  const returnToCandidate = Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo;
  const validatedReturnTo = safeReturnTo(returnToCandidate, 'member');

  const current = await getCurrentSession();
  if (current) {
    if (current.user.role === 'member') {
      redirect(validatedReturnTo ?? '/portal');
    }
    // Staff role signed in → bounce to their own portal
    redirect('/admin');
  }

  const t = await getTranslations('auth.signIn');

  return (
    <main className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between p-4">
        <div className="text-sm font-semibold tracking-tight">SweCham · Member</div>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>
              Thailand-Swedish Chamber of Commerce — member portal
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignInForm portal="member" returnTo={validatedReturnTo} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
