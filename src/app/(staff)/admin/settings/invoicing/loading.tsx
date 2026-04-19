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
 * R7-B2 — loading skeleton for /admin/settings/invoicing.
 *
 * Matches the real `<InvoiceSettingsForm>` structural shape: 6
 * fieldset-wrapped sections (currency, identity, tax, numbering,
 * defaults, logo), each with 2-column field grid on `sm`+. Title /
 * subtitle / card header copy render as real (translated) text per the
 * existing skeleton convention across /admin so the header reads
 * identically to the loaded page — only interactive fields flicker.
 */
export default async function Loading() {
  const t = await getTranslations('admin.invoiceSettings');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          actions={<SkeletonBlock className="h-6 w-20" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('card.title')}</CardTitle>
            <CardDescription>{t('card.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-[var(--page-section-gap)]">
              {(
                ['currency', 'identity', 'tax', 'numbering', 'defaults', 'logo'] as const
              ).map((section) => (
                <fieldset
                  key={section}
                  className="flex flex-col gap-4 rounded-md border p-4"
                >
                  <legend className="px-2 text-sm font-semibold">
                    {t(`sections.${section}`)}
                  </legend>
                  <div
                    className={
                      section === 'currency'
                        ? 'sm:max-w-xs'
                        : 'grid grid-cols-1 gap-4 sm:grid-cols-2'
                    }
                  >
                    {Array.from({
                      length: section === 'currency' || section === 'logo' ? 1 : 2,
                    }).map((_, i) => (
                      <div key={i} className="space-y-2">
                        <SkeletonBlock className="h-4 w-28" />
                        <SkeletonBlock className="h-[var(--input-height)] w-full" />
                      </div>
                    ))}
                  </div>
                </fieldset>
              ))}
              <SkeletonBlock className="h-11 w-full" />
            </div>
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
