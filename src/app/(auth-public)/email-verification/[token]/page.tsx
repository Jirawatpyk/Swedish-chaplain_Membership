/**
 * Email-verification landing — FR-012a consumption UX.
 *
 * The change-contact-email flow delivers a link here to the NEW
 * address. On mount the form auto-POSTs to the consumption endpoint
 * which flips `users.email_verified` back to TRUE and closes the
 * revert window.
 *
 * B9 (post-ship 2026-05-17) — we resolve the post-verification CTA
 * from `getCurrentSession()` so member users land on /portal and
 * staff users land on /admin. Pre-B9 the CTA hardcoded /admin,
 * trapping member users in a role-guard redirect loop.
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { EmailVerificationForm } from '@/components/auth/email-verification-form';
import { getCurrentSession } from '@/lib/auth-session';
import { portalHomePath } from '@/lib/portal-paths';
import { PORTAL_FOR_ROLE } from '@/modules/auth/domain/role';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.emailVerification');
  return { title: t('title') };
}

interface VerifyPageProps {
  params: Promise<{ token: string }>;
}

export default async function EmailVerificationPage({
  params,
}: VerifyPageProps) {
  const { token } = await params;
  const t = await getTranslations('auth.emailVerification');
  // Resolve role from the current session if the user is already
  // signed in (typical flow — the email-change request requires
  // an active session). Falls back to /admin for the rare case
  // where the user landed here without a session.
  const current = await getCurrentSession();
  const redirectTo = current
    ? portalHomePath(PORTAL_FOR_ROLE[current.user.role])
    : '/admin';

  return (
    <main id="main-content" className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between p-4">
        <div className="text-sm font-semibold tracking-tight">{process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham'}</div>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <EmailVerificationForm token={token} redirectTo={redirectTo} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
