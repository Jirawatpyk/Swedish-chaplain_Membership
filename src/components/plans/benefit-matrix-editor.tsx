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

import { useId } from 'react';
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
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <Label htmlFor={id} className="flex-1">
        {label}
      </Label>
      <Switch id={id} checked={value} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function BenefitMatrixEditor({
  value,
  onChange,
  planCategory,
  disabled = false,
}: BenefitMatrixEditorProps) {
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

  // Lazily materialise a partnership sub-object when the plan category
  // flips to 'partnership' and the sub-object is still null.
  if (planCategory === 'partnership' && value.partnership === null) {
    onChange({ ...value, partnership: DEFAULT_PARTNERSHIP });
  }
  if (planCategory === 'corporate' && value.partnership !== null) {
    onChange({ ...value, partnership: null });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Brand Visibility
        </h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumberField
            label="E-blast per year"
            value={value.eblast_per_year}
            onChange={(n) => patch({ eblast_per_year: n })}
            disabled={disabled}
          />
          <div className="space-y-1">
            <Label>Website page type</Label>
            <Select
              value={value.website_page_type ?? '__null__'}
              onValueChange={(v) =>
                patch({
                  website_page_type: v === '__null__' ? null : (v as BenefitMatrix['website_page_type']),
                })
              }
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__null__">None</SelectItem>
                <SelectItem value="member_news_update">Member news update</SelectItem>
                <SelectItem value="smes_spotlight">SMEs spotlight</SelectItem>
                <SelectItem value="student_intern_cv">Student/intern CV</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Homepage logo category</Label>
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
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__null__">None</SelectItem>
                <SelectItem value="premium">Premium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
                <SelectItem value="regular">Regular</SelectItem>
                <SelectItem value="start_up">Start-up</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Directory listing size</Label>
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
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__null__">None</SelectItem>
                <SelectItem value="full_page">Full page</SelectItem>
                <SelectItem value="half_page">Half page</SelectItem>
                <SelectItem value="eighth_page">Eighth page</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Events
        </h3>
        <div className="space-y-1">
          <Label>Event discount scope</Label>
          <Select
            value={value.event_discount_scope}
            onValueChange={(v) =>
              patch({ event_discount_scope: v as BenefitMatrix['event_discount_scope'] })
            }
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="all_employees">All employees</SelectItem>
              <SelectItem value="one_ticket_per_event">One ticket per event</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <BoolField
          label="Events co-branded access"
          value={value.events_cobranded_access}
          onChange={(b) => patch({ events_cobranded_access: b })}
          disabled={disabled}
        />
        <NumberField
          label="Cultural tickets per year"
          value={value.cultural_tickets_per_year}
          onChange={(n) => patch({ cultural_tickets_per_year: n })}
          disabled={disabled}
        />
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Additional Benefits
        </h3>
        <BoolField
          label="M2M benefits access"
          value={value.m2m_benefits_access}
          onChange={(b) => patch({ m2m_benefits_access: b })}
          disabled={disabled}
        />
        <BoolField
          label="Business referrals"
          value={value.business_referrals}
          onChange={(b) => patch({ business_referrals: b })}
          disabled={disabled}
        />
        <BoolField
          label="Tailor-made services"
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
              Partnership Benefits
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <NumberField
                label="Event tickets included"
                value={value.partnership.event_tickets_included}
                onChange={(n) => patchPartnership({ event_tickets_included: n })}
                disabled={disabled}
              />
              <NumberField
                label="Website logo months"
                value={value.partnership.website_logo_months}
                onChange={(n) => patchPartnership({ website_logo_months: n })}
                disabled={disabled}
              />
              <NumberField
                label="Banner per year"
                value={value.partnership.banner_per_year}
                onChange={(n) => patchPartnership({ banner_per_year: n })}
                disabled={disabled}
              />
              <div className="space-y-1">
                <Label>Video duration (minutes)</Label>
                <Select
                  value={String(value.partnership.video_duration_minutes)}
                  onValueChange={(v) => {
                    if (v === null) return;
                    patchPartnership({
                      video_duration_minutes: Number.parseFloat(v) as 1.0 | 1.5,
                    });
                  }}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1.0</SelectItem>
                    <SelectItem value="1.5">1.5</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Video frequency scope</Label>
                <Select
                  value={value.partnership.video_frequency_scope}
                  onValueChange={(v) =>
                    patchPartnership({
                      video_frequency_scope: v as PartnershipBenefits['video_frequency_scope'],
                    })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all_events">All events</SelectItem>
                    <SelectItem value="three_selected_events">
                      Three selected events
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Directory ad position</Label>
                <Select
                  value={value.partnership.directory_ad_position}
                  onValueChange={(v) =>
                    patchPartnership({
                      directory_ad_position:
                        v as PartnershipBenefits['directory_ad_position'],
                    })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pages_1_and_2">Pages 1 and 2</SelectItem>
                    <SelectItem value="first_pages">First pages</SelectItem>
                    <SelectItem value="first_10_pages">First 10 pages</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <BoolField
              label="Booth included"
              value={value.partnership.booth_included}
              onChange={(b) => patchPartnership({ booth_included: b })}
              disabled={disabled}
            />
            <BoolField
              label="Rollup logo at events"
              value={value.partnership.rollup_logo_at_events}
              onChange={(b) => patchPartnership({ rollup_logo_at_events: b })}
              disabled={disabled}
            />
            <BoolField
              label="Logo on merch"
              value={value.partnership.logo_on_merch}
              onChange={(b) => patchPartnership({ logo_on_merch: b })}
              disabled={disabled}
            />
            <BoolField
              label="Newsletter promotion"
              value={value.partnership.newsletter_promotion}
              onChange={(b) => patchPartnership({ newsletter_promotion: b })}
              disabled={disabled}
            />
            <BoolField
              label="E-newsletter logo"
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
