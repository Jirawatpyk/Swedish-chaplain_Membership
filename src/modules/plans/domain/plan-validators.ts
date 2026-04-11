/**
 * Plan validation — the authoritative zod schema for plan mutations.
 *
 * Every plan create / update / clone path runs input through
 * `planSchema.parse(...)` (or `.safeParse` in Result contexts) before
 * touching the repo. This schema encodes:
 *
 *   1. Shape: the exact fields in data-model.md § 2.1 + § 3.2
 *   2. Required / optional: `plan_name.en` required, th/sv optional
 *   3. Value ranges: non-negative integers for money, year 2000..2100,
 *      non-empty IDs, etc.
 *   4. Integrity: corporate ↔ partnership cross-field rules via
 *      `superRefine` (data-model.md § 5)
 *   5. Turnover ordering: `min_turnover < max_turnover` when both set
 *
 * Separate from `planSchema` we export `planPatchSchema` — every field
 * is optional so PATCH requests can supply partial updates. The
 * superRefine still fires on whichever fields are present.
 *
 * Pure TypeScript + zod.
 */

import { z } from 'zod';

// --- Shared building blocks ---------------------------------------------------

export const localeTextSchema = z.object({
  en: z.string().trim().min(1).max(120),
  th: z.string().trim().min(1).max(120).optional(),
  sv: z.string().trim().min(1).max(120).optional(),
});

export const localeDescriptionSchema = z.object({
  en: z.string().trim().max(2000),
  th: z.string().trim().max(2000).optional(),
  sv: z.string().trim().max(2000).optional(),
});

const minorUnitsSchema = z
  .number()
  .int('Money fields must be integer minor units (satang/öre/cents)')
  .nonnegative('Money fields must be non-negative')
  .max(10_000_000_000);

const planSlugRegex = /^[a-z0-9-]{1,63}$/;

// --- Benefit matrix schemas ---------------------------------------------------

export const partnershipBenefitsSchema = z.object({
  event_tickets_included: z.number().int().nonnegative(),
  booth_included: z.boolean(),
  rollup_logo_at_events: z.boolean(),
  logo_on_merch: z.boolean(),
  video_duration_minutes: z.union([z.literal(1.0), z.literal(1.5)]),
  video_frequency_scope: z.enum(['all_events', 'three_selected_events']),
  website_logo_months: z.number().int().positive(),
  banner_per_year: z.number().int().nonnegative(),
  newsletter_promotion: z.boolean(),
  enewsletter_logo: z.boolean(),
  directory_ad_position: z.enum([
    'pages_1_and_2',
    'first_pages',
    'first_10_pages',
  ]),
});

export const benefitMatrixSchema = z.object({
  eblast_per_year: z.number().int().nonnegative(),
  website_page_type: z
    .enum(['member_news_update', 'smes_spotlight', 'student_intern_cv'])
    .nullable(),
  homepage_logo_category: z
    .enum(['premium', 'large', 'regular', 'start_up'])
    .nullable(),
  directory_listing_size: z
    .enum(['full_page', 'half_page', 'eighth_page'])
    .nullable(),
  event_discount_scope: z.enum([
    'all_employees',
    'one_ticket_per_event',
    'none',
  ]),
  events_cobranded_access: z.boolean(),
  cultural_tickets_per_year: z.number().int().nonnegative(),
  m2m_benefits_access: z.boolean(),
  business_referrals: z.boolean(),
  tailor_made_services: z.boolean(),
  partnership: partnershipBenefitsSchema.nullable(),
});

// --- Full plan schema ---------------------------------------------------------

/**
 * The authoritative `planSchema` — applies to create + clone operations
 * where every field must be supplied.
 *
 * See `planPatchSchema` below for the PATCH variant.
 */
export const planSchema = z
  .object({
    plan_id: z
      .string()
      .regex(planSlugRegex, 'plan_id must match [a-z0-9-]{1,63}'),
    plan_year: z.number().int().min(2000).max(2100),

    plan_name: localeTextSchema,
    description: localeDescriptionSchema,
    sort_order: z.number().int().min(0).max(10_000),

    plan_category: z.enum(['corporate', 'partnership']),
    member_type_scope: z.enum(['company', 'individual', 'both']),

    annual_fee_minor_units: minorUnitsSchema,

    includes_corporate_plan_id: z
      .string()
      .regex(planSlugRegex)
      .nullable(),

    min_turnover_minor_units: minorUnitsSchema.nullable(),
    max_turnover_minor_units: minorUnitsSchema.nullable(),
    max_duration_years: z.number().int().positive().nullable(),
    max_member_age: z.number().int().min(1).max(199).nullable(),

    benefit_matrix: benefitMatrixSchema,
  })
  .superRefine((plan, ctx) => {
    // Corporate ↔ partnership integrity (data-model.md § 2.2)
    if (
      plan.plan_category === 'partnership' &&
      plan.includes_corporate_plan_id === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Partnership plans must bundle a corporate plan (includes_corporate_plan_id)',
        path: ['includes_corporate_plan_id'],
      });
    }
    if (
      plan.plan_category === 'corporate' &&
      plan.includes_corporate_plan_id !== null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Corporate plans cannot bundle another plan',
        path: ['includes_corporate_plan_id'],
      });
    }
    if (
      plan.plan_category === 'partnership' &&
      plan.benefit_matrix.partnership === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Partnership plans must have benefit_matrix.partnership populated',
        path: ['benefit_matrix', 'partnership'],
      });
    }
    if (
      plan.plan_category === 'corporate' &&
      plan.benefit_matrix.partnership !== null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Corporate plans must have benefit_matrix.partnership = null',
        path: ['benefit_matrix', 'partnership'],
      });
    }

    // Turnover range sanity
    if (
      plan.min_turnover_minor_units !== null &&
      plan.max_turnover_minor_units !== null &&
      plan.min_turnover_minor_units >= plan.max_turnover_minor_units
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'min_turnover_minor_units must be strictly less than max_turnover_minor_units',
        path: ['max_turnover_minor_units'],
      });
    }
  });

export type PlanSchemaInput = z.input<typeof planSchema>;
export type PlanSchemaOutput = z.output<typeof planSchema>;

/**
 * `planPatchSchema` — every field optional. Used by PATCH /api/plans/{...}
 * for partial updates. The corporate/partnership integrity rules only
 * fire when the patch touches `plan_category` or its dependent fields.
 */
export const planPatchSchema = z
  .object({
    plan_name: localeTextSchema.optional(),
    description: localeDescriptionSchema.optional(),
    sort_order: z.number().int().min(0).max(10_000).optional(),

    plan_category: z.enum(['corporate', 'partnership']).optional(),
    member_type_scope: z.enum(['company', 'individual', 'both']).optional(),

    annual_fee_minor_units: minorUnitsSchema.optional(),

    includes_corporate_plan_id: z
      .string()
      .regex(planSlugRegex)
      .nullable()
      .optional(),

    min_turnover_minor_units: minorUnitsSchema.nullable().optional(),
    max_turnover_minor_units: minorUnitsSchema.nullable().optional(),
    max_duration_years: z.number().int().positive().nullable().optional(),
    max_member_age: z.number().int().min(1).max(199).nullable().optional(),

    benefit_matrix: benefitMatrixSchema.optional(),

    // State toggles handled via dedicated activate/deactivate endpoints,
    // NOT via PATCH. Deliberately omitted here.
  })
  .superRefine((patch, ctx) => {
    if (
      patch.min_turnover_minor_units != null &&
      patch.max_turnover_minor_units != null &&
      patch.min_turnover_minor_units >= patch.max_turnover_minor_units
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'min_turnover_minor_units must be strictly less than max_turnover_minor_units',
        path: ['max_turnover_minor_units'],
      });
    }
  });

export type PlanPatchInput = z.input<typeof planPatchSchema>;
export type PlanPatchOutput = z.output<typeof planPatchSchema>;
