/**
 * F6 verify-fix F4 (2026-05-12) — placeholder for the Phase 5
 * tenant onboarding wizard (US3, T080). Note: "F4" here refers to
 * the verify-review finding ID, NOT the F4 invoicing feature.
 *
 * Phase 4's /admin/events empty-state variant (a) links here when no
 * tenant_webhook_config row exists ("Set up EventCreate integration"
 * CTA). Without this placeholder, the CTA 404s — a degraded UX between
 * Phase 4 ship and Phase 5 ship if `FEATURE_F6_EVENTCREATE=true` flips
 * early.
 *
 * Behaviour:
 *   - admin: renders "Coming in Phase 5" notice + link back to events list
 *   - manager: 404 per FR-035 (the entire /admin/integrations/eventcreate
 *     route prefix is admin-only at surface level — manager must not see it)
 *   - member: 404 per FR-035 (surface disclosure)
 *   - kill-switch off: 404
 *
 * Phase 5 (T080) will REPLACE this file with the full wizard. Until
 * then, the page exists solely to give the CTA a valid destination
 * and surface the "Coming soon" copy.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.integrations.eventcreate');
  return { title: t('placeholder.title') };
}

export default async function EventCreateIntegrationPlaceholderPage() {
  if (!env.features.f6EventCreate) {
    notFound();
  }

  const { user: currentUser } = await requireSession('staff');
  // FR-035: /admin/integrations/eventcreate is ADMIN-ONLY at surface
  // level — manager + member both get 404 (surface-disclosure
  // prevention; the existence of secret-bearing surfaces is itself
  // sensitive). Audit emission lives on the canonical Phase 5 page
  // (T080) — placeholder skips audit to avoid event-type drift while
  // the canonical wizard hasn't landed.
  if (currentUser.role !== 'admin') {
    notFound();
  }

  const t = await getTranslations('admin.integrations.eventcreate');

  return (
    <FormContainer>
      <Link
        href="/admin/events"
        className={buttonVariants({
          variant: 'ghost',
          size: 'sm',
          className: 'self-start',
        })}
      >
        <ArrowLeft className="size-4" />
        {t('placeholder.backToEvents')}
      </Link>
      <PageHeader
        title={t('placeholder.title')}
        subtitle={t('placeholder.subtitle')}
      />
      <Card>
        <CardContent className="flex flex-col gap-4 py-12 text-center">
          <h2 className="text-h3 font-semibold">
            {t('placeholder.heading')}
          </h2>
          <p className="mx-auto max-w-md text-muted-foreground">
            {t('placeholder.body')}
          </p>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
