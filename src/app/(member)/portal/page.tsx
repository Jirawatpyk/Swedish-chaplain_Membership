import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { InvoicesSummaryCard } from './invoices/_components/invoices-summary-card';

/**
 * Member portal landing — `/portal` (Dashboard).
 *
 * Renders the welcome header, a live invoice summary, and a contact card.
 * (The old F4/F5/F6 "coming soon" roadmap card was removed once those
 * features shipped — they are live surfaces now, not roadmap items.)
 * F3 US5 briefly replaced this with a `redirect('/portal/profile')`
 * which broke the Dashboard nav entry (two buttons ending at Profile).
 * Restored so the Dashboard link lands on real content; Profile has
 * its own dedicated route at `/portal/profile`.
 *
 * The layout's `requireSession('member')` guard runs before this
 * component, so unauthenticated users never reach the render.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.memberPortal');
  return { title: t('title') };
}

export default async function MemberPortalHomePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('auth.memberPortal');

  return (
    <DetailContainer>
      <PageHeader
        title={t('welcome', { name: user.displayName ?? user.email })}
        subtitle={t('intro')}
        badge={<Badge variant="secondary">{t('versionBadge')}</Badge>}
      />

      {/* US7 AS4 — compact invoice summary (latest 3 + view all). */}
      <InvoicesSummaryCard user={user} />

      <Card>
        <CardHeader>
          <CardTitle>{t('contactHeading')}</CardTitle>
          <CardDescription>{t('contactDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href="mailto:info@swecham.se"
            className="text-body underline underline-offset-4"
          >
            info@swecham.se
          </a>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
