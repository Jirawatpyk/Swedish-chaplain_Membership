import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '@/components/auth/auth-frame';
import { AuthLinkInvalid } from '@/components/auth/auth-link-invalid';
import { InviteRedeemForm } from '@/components/auth/invite-redeem-form';
// Presentation-side data loaders for the invitation display page.
// No Application use case provides a read-only "prefetch invitation
// for display" surface (all existing use cases CONSUME the
// invitation — pre-validation MUST NOT). The two reads below are
// scoped to display decisions only and are the documented escape
// hatch for page-level pre-validation.
 
import { tokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
 
import { isInvitationValid, asInvitationTokenId } from '@/modules/auth';

/**
 * Invitation redemption page (T136) at URL `/invite/[token]`.
 *
 * Pre-validates the token server-side. For a clearly-dead token we
 * render a link-invalid card with a "contact administrator" hint
 * (no "request new link" affordance — the admin must explicitly
 * re-invite because invitations are admin-scoped, not user-scoped).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.invite');
  return { title: t('title') };
}

interface InviteRedeemPageProps {
  params: Promise<{ token: string }>;
}

export default async function InviteRedeemPage({ params }: InviteRedeemPageProps) {
  const { token } = await params;
  const t = await getTranslations('auth.invite');

  let email: string | null = null;
  let tokenDead = false;
  try {
    const invitation = await tokenRepo.findInvitationById(
      asInvitationTokenId(token),
    );
    if (!invitation || !isInvitationValid(invitation, new Date())) {
      tokenDead = true;
    } else {
      const user = await userRepo.findById(invitation.userId);
      if (!user || user.status !== 'pending') {
        tokenDead = true;
      } else {
        email = user.email;
      }
    }
  } catch {
    tokenDead = true;
  }

  const tFrame = await getTranslations('auth.frame');
  return (
    <AuthFrame
      title={t('title')}
      description={t('cardDescription')}
      portalLabel={tFrame('everyone')}
      tenantName={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}
    >
      {tokenDead || !email ? (
        <AuthLinkInvalid message={t('errors.tokenExpired')} />
      ) : (
        <InviteRedeemForm token={token} email={email} />
      )}
    </AuthFrame>
  );
}
