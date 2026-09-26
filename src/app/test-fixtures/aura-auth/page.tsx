import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { AuthFrame } from '@/components/auth/auth-frame';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { EmailVerificationForm } from '@/components/auth/email-verification-form';
import { InviteRedeemForm } from '@/components/auth/invite-redeem-form';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

// Request-time evaluation so the guard runs per request (see button-matrix).
export const dynamic = 'force-dynamic';

/**
 * Spec 122 US2 (T209) — the auth forms that need a live token or a session,
 * inside the real frame with no DB, so they can be screenshot at 390 / 1280 in
 * light and dark and compared with the `Auth-reset`, `Auth-invite`,
 * `Auth-verify` boards (`?view=reset|invite|verify|change-password`). Nothing
 * here can succeed: the token is invented, so a submit only reaches an error.
 *
 * Reachable only with `ALLOW_TEST_ROUTES=1` (never set on Vercel), exactly
 * like `/test-fixtures/aura-shell`.
 */
export default async function AuraAuthPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const { view } = await searchParams;
  const tFrame = await getTranslations('auth.frame');
  const token = 'preview-token';

  if (view === 'invite') {
    const t = await getTranslations('auth.invite');
    return (
      <AuthFrame title={t('title')} description={t('cardDescription')} portalLabel={tFrame('everyone')} tenantName="SweCham">
        <InviteRedeemForm token={token} email="anna@example.com" />
      </AuthFrame>
    );
  }
  if (view === 'verify') {
    const t = await getTranslations('auth.emailVerification');
    return (
      <AuthFrame title={t('title')} description={t('cardDescription')} portalLabel={tFrame('everyone')} tenantName="SweCham">
        <EmailVerificationForm token={token} redirectTo="/portal" />
      </AuthFrame>
    );
  }
  if (view === 'change-password') {
    const t = await getTranslations('auth.changePassword');
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
        <h1 className="text-h1">{t('title')}</h1>
        <ChangePasswordForm />
      </div>
    );
  }
  const t = await getTranslations('auth.resetPassword');
  return (
    <AuthFrame title={t('title')} description={t('cardDescription')} portalLabel={tFrame('everyone')} tenantName="SweCham">
      <ResetPasswordForm token={token} />
    </AuthFrame>
  );
}
