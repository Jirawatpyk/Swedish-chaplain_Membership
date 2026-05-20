import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Loading skeleton for `/admin/settings/broadcasts`.
 *
 * Convention (matches `/admin/settings/invoicing/loading.tsx` +
 * `/admin/settings/renewals/schedules/loading.tsx`): render real
 * PageHeader + real Card title/description from i18n on the server
 * so the visible chrome is identical to the loaded page; skeleton
 * only the interactive content (allowlist form fields + table rows).
 * Eliminates the title/description flicker and "Broadcast settings /
 * Configure…" duplicate-skeleton the previous loading.tsx introduced.
 */
export default async function Loading() {
  const t = await getTranslations('admin.broadcasts.settings');
  const tAllowlist = await getTranslations(
    'admin.broadcasts.settings.allowlist',
  );
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
        <Card>
          <CardHeader>
            <CardTitle>{tAllowlist('heading')}</CardTitle>
            <CardDescription>{tAllowlist('description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {/* Add-hostname form row — mirrors editor anatomy:
                  Label / [Input + Button row] / Help text. */}
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-32" />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                  <SkeletonBlock className="h-[var(--input-height)] flex-1" />
                  <SkeletonBlock className="h-[var(--input-height)] w-32 shrink-0" />
                </div>
                <SkeletonBlock className="h-3 w-2/3" />
              </div>

              {/* Allowlist table — 4 row stubs separated by border-t. */}
              <div className="space-y-0">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-4 py-3 border-t"
                  >
                    <SkeletonBlock className="h-4 w-1/3" />
                    <SkeletonBlock className="hidden sm:block h-3 w-20" />
                    <SkeletonBlock className="h-8 w-20" />
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
