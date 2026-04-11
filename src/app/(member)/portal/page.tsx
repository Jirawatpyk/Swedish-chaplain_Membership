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
import { requireSession } from '@/lib/auth-session';

/**
 * Member portal placeholder landing (T145).
 *
 * F1 ships only authentication for members — the rich member
 * experience (profile, invoices, events, renewal) lands in later
 * phases. For now we greet the member by name, show a "v1.0 — more
 * features coming soon" badge, and list the F-phases that will
 * bring each upcoming surface online so the member sees their
 * roadmap.
 *
 * Contact email is `info@swecham.se` — the human fallback until
 * F3 gives them a self-service profile page.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.memberPortal');
  return { title: t('title') };
}

export default async function MemberPortalHomePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('auth.memberPortal');

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('welcome', { name: user.displayName ?? user.email })}
          </h1>
          <Badge variant="secondary">{t('versionBadge')}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('roadmapHeading')}</CardTitle>
          <CardDescription>{t('roadmapDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 text-sm">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                F3
              </span>
              <div>
                <p className="font-medium">{t('roadmap.profile.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('roadmap.profile.description')}
                </p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                F4
              </span>
              <div>
                <p className="font-medium">{t('roadmap.invoices.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('roadmap.invoices.description')}
                </p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                F6
              </span>
              <div>
                <p className="font-medium">{t('roadmap.events.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('roadmap.events.description')}
                </p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                F5
              </span>
              <div>
                <p className="font-medium">{t('roadmap.renewal.title')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('roadmap.renewal.description')}
                </p>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('contactHeading')}</CardTitle>
          <CardDescription>{t('contactDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href="mailto:info@swecham.se"
            className="text-sm underline underline-offset-4"
          >
            info@swecham.se
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
