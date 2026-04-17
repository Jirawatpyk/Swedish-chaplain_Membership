/**
 * Email-verification landing — FR-012a consumption UX.
 *
 * The change-contact-email flow delivers a link here to the NEW
 * address. On mount the form auto-POSTs to the consumption endpoint
 * which flips `users.email_verified` back to TRUE and closes the
 * revert window. The CTA points to /admin (or /portal — we default
 * to /admin for staff; members can still sign in at /portal after).
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

  return (
    <main className="flex min-h-screen flex-col bg-muted/20">
      <header className="flex items-center justify-between p-4">
        <div className="text-sm font-semibold tracking-tight">SweCham</div>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">{t('title')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <EmailVerificationForm token={token} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
