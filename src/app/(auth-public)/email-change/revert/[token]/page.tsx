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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { BrandMark } from '@/components/shell/brand-mark';
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
  const t = await getTranslations('auth.emailChangeRevert');

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
            <EmailChangeRevertForm token={token} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
