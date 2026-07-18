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
 * C2 (settings-ux-invoice-reminders wave B) — resynced to the REAL 6
 * sections `InvoiceSettingsForm` (Task 7) now renders — organization /
 * tax / numbering / notes / payment / branding — each with its actual
 * fieldset + approximate field count, not the old pre-refactor grouping
 * (`currency/identity/tax/numbering/defaults/logo`) this file used to
 * hardcode. The shape mismatch was causing both wrong section names on
 * first paint AND meaningful CLS once the real (differently-sized)
 * sections hydrated in (ux-standards §2.1 wants CLS≈0).
 *
 * `SECTION_SKELETONS` below is a compact description of each section's
 * real fieldset layout (see the matching `*-section.tsx` for the actual
 * fields) — legend-less entries mirror the I1 fix (the "Tax" and
 * "Numbering" fieldsets' legends are `sr-only` there, deduping against
 * the section h2, so no visible legend placeholder renders here either).
 * `numbering`'s `hasSwitchRow` mirrors the I2 relocation of
 * `auto_email_enabled` into its "Defaults" area.
 *
 * The left-rail skeleton mirrors `SectionNav`'s real `md:flex-row` split
 * so CLS stays low once the real nav hydrates. Section headings + visible
 * fieldset legends render as real (translated) text per the existing
 * skeleton convention across /admin — only field labels/inputs skeleton.
 */

type FieldsetSkeleton = {
  /** Omit for a fieldset whose real `<legend>` is `sr-only` (I1 dedupe). */
  readonly legendKey?: string;
  readonly fieldCount: number;
  readonly singleColumn?: boolean;
};

type SectionSkeleton = {
  readonly id: string;
  readonly labelKey: string;
  readonly fieldsets: readonly FieldsetSkeleton[];
  /** Numbering's relocated auto-email switch row (I2) — not a fieldset. */
  readonly hasSwitchRow?: boolean;
};

const SECTION_SKELETONS: readonly SectionSkeleton[] = [
  {
    id: 'organization',
    labelKey: 'sections.organization',
    fieldsets: [
      { legendKey: 'sections.currency', fieldCount: 1, singleColumn: true },
      { legendKey: 'sections.identity', fieldCount: 6 },
      { legendKey: 'sections.seller', fieldCount: 2 },
    ],
  },
  {
    id: 'tax',
    labelKey: 'sections.tax',
    fieldsets: [{ fieldCount: 2 }],
  },
  {
    id: 'numbering',
    labelKey: 'sections.numbering',
    fieldsets: [{ fieldCount: 4 }, { legendKey: 'sections.defaults', fieldCount: 3 }],
    hasSwitchRow: true,
  },
  {
    id: 'notes',
    labelKey: 'sections.documentNotes',
    fieldsets: [
      { legendKey: 'sections.whtNote', fieldCount: 2 },
      { legendKey: 'sections.terminationNotice', fieldCount: 2 },
    ],
  },
  {
    id: 'payment',
    labelKey: 'sections.payment',
    fieldsets: [{ legendKey: 'sections.bank', fieldCount: 9 }],
  },
  {
    id: 'branding',
    labelKey: 'sections.branding',
    fieldsets: [{ legendKey: 'sections.logo', fieldCount: 1 }],
  },
];

export default async function Loading() {
  const t = await getTranslations('admin.invoiceSettings');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('card.title')}</CardTitle>
            <CardDescription>{t('card.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-[var(--page-section-gap)] md:flex-row md:items-start md:gap-8">
              {/* Left-rail placeholder for `SectionNav` (hidden below
                  `md`, matching the real nav's `w-56 md:block`; ~6 buttons
                  at min-h-11 + gaps, so hydration doesn't shift the form
                  column). */}
              <SkeletonBlock className="hidden h-72 w-56 shrink-0 md:block" />

              <div className="flex min-w-0 flex-1 flex-col gap-[var(--page-section-gap)]">
                {SECTION_SKELETONS.map((section) => (
                  <div key={section.id} className="flex flex-col gap-[var(--page-section-gap)]">
                    <p className="font-heading text-base font-semibold">
                      {t(section.labelKey)}
                    </p>
                    {section.fieldsets.map((fieldset, i) => (
                      <fieldset
                        key={i}
                        className="flex flex-col gap-4 rounded-md border p-4"
                      >
                        {fieldset.legendKey ? (
                          <legend className="px-2 text-sm font-semibold">
                            {t(fieldset.legendKey)}
                          </legend>
                        ) : null}
                        <div
                          className={
                            fieldset.singleColumn
                              ? 'sm:max-w-xs'
                              : 'grid grid-cols-1 gap-4 sm:grid-cols-2'
                          }
                        >
                          {Array.from({ length: fieldset.fieldCount }).map((_, j) => (
                            <div key={j} className="space-y-2">
                              <SkeletonBlock className="h-4 w-28" />
                              <SkeletonBlock className="h-[var(--input-height)] w-full" />
                            </div>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                    {section.hasSwitchRow ? (
                      <SkeletonBlock className="h-16 w-full rounded-md border" />
                    ) : null}
                  </div>
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
