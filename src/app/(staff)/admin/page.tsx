import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout/detail-container';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';

/**
 * Staff home page (T076) — placeholder for the MVP.
 *
 * Future phases will replace this with the actual staff dashboard:
 *   - F3 — Members & Contacts list
 *   - F4 — Invoices & receipts
 *   - F6/F7 — Events & registration
 *   - F9 — unified admin dashboard + audit log viewer + sidebar nav
 *
 * For F1 (MVP) it just confirms the sign-in flow worked and shows the
 * authenticated user their name + the placeholder roadmap.
 */
export const metadata: Metadata = {
  title: 'Staff home',
};

const ROADMAP_PHASES = ['F3', 'F4', 'F5', 'F6'] as const;

export default async function StaffHomePage() {
  const { user } = await requireSession('staff');
  const tShell = await getTranslations('shell');
  const t = await getTranslations('admin.home');

  return (
    <DetailContainer>
      <PageHeader
        title={
          user.displayName
            ? t('welcomeWithName', { name: user.displayName })
            : tShell('welcome')
        }
        subtitle={t('subtitle', { role: user.role })}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('cardTitle')}</CardTitle>
          <CardDescription>{t('cardDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 text-body">
            {ROADMAP_PHASES.map((phase) => (
              <li key={phase} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">
                  {phase}
                </span>
                <span>{t(`roadmap.${phase.toLowerCase() as 'f3' | 'f4' | 'f5' | 'f6'}`)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
