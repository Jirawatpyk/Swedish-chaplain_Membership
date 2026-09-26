/**
 * Email-change revert landing page — FR-012b (T096).
 *
 * Reached from the OLD-address revert notification link. Renders a
 * single-button CTA that POSTs to the public revert endpoint. The
 * endpoint does the atomic rollback + flags the user
 * `requires_password_reset`; the landing page then guides the user
 * to /forgot-password to complete recovery.
 *
 * No server-side token pre-validation — revert tokens should never
 * be checked by a GET (they are consumable state; Next's cache
 * prefetch could silently probe them). The button submits the POST
 * on user intent.
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '@/components/auth/auth-frame';
import { EmailChangeRevertForm } from '@/components/auth/email-change-revert-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.emailChangeRevert');
  return { title: t('title') };
}

interface RevertPageProps {
  params: Promise<{ token: string }>;
}

export default async function EmailChangeRevertPage({
  params,
}: RevertPageProps) {
  const { token } = await params;

  const tFrame = await getTranslations('auth.frame');
  return (
    // The form draws its own title: the header copy follows its state.
    <AuthFrame portalLabel={tFrame('everyone')} tenantName={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}>
      <EmailChangeRevertForm token={token} />
    </AuthFrame>
  );
}
