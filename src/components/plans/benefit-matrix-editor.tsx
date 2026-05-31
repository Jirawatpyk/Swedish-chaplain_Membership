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
 */
'use client';

import { useEffect, useId, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import type {
  BenefitMatrix,
  PartnershipBenefits,
  PlanCategory,
} from '@/modules/plans';

export interface BenefitMatrixEditorProps {
  readonly value: BenefitMatrix;
  readonly onChange: (next: BenefitMatrix) => void;
  readonly planCategory: PlanCategory;
  readonly disabled?: boolean;
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
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (n: number) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      {/* S1-P1-19: associate Label↔Input (WCAG 1.3.1 / 4.1.2). */}
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => {
          const next = Number.parseInt(e.target.value, 10);
          onChange(Number.isFinite(next) ? Math.max(0, next) : 0);
        }}
        disabled={disabled}
      />
    </div>
  );
}

function BoolField({
  label,
  value,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (b: boolean) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <Label htmlFor={id} id={labelId} className="mb-0 flex-1">
        {label}
      </Label>
      <Switch
        id={id}
        aria-labelledby={labelId}
        checked={value}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

export function BenefitMatrixEditor({
  value,
  onChange,
  planCategory,
  disabled = false,
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

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {tM('section.brandVisibility')}
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumberField
            label={tM('eblastPerYear')}
            value={value.eblast_per_year}
            onChange={(n) => patch({ eblast_per_year: n })}
            disabled={disabled}
          />
          <div className="space-y-1">
            <Label>{tM('websitePageType')}</Label>
            <Select
              value={value.website_page_type ?? '__null__'}
              onValueChange={(v) =>
                patch({
                  website_page_type: v === '__null__' ? null : (v as BenefitMatrix['website_page_type']),
                })
              }
              disabled={disabled}
              items={WEBSITE_PAGE_OPTIONS}
            >
              <SelectTrigger aria-label={tM('websitePageType')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEBSITE_PAGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{tM('homepageLogoCategory')}</Label>
            <Select
              value={value.homepage_logo_category ?? '__null__'}
              onValueChange={(v) =>
                patch({
                  homepage_logo_category:
                    v === '__null__'
                      ? null
                      : (v as BenefitMatrix['homepage_logo_category']),
                })
              }
              disabled={disabled}
              items={LOGO_CATEGORY_OPTIONS}
            >
              <SelectTrigger aria-label={tM('homepageLogoCategory')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOGO_CATEGORY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{tM('directoryListingSize')}</Label>
            <Select
              value={value.directory_listing_size ?? '__null__'}
              onValueChange={(v) =>
                patch({
                  directory_listing_size:
                    v === '__null__'
                      ? null
                      : (v as BenefitMatrix['directory_listing_size']),
                })
              }
              disabled={disabled}
              items={DIRECTORY_SIZE_OPTIONS}
            >
              <SelectTrigger aria-label={tM('directoryListingSize')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECTORY_SIZE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {tM('section.events')}
        </h3>
        <div className="space-y-1">
          <Label>{tM('eventDiscountScope')}</Label>
          <Select
            value={value.event_discount_scope}
            onValueChange={(v) =>
              patch({ event_discount_scope: v as BenefitMatrix['event_discount_scope'] })
            }
            disabled={disabled}
            items={DISCOUNT_SCOPE_OPTIONS}
          >
            <SelectTrigger aria-label={tM('eventDiscountScope')} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DISCOUNT_SCOPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <BoolField
          label={tM('eventsCoBrandedAccess')}
          value={value.events_cobranded_access}
          onChange={(b) => patch({ events_cobranded_access: b })}
          disabled={disabled}
        />
        <NumberField
          label={tM('culturalTicketsPerYear')}
          value={value.cultural_tickets_per_year}
          onChange={(n) => patch({ cultural_tickets_per_year: n })}
          disabled={disabled}
        />
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {tM('section.additionalBenefits')}
        </h3>
        <BoolField
          label={tM('m2mBenefitsAccess')}
          value={value.m2m_benefits_access}
          onChange={(b) => patch({ m2m_benefits_access: b })}
          disabled={disabled}
        />
        <BoolField
          label={tM('businessReferrals')}
          value={value.business_referrals}
          onChange={(b) => patch({ business_referrals: b })}
          disabled={disabled}
        />
        <BoolField
          label={tM('tailorMadeServices')}
          value={value.tailor_made_services}
          onChange={(b) => patch({ tailor_made_services: b })}
          disabled={disabled}
        />
      </section>

      {planCategory === 'partnership' && value.partnership !== null ? (
        <>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {tM('section.partnershipBenefits')}
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <NumberField
                label={tM('eventTicketsIncluded')}
                value={value.partnership.event_tickets_included}
                onChange={(n) => patchPartnership({ event_tickets_included: n })}
                disabled={disabled}
              />
              <NumberField
                label={tM('websiteLogoMonths')}
                value={value.partnership.website_logo_months}
                onChange={(n) => patchPartnership({ website_logo_months: n })}
                disabled={disabled}
              />
              <NumberField
                label={tM('bannerPerYear')}
                value={value.partnership.banner_per_year}
                onChange={(n) => patchPartnership({ banner_per_year: n })}
                disabled={disabled}
              />
              <div className="space-y-1">
                <Label>{tM('videoDuration')}</Label>
                <Select
                  value={String(value.partnership.video_duration_minutes)}
                  onValueChange={(v) => {
                    if (v === null) return;
                    patchPartnership({
                      video_duration_minutes: Number.parseFloat(v) as 1.0 | 1.5,
                    });
                  }}
                  disabled={disabled}
                  items={VIDEO_DURATION_OPTIONS}
                >
                  <SelectTrigger aria-label={tM('videoDuration')} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VIDEO_DURATION_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{tM('videoFrequencyScope')}</Label>
                <Select
                  value={value.partnership.video_frequency_scope}
                  onValueChange={(v) =>
                    patchPartnership({
                      video_frequency_scope: v as PartnershipBenefits['video_frequency_scope'],
                    })
                  }
                  disabled={disabled}
                  items={VIDEO_FREQUENCY_OPTIONS}
                >
                  <SelectTrigger aria-label={tM('videoFrequencyScope')} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VIDEO_FREQUENCY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{tM('directoryAdPosition')}</Label>
                <Select
                  value={value.partnership.directory_ad_position}
                  onValueChange={(v) =>
                    patchPartnership({
                      directory_ad_position:
                        v as PartnershipBenefits['directory_ad_position'],
                    })
                  }
                  disabled={disabled}
                  items={DIRECTORY_AD_OPTIONS}
                >
                  <SelectTrigger aria-label={tM('directoryAdPosition')} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIRECTORY_AD_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <BoolField
              label={tM('boothIncluded')}
              value={value.partnership.booth_included}
              onChange={(b) => patchPartnership({ booth_included: b })}
              disabled={disabled}
            />
            <BoolField
              label={tM('rollupLogoAtEvents')}
              value={value.partnership.rollup_logo_at_events}
              onChange={(b) => patchPartnership({ rollup_logo_at_events: b })}
              disabled={disabled}
            />
            <BoolField
              label={tM('logoOnMerch')}
              value={value.partnership.logo_on_merch}
              onChange={(b) => patchPartnership({ logo_on_merch: b })}
              disabled={disabled}
            />
            <BoolField
              label={tM('newsletterPromotion')}
              value={value.partnership.newsletter_promotion}
              onChange={(b) => patchPartnership({ newsletter_promotion: b })}
              disabled={disabled}
            />
            <BoolField
              label={tM('eNewsletterLogo')}
              value={value.partnership.enewsletter_logo}
              onChange={(b) => patchPartnership({ enewsletter_logo: b })}
              disabled={disabled}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
