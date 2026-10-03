/**
 * R7-B2 — loading skeleton for /admin/settings/invoicing.
 *
 * Spec 122 US8c-2 (T854) — the `Admin-invoice-settings` shape on AURA, for
 * CLS 0: the header, the note, then the section rail (from `lg`, as the real
 * `SectionNav`; a 44px "Jump to section" select below it) beside one AURA
 * card per section. Section titles and visible fieldset legends render as
 * real (translated) text per the skeleton convention across /admin; only the
 * field labels and boxes are bars.
 *
 * `SECTION_SKELETONS` describes each section's real fieldset layout (see the
 * matching `*-section.tsx`): a legend-less entry mirrors the Tax fieldset's
 * `sr-only` legend; `numbering`'s `hasSwitchRow` is the auto-email switch.
 */
import { getTranslations } from 'next-intl/server';
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

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
    fieldsets: [
      { legendKey: 'sections.numberingPrefixes', fieldCount: 4 },
      { legendKey: 'sections.defaults', fieldCount: 3 },
    ],
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
        <Alert tone="info" role="note">
          {t('card.description')}
        </Alert>
        <div className="flex flex-col gap-[var(--page-section-gap)] lg:flex-row lg:items-start lg:gap-8">
          {/* The rail (six 44px buttons and their gaps) from lg; the jump-to
              select below it. */}
          <SkeletonBlock className="h-72 w-56 shrink-0 max-lg:hidden" />
          <SkeletonBlock className="h-11 w-full lg:hidden" />

          <div className="flex min-w-0 flex-1 flex-col gap-[var(--page-section-gap)]">
            {SECTION_SKELETONS.map((section) => (
              <Card key={section.id} title={t(section.labelKey)} headingLevel={2}>
                <div className="flex flex-col gap-[var(--aura-space-6)]">
                  {section.fieldsets.map((fieldset, i) => (
                    <div key={i} className="flex flex-col gap-[var(--aura-space-3)]">
                      {fieldset.legendKey ? (
                        <p className="text-sm font-semibold">{t(fieldset.legendKey)}</p>
                      ) : null}
                      <div
                        className={
                          fieldset.singleColumn
                            ? 'sm:max-w-xs'
                            : 'grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2'
                        }
                      >
                        {Array.from({ length: fieldset.fieldCount }).map((_, j) => (
                          <div key={j} className="flex flex-col gap-[var(--aura-space-2)]">
                            <SkeletonBlock className="h-4 w-28" />
                            <SkeletonBlock className="h-11 w-full" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {section.hasSwitchRow ? <SkeletonBlock className="h-12 w-full" /> : null}
                </div>
              </Card>
            ))}
            <SkeletonBlock className="h-11 w-full sm:w-36 sm:self-end" />
          </div>
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
