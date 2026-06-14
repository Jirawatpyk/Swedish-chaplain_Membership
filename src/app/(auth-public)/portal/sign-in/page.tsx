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
import { SecurityUpdateBanner } from '@/components/auth/security-update-banner';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { BrandMark } from '@/components/shell/brand-mark';
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
  searchParams: Promise<{
    returnTo?: string | string[];
    reason?: string | string[];
  }>;
}

export default async function MemberSignInPage({
  searchParams,
}: MemberSignInPageProps) {
  const { returnTo: rawReturnTo, reason: rawReason } = await searchParams;
  const returnToCandidate = Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo;
  const validatedReturnTo = safeReturnTo(returnToCandidate, 'member');
  // H3 (Round 2): see admin/sign-in/page.tsx for rationale.
  const reasonCandidate = Array.isArray(rawReason) ? rawReason[0] : rawReason;
  const showSecurityBanner = reasonCandidate === 'security-update';

  const current = await getCurrentSession();
  if (current) {
    if (current.user.role === 'member') {
      redirect(validatedReturnTo ?? '/portal');
    }
    // Staff role signed in → bounce to their own portal
    redirect('/admin');
  }

  const t = await getTranslations('auth.signIn');
  const tPortal = await getTranslations('shell.portalLabel');
  const tenantName = process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham';

  return (
    <main id="main-content" className="relative flex min-h-screen flex-col bg-muted/20">
      <header className="absolute right-4 top-4 z-10">
        {/* Brand wordmark removed — the vertical lockup above the card now
            carries the SweCham brand. The theme toggle floats top-right so it
            doesn't consume layout height, letting the sign-in block centre in
            the full viewport. */}
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <BrandMark
            variant="vertical"
            title={`${tenantName} — ${tPortal('member')}`}
            className="mx-auto w-44"
          />
          <Card className="w-full">
            <CardHeader className="space-y-2">
              <CardTitle className="text-2xl">{t('title')}</CardTitle>
              <CardDescription>{t('memberCardDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {showSecurityBanner ? (
                <SecurityUpdateBanner message={t('securityUpdateBanner')} />
              ) : null}
              <SignInForm portal="member" returnTo={validatedReturnTo} />
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
