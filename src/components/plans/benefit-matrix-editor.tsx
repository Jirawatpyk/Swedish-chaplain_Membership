/**
 * T106 — BenefitMatrixEditor (US2 + US3).
 *
 * Grouped editor matching the PDF structure:
 *   - Brand Visibility (eblast_per_year + website_page_type +
 *     homepage_logo_category + directory_listing_size)
 *   - Events (event_discount_scope + events_cobranded_access +
 *     cultural_tickets_per_year)
 *   - Additional Benefits (m2m, business_referrals, tailor_made)
 *   - Partnership-only block (hidden when plan_category = 'corporate')
 *
 * The partnership block is conditionally mounted based on
 * `planCategory` — switching from corporate → partnership adds a
 * default partnership sub-object; switching back nulls it out.
 * This mirrors the zod superRefine integrity rule so the wizard
 * cannot end up in a state that the server would reject.
 *
 * 122 US6 (T604): AURA Select / Switch / number TextField, laid out as the
 * plan boards draw it (two columns from 768px, the groups under small mono
 * headings); `locked` shows a prior-year plan's matrix read-only with AURA's
 * lock icon (spec Clarifications, US6 start).
 */
'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Select, Switch, TextField } from '@jirawatpyk/aura-react';
import type {
  BenefitMatrix,
  PartnershipBenefits,
  PlanCategory,
} from '@/modules/plans';
import { lockedFieldProps, lockedSelectProps, lockedSwitchProps } from './plan-locked-note';

export interface BenefitMatrixEditorProps {
  readonly value: BenefitMatrix;
  readonly onChange: (next: BenefitMatrix) => void;
  readonly planCategory: PlanCategory;
  readonly disabled?: boolean;
  /** A prior-year plan: every benefit read-only (the server refuses changes too). */
  readonly locked?: boolean;
  /**
   * Frames each part: the plan boards give the partnership benefits their
   * own card beside the benefit matrix's. Without it the partnership block
   * is one more group under its heading.
   */
  readonly renderSection?: (section: {
    readonly id: 'benefits' | 'partnership';
    readonly children: ReactNode;
  }) => ReactNode;
}

const DEFAULT_PARTNERSHIP: PartnershipBenefits = {
  event_tickets_included: 0,
  booth_included: false,
  rollup_logo_at_events: false,
  logo_on_merch: false,
  video_duration_minutes: 1.0,
  video_frequency_scope: 'three_selected_events',
  website_logo_months: 3,
  banner_per_year: 0,
  newsletter_promotion: false,
  enewsletter_logo: false,
  directory_ad_position: 'first_10_pages',
};

function NumberField({
  label,
  value,
  onChange,
  disabled,
  locked,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (n: number) => void;
  readonly disabled: boolean;
  readonly locked: boolean;
}) {
  return (
    <TextField
      label={label}
      type="number"
      min={0}
      step={1}
      value={value}
      onChange={(e) => {
        const next = Number.parseInt(e.target.value, 10);
        onChange(Number.isFinite(next) ? Math.max(0, next) : 0);
      }}
      disabled={disabled}
      {...lockedFieldProps(locked)}
    />
  );
}

/** A group of fields under a small mono heading (Brand Visibility, Events, …). */
function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-[var(--aura-space-3)]">
      <h3 className="aura-text-mono uppercase tracking-wider text-[var(--aura-fg-secondary)] [&:lang(th)]:tracking-normal">{title}</h3>
      {children}
    </section>
  );
}

export function BenefitMatrixEditor({
  value,
  onChange,
  planCategory,
  disabled = false,
  locked = false,
  renderSection,
}: BenefitMatrixEditorProps) {
  const t = useTranslations('admin.plans.create.options');
  const tM = useTranslations('admin.plans.create.matrix');

  const WEBSITE_PAGE_OPTIONS = useMemo(() => [
    { value: '__null__', label: t('websitePageType.none') },
    { value: 'member_news_update', label: t('websitePageType.member_news_update') },
    { value: 'smes_spotlight', label: t('websitePageType.smes_spotlight') },
    { value: 'student_intern_cv', label: t('websitePageType.student_intern_cv') },
  ], [t]);

  const LOGO_CATEGORY_OPTIONS = useMemo(() => [
    { value: '__null__', label: t('homepageLogoCategory.none') },
    { value: 'premium', label: t('homepageLogoCategory.premium') },
    { value: 'large', label: t('homepageLogoCategory.large') },
    { value: 'regular', label: t('homepageLogoCategory.regular') },
    { value: 'start_up', label: t('homepageLogoCategory.start_up') },
  ], [t]);

  const DIRECTORY_SIZE_OPTIONS = useMemo(() => [
    { value: '__null__', label: t('directoryListingSize.none') },
    { value: 'full_page', label: t('directoryListingSize.full_page') },
    { value: 'half_page', label: t('directoryListingSize.half_page') },
    { value: 'eighth_page', label: t('directoryListingSize.eighth_page') },
  ], [t]);

  const DISCOUNT_SCOPE_OPTIONS = useMemo(() => [
    { value: 'none', label: t('eventDiscountScope.none') },
    { value: 'all_employees', label: t('eventDiscountScope.all_employees') },
    { value: 'one_ticket_per_event', label: t('eventDiscountScope.one_ticket_per_event') },
  ], [t]);

  const VIDEO_DURATION_OPTIONS = useMemo(() => [
    { value: '1', label: t('videoDuration.1_0') },
    { value: '1.5', label: t('videoDuration.1_5') },
  ], [t]);

  const VIDEO_FREQUENCY_OPTIONS = useMemo(() => [
    { value: 'all_events', label: t('videoFrequencyScope.all_events') },
    { value: 'three_selected_events', label: t('videoFrequencyScope.three_selected_events') },
  ], [t]);

  const DIRECTORY_AD_OPTIONS = useMemo(() => [
    { value: 'pages_1_and_2', label: t('directoryAdPosition.pages_1_and_2') },
    { value: 'first_pages', label: t('directoryAdPosition.first_pages') },
    { value: 'first_10_pages', label: t('directoryAdPosition.first_10_pages') },
  ], [t]);

  function patch(partial: Partial<BenefitMatrix>): void {
    onChange({ ...value, ...partial });
  }

  function patchPartnership(partial: Partial<PartnershipBenefits>): void {
    if (value.partnership === null) return;
    onChange({
      ...value,
      partnership: { ...value.partnership, ...partial },
    });
  }

  // Sync the partnership sub-object when planCategory changes.
  // Runs as an effect to avoid calling onChange during render.
  useEffect(() => {
    if (planCategory === 'partnership' && value.partnership === null) {
      onChange({ ...value, partnership: DEFAULT_PARTNERSHIP });
    } else if (planCategory === 'corporate' && value.partnership !== null) {
      onChange({ ...value, partnership: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on category change
  }, [planCategory]);

  const num = { disabled, locked };
  const sel = { disabled, ...lockedSelectProps(locked) };
  const sw = { disabled, ...lockedSwitchProps(locked) };

  const core = (
    <>
      <Group title={tM('section.brandVisibility')}>
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
          <NumberField
            label={tM('eblastPerYear')}
            value={value.eblast_per_year}
            onChange={(n) => patch({ eblast_per_year: n })}
            {...num}
          />
          <Select
            label={tM('websitePageType')}
            value={value.website_page_type ?? '__null__'}
            onChange={(e) =>
              patch({
                website_page_type:
                  e.target.value === '__null__' ? null : (e.target.value as BenefitMatrix['website_page_type']),
              })
            }
            options={WEBSITE_PAGE_OPTIONS}
            {...sel}
          />
          <Select
            label={tM('homepageLogoCategory')}
            value={value.homepage_logo_category ?? '__null__'}
            onChange={(e) =>
              patch({
                homepage_logo_category:
                  e.target.value === '__null__' ? null : (e.target.value as BenefitMatrix['homepage_logo_category']),
              })
            }
            options={LOGO_CATEGORY_OPTIONS}
            {...sel}
          />
          <Select
            label={tM('directoryListingSize')}
            value={value.directory_listing_size ?? '__null__'}
            onChange={(e) =>
              patch({
                directory_listing_size:
                  e.target.value === '__null__' ? null : (e.target.value as BenefitMatrix['directory_listing_size']),
              })
            }
            options={DIRECTORY_SIZE_OPTIONS}
            {...sel}
          />
        </div>
      </Group>

      <Group title={tM('section.events')}>
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
          <Select
            label={tM('eventDiscountScope')}
            value={value.event_discount_scope}
            onChange={(e) => patch({ event_discount_scope: e.target.value as BenefitMatrix['event_discount_scope'] })}
            options={DISCOUNT_SCOPE_OPTIONS}
            {...sel}
          />
          <NumberField
            label={tM('culturalTicketsPerYear')}
            value={value.cultural_tickets_per_year}
            onChange={(n) => patch({ cultural_tickets_per_year: n })}
            {...num}
          />
        </div>
        <Switch
          label={tM('eventsCoBrandedAccess')}
          checked={value.events_cobranded_access}
          onChange={(b) => patch({ events_cobranded_access: b })}
          {...sw}
        />
      </Group>

      <Group title={tM('section.additionalBenefits')}>
        <div className="space-y-[var(--aura-space-2)]">
          <Switch
            label={tM('m2mBenefitsAccess')}
            checked={value.m2m_benefits_access}
            onChange={(b) => patch({ m2m_benefits_access: b })}
            {...sw}
          />
          <Switch
            label={tM('businessReferrals')}
            checked={value.business_referrals}
            onChange={(b) => patch({ business_referrals: b })}
            {...sw}
          />
          <Switch
            label={tM('tailorMadeServices')}
            checked={value.tailor_made_services}
            onChange={(b) => patch({ tailor_made_services: b })}
            {...sw}
          />
        </div>
      </Group>

    </>
  );

  const partnership =
    planCategory === 'partnership' && value.partnership !== null ? (
      <div className="space-y-[var(--aura-space-3)]">
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
            <NumberField
              label={tM('eventTicketsIncluded')}
              value={value.partnership.event_tickets_included}
              onChange={(n) => patchPartnership({ event_tickets_included: n })}
              {...num}
            />
            <NumberField
              label={tM('websiteLogoMonths')}
              value={value.partnership.website_logo_months}
              onChange={(n) => patchPartnership({ website_logo_months: n })}
              {...num}
            />
            <NumberField
              label={tM('bannerPerYear')}
              value={value.partnership.banner_per_year}
              onChange={(n) => patchPartnership({ banner_per_year: n })}
              {...num}
            />
            <Select
              label={tM('directoryAdPosition')}
              value={value.partnership.directory_ad_position}
              onChange={(e) =>
                patchPartnership({
                  directory_ad_position: e.target.value as PartnershipBenefits['directory_ad_position'],
                })
              }
              options={DIRECTORY_AD_OPTIONS}
              {...sel}
            />
            <Select
              label={tM('videoDuration')}
              value={String(value.partnership.video_duration_minutes)}
              onChange={(e) =>
                patchPartnership({
                  video_duration_minutes: Number.parseFloat(e.target.value) as 1.0 | 1.5,
                })
              }
              options={VIDEO_DURATION_OPTIONS}
              {...sel}
            />
            <Select
              label={tM('videoFrequencyScope')}
              value={value.partnership.video_frequency_scope}
              onChange={(e) =>
                patchPartnership({
                  video_frequency_scope: e.target.value as PartnershipBenefits['video_frequency_scope'],
                })
              }
              options={VIDEO_FREQUENCY_OPTIONS}
              {...sel}
            />
          </div>
          <div className="grid grid-cols-1 gap-[var(--aura-space-2)] md:grid-cols-2">
            <Switch
              label={tM('boothIncluded')}
              checked={value.partnership.booth_included}
              onChange={(b) => patchPartnership({ booth_included: b })}
              {...sw}
            />
            <Switch
              label={tM('rollupLogoAtEvents')}
              checked={value.partnership.rollup_logo_at_events}
              onChange={(b) => patchPartnership({ rollup_logo_at_events: b })}
              {...sw}
            />
            <Switch
              label={tM('logoOnMerch')}
              checked={value.partnership.logo_on_merch}
              onChange={(b) => patchPartnership({ logo_on_merch: b })}
              {...sw}
            />
            <Switch
              label={tM('newsletterPromotion')}
              checked={value.partnership.newsletter_promotion}
              onChange={(b) => patchPartnership({ newsletter_promotion: b })}
              {...sw}
            />
            <Switch
              label={tM('eNewsletterLogo')}
              checked={value.partnership.enewsletter_logo}
              onChange={(b) => patchPartnership({ enewsletter_logo: b })}
              {...sw}
            />
          </div>
        </div>
    ) : null;

  if (renderSection) {
    return (
      <>
        {renderSection({ id: 'benefits', children: <div className="space-y-[var(--aura-space-6)]">{core}</div> })}
        {partnership ? renderSection({ id: 'partnership', children: partnership }) : null}
      </>
    );
  }

  return (
    <div className="space-y-[var(--aura-space-6)]">
      {core}
      {partnership ? <Group title={tM('section.partnershipBenefits')}>{partnership}</Group> : null}
    </div>
  );
}
