import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/auth/sign-in-form';
import { AuthFrame } from '@/components/auth/auth-frame';
import { SecurityUpdateBanner } from '@/components/auth/security-update-banner';
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
  // The renewal redeem-link route sends EVERY failure here (expired, used,
  // tampered) without saying which — keep the banner equally unspecific.
  const showLinkInvalidBanner = reasonCandidate === 'link_invalid';

  const current = await getCurrentSession();
  if (current) {
    if (current.user.role === 'member') {
      redirect(validatedReturnTo ?? '/portal');
    }
    // Staff role signed in → bounce to their own portal
    redirect('/admin');
  }

  const t = await getTranslations('auth.signIn');
  const tenantName = process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham';

  return (
    <AuthFrame
      title={t('title')}
      description={t('memberCardDescription')}
      portalLabel={t('memberCardDescription')}
      tenantName={tenantName}
    >
      {showSecurityBanner ? <SecurityUpdateBanner message={t('securityUpdateBanner')} /> : null}
      {showLinkInvalidBanner ? <SecurityUpdateBanner message={t('linkInvalidBanner')} /> : null}
      <SignInForm portal="member" returnTo={validatedReturnTo} />
    </AuthFrame>
  );
}
