import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { InviteRedeemForm } from '@/components/auth/invite-redeem-form';
import { AuthPageControls } from '@/components/shell/auth-page-controls';
import { BrandMark } from '@/components/shell/brand-mark';
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

  return (
    <main id="main-content" className="relative flex min-h-screen flex-col bg-muted/20">
      <AuthPageControls />
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-4">
        <BrandMark
          variant="vertical"
          title={process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}
          className="w-44"
        />
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {tokenDead || !email ? (
              <div
                className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
                role="alert"
              >
                <p className="text-sm text-destructive">
                  {t('errors.tokenExpired')}
                </p>
              </div>
            ) : (
              <InviteRedeemForm token={token} email={email} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
