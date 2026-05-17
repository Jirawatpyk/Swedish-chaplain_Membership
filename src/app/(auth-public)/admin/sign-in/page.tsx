import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignInForm } from '@/components/auth/sign-in-form';
import { SecurityUpdateBanner } from '@/components/auth/security-update-banner';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { getCurrentSession } from '@/lib/auth-session';
import { safeReturnTo } from '@/lib/return-url';

/**
 * Staff portal sign-in page (T073) at URL `/admin/sign-in`.
 *
 * Lives in the `(auth-public)` route group so it does NOT inherit the
 * `(staff)/admin/layout.tsx` auth guard. The route group is invisible
 * in the URL — Next.js resolves `/admin/sign-in` to this file because
 * it is the only `app/admin/sign-in/page.tsx` across all groups.
 *
 * Reads the optional `returnTo` query param and, after validating it
 * against the open-redirect guard in `safeReturnTo()`, forwards it to
 * the sign-in form (T171, spec AS5). Already-signed-in staff are
 * redirected to the preserved URL or `/admin` if none.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn');
  return {
    title: t('title'),
  };
}

interface StaffSignInPageProps {
  searchParams: Promise<{
    returnTo?: string | string[];
    reason?: string | string[];
  }>;
}

export default async function StaffSignInPage({ searchParams }: StaffSignInPageProps) {
  const { returnTo: rawReturnTo, reason: rawReason } = await searchParams;
  // searchParams can be string | string[] | undefined — coerce first.
  const returnToCandidate = Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo;
  const validatedReturnTo = safeReturnTo(returnToCandidate, 'staff');
  // H3 (Round 2): show a banner when ?reason=security-update is present.
  // Operators link to this URL on deploy day after migration 0159 bulk
  // session invalidation so users get UX context instead of an opaque
  // "you got logged out". Allowlist of accepted reasons prevents
  // arbitrary banner injection via query param.
  const reasonCandidate = Array.isArray(rawReason) ? rawReason[0] : rawReason;
  const showSecurityBanner = reasonCandidate === 'security-update';

  const current = await getCurrentSession();
  if (current && (current.user.role === 'admin' || current.user.role === 'manager')) {
    redirect(validatedReturnTo ?? '/admin');
  }

  const t = await getTranslations('auth.signIn');
  const tPortal = await getTranslations('shell.portalLabel');
  const tenantName = process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham';

  return (
    <main id="main-content" className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between p-4">
        <div className="text-sm font-semibold tracking-tight">{tenantName} · {tPortal('staff')}</div>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {showSecurityBanner ? (
              <SecurityUpdateBanner message={t('securityUpdateBanner')} />
            ) : null}
            <SignInForm portal="staff" returnTo={validatedReturnTo} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
