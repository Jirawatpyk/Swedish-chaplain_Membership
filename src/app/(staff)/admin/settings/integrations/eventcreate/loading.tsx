/**
 * /admin/settings/integrations/eventcreate loading skeleton (T080).
 *
 * Renders a placeholder stepper + card layout while the server
 * component fetches the integration config via
 * `runLoadIntegrationConfig`. Layout pair with the canonical page so
 * `pnpm check:layout` accepts the FormContainer / FormContainer match.
 *
 * Phase 5 review-fix S-12 (2026-05-13) — `aria-busy="true"` +
 * `role="status"` + sr-only label on the root so assistive tech
 * announces a positive "loading" signal during the shimmer phase
 * instead of silently rendering blank skeleton boxes.
 */
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getTranslations } from 'next-intl/server';

export default async function EventCreateIntegrationLoading() {
  const t = await getTranslations('admin.integrations.eventcreate.page');
  return (
    <FormContainer>
      <div aria-busy="true" role="status" className="contents">
        <span className="sr-only">{t('loading')}</span>
        <PageHeader
          title={<Skeleton className="h-7 w-56" />}
          subtitle={<Skeleton className="h-4 w-80" />}
        />

        {/*
          Phase 5 review-fix S-10 (2026-05-13) — skeleton stepper
          shape matches the real `<Stepper>` layout (no gap, three
          equally-weighted cells with a connector strip between
          indicators) so the visual handoff to the real stepper is
          CLS-0 per docs/ux-standards.md § 2.1.
        */}
        <ol
          className="flex items-center"
          aria-label={t('loading')}
        >
          {[1, 2, 3].map((n) => (
            <li key={n} className="flex flex-1 items-center gap-2">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              {n < 3 ? <Skeleton className="h-px w-6 shrink-0" /> : null}
            </li>
          ))}
        </ol>

        {/* Phase card placeholder — Card root supplies py-[var(--card-padding)]
            so CardContent must NOT add its own `py-*` (additive double
            padding) — Phase 5 review-fix (2026-05-13). */}
        <Card>
          <CardContent className="flex flex-col gap-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-40" />
          </CardContent>
        </Card>

        {/* Recent deliveries placeholder */}
        <div className="space-y-3">
          <Skeleton className="h-6 w-40" />
          <Card>
            <CardContent className="space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="flex items-center gap-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-5 flex-1" />
                  <Skeleton className="h-5 w-20" />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </FormContainer>
  );
}
