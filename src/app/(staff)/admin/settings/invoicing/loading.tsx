import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * R7-B2 — loading skeleton for /admin/settings/invoicing.
 *
 * Task 8 (settings-ux-invoice-reminders) — widened to `DetailContainer`
 * to match the two-column section-nav + form shell `InvoiceSettingsForm`
 * grew into (Task 7): a left-rail nav skeleton beside a single-column
 * stack of 6 fieldset-wrapped sections (currency, identity, tax,
 * numbering, defaults, logo), each with a 2-column field grid on `sm`+.
 * The rail placeholder mirrors `SectionNav`'s real `md:flex-row` split
 * so CLS stays low once the real nav hydrates. Title / subtitle / card
 * header copy render as real (translated) text per the existing
 * skeleton convention across /admin so the header reads identically to
 * the loaded page — only interactive fields flicker.
 */
export default async function Loading() {
  const t = await getTranslations('admin.invoiceSettings');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <DetailContainer>
        {/* Header role-Badge skeleton dropped to match the loaded
            page (the badge itself was removed — role indicator lives
            in the top-right user-menu instead). */}
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('card.title')}</CardTitle>
            <CardDescription>{t('card.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-[var(--page-section-gap)] md:flex-row md:items-start md:gap-8">
              {/* Left-rail placeholder for `SectionNav` (hidden below
                  `md`, matching the real nav's `w-56 md:block`, so
                  hydration doesn't shift the form column). */}
              <SkeletonBlock className="hidden h-64 w-56 shrink-0 md:block" />

              <div className="flex min-w-0 flex-1 flex-col gap-[var(--page-section-gap)]">
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
            </div>
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
