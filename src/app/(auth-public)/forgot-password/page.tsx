import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '@/components/auth/auth-frame';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { portalSignInPath } from '@/lib/portal-paths';

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

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  // The staff sign-in links here with `?from=staff`, so "Back to sign in"
  // returns there; anything else goes back to the member portal. It only
  // picks a link — the request itself never depends on the portal (FR-016).
  const { from } = await searchParams;
  const tFrame = await getTranslations('auth.frame');
  return (
    // The form draws its own title: it changes to "Check your email" once sent,
    // as the `Auth-forgot` board draws that state.
    <AuthFrame portalLabel={tFrame('everyone')} tenantName={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}>
      <ForgotPasswordForm signInHref={portalSignInPath(from === 'staff' ? 'staff' : 'member')} />
    </AuthFrame>
  );
}
