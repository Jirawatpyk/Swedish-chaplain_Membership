import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '@/components/auth/auth-frame';
import { AuthLinkInvalid } from '@/components/auth/auth-link-invalid';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
// Presentation-side data loader for the reset-password page.
// No Application use case wraps a read-only "is this token
// displayable?" check — all existing use cases CONSUME the token,
// which pre-validation MUST NOT do (T-04 enumeration defence).
// This direct infrastructure read is scoped to the single display
// decision below and is the documented escape hatch.
 
import { tokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import { isResetTokenValid, asResetTokenId } from '@/modules/auth';

/**
 * Reset-password page (T107) at URL `/reset-password/[token]`.
 *
 * Pre-validates the token server-side to decide whether to render the
 * form or a "link-invalid" card. Pre-validation does NOT consume the
 * token — only the POST to `/api/auth/reset-password` does that.
 *
 * Pre-validation has enumeration implications: if we leaked whether
 * the token existed, an attacker with a stolen link could verify it
 * without committing. We therefore render the SAME form shell
 * regardless; only "clearly-expired" and "missing" get the early
 * error card. The form itself handles the eventual 410 from the API.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.resetPassword');
  return {
    title: t('title'),
  };
}

interface ResetPasswordPageProps {
  params: Promise<{ token: string }>;
}

export default async function ResetPasswordPage({
  params,
}: ResetPasswordPageProps) {
  const { token } = await params;
  const t = await getTranslations('auth.resetPassword');

  // Cheap server-side validity check — still allows the form to
  // render on ambiguous results so the user gets a meaningful error
  // inside the form flow. We only short-circuit on clearly-dead
  // tokens (missing, already-consumed, expired past TTL).
  let tokenDead = false;
  try {
    const record = await tokenRepo.findResetById(asResetTokenId(token));
    if (!record || !isResetTokenValid(record, new Date())) {
      tokenDead = true;
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
      {tokenDead ? (
        <AuthLinkInvalid
          message={t('errors.tokenExpired')}
          action={{ label: t('requestNewLink'), href: '/forgot-password' }}
        />
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </AuthFrame>
  );
}
