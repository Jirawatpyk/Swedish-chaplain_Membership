import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { BrandMark } from '@/components/shell/brand-mark';
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

  return (
    <main id="main-content" className="relative flex min-h-screen flex-col bg-muted/20">
      <header className="absolute right-4 top-4 z-10">
        {/* Brand wordmark replaced by the vertical lockup above the card. */}
        <ThemeToggle />
      </header>
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
            {tokenDead ? (
              <div
                className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
                role="alert"
              >
                <p className="text-sm text-destructive">
                  {t('errors.tokenExpired')}
                </p>
                <a
                  href="/forgot-password"
                  className="text-sm underline underline-offset-4"
                >
                  {t('requestNewLink')}
                </a>
              </div>
            ) : (
              <ResetPasswordForm token={token} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
