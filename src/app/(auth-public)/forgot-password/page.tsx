import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '@/components/auth/auth-frame';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

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

  const tFrame = await getTranslations('auth.frame');
  return (
    <AuthFrame
      title={t('title')}
      description={t('description')}
      portalLabel={tFrame('everyone')}
      tenantName={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}
    >
      <ForgotPasswordForm />
    </AuthFrame>
  );
}
