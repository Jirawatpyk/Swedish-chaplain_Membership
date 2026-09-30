/**
 * T108 — PlanFormWizard (US2).
 *
 * 4-step wizard (Basics → Fees → Benefits → Review) with per-step
 * validation. Next validates the current step against `planSchema`
 * (shape + the cross-field rules); a failing step stays put and each
 * offending field shows its message (see `plan-form-errors.ts`). Final
 * Save runs the full schema and jumps back to the first failing step.
 *
 * 122 US6 (T605): on AURA as the `Admin-plan-new` board draws it — AURA's
 * Stepper above the steps (the step whose Next / Save failed marked with
 * AURA's error status while it has errors — 5.18, handoff #112), each step one fieldset card (the benefits step two: the
 * matrix and the partnership benefits), AURA's error summary when a step
 * has more than one error, and Cancel | Back / Next. On a phone Back and
 * Next are pinned to the bottom of the screen and Cancel stays in the page
 * (`Admin-plan-new-mobile`).
 *
 * State is held in a single plain `draft` object rather than
 * react-hook-form because:
 *   - Nested `benefit_matrix.partnership` structural transitions
 *     are easier to reason about with plain setState
 *   - The wizard is short-lived and keyboard-controlled, not a
 *     long-running collaborative editor
 *   - Zod is already the authoritative validator — duplicating
 *     rules in RHF resolvers adds no value here
 *
 * Submission calls the supplied `onSubmit` with the validated draft;
 * parent owns the fetch + toast + redirect.
 */
'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ActionBar,
  Alert,
  Button,
  Card,
  FormErrorSummary,
  Select,
  Stepper,
  TextField,
} from '@jirawatpyk/aura-react';
import { formatSatangThb } from '@/lib/format-thb';
import { formatCalendarYear } from '@/lib/format-date-localised';
import { LocaleTextInput } from './locale-text-input';
import { MoneyInput } from './money-input';
import { BenefitMatrixEditor } from './benefit-matrix-editor';
import { FieldError, focusField, optionalError } from './plan-field-error';
import { usePlanOptions } from './use-plan-options';
import {
  planFieldStep,
  planFormFieldErrors,
  type PlanFormField,
} from './plan-form-errors';
import {
  planSchema,
  asBenefitMatrix,
  type BenefitMatrix,
  type PlanCategory,
  type PlanSchemaInput,
} from '@/modules/plans';

const STEPS = ['basics', 'fees', 'benefits', 'review'] as const;
type StepKey = (typeof STEPS)[number];

// R4-S4 — route through `asBenefitMatrix` so the empty wizard initial
// state satisfies the partnership↔category integrity invariant. Default
// category is 'corporate' because the wizard starts on the corporate
// flow; category-switching is handled downstream in the benefits step.
const EMPTY_MATRIX: BenefitMatrix = asBenefitMatrix(
  {
    eblast_per_year: 0,
    website_page_type: null,
    homepage_logo_category: null,
    directory_listing_size: null,
    event_discount_scope: 'none',
    events_cobranded_access: false,
    cultural_tickets_per_year: 0,
    m2m_benefits_access: false,
    business_referrals: false,
    tailor_made_services: false,
    partnership: null,
  },
  'corporate',
);

function emptyDraft(currentYear: number): PlanSchemaInput {
  return {
    plan_id: '',
    plan_year: currentYear,
    plan_name: { en: '' },
    description: { en: '' },
    sort_order: 100,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 0,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: EMPTY_MATRIX,
  };
}

/** The element each field's message is linked from (the error summary's links). */
const FIELD_DOM_ID: Record<PlanFormField, string> = {
  plan_id: 'plan_id',
  plan_year: 'plan_year',
  plan_name: 'plan_name',
  description: 'description',
  sort_order: 'sort_order',
  plan_category: 'plan_category',
  member_type_scope: 'member_type_scope',
  annual_fee_minor_units: 'annual_fee',
  min_turnover_minor_units: 'min_turnover',
  max_turnover_minor_units: 'max_turnover',
  max_duration_years: 'max_duration',
  max_member_age: 'max_member_age',
  includes_corporate_plan_id: 'bundle',
  benefit_matrix: 'benefit_matrix-error',
};

/** The field's label key, for its line in the error summary. */
const FIELD_LABEL: Record<PlanFormField, string> = {
  plan_id: 'planId',
  plan_year: 'planYear',
  plan_name: 'planName',
  description: 'description',
  sort_order: 'sortOrder',
  plan_category: 'planCategory',
  member_type_scope: 'memberTypeScope',
  annual_fee_minor_units: 'annualFee',
  min_turnover_minor_units: 'minTurnover',
  max_turnover_minor_units: 'maxTurnover',
  max_duration_years: 'maxDurationYears',
  max_member_age: 'maxMemberAge',
  includes_corporate_plan_id: 'includesCorporatePlanId',
  benefit_matrix: 'benefitMatrix',
};

export interface PlanFormWizardProps {
  readonly currentYear: number;
  /** The unit shown after the money fields (the tenant currency code). */
  readonly currencyUnit: string;
  /** Tenant currency (ISO 4217) for the Review step's fee — default THB. */
  readonly currencyCode?: string;
  /** Tenant VAT rate in percent (7 for 7 %) for the fee hint; `null` when unknown. */
  readonly vatRatePercent?: number | null;
  readonly submitting?: boolean;
  readonly initialValues?: PlanSchemaInput;
  readonly onSubmit: (draft: PlanSchemaInput) => Promise<void> | void;
  readonly onCancel?: () => void;
}

export function PlanFormWizard({
  currentYear,
  currencyUnit,
  currencyCode = 'THB',
  vatRatePercent = null,
  submitting = false,
  initialValues,
  onSubmit,
  onCancel,
}: PlanFormWizardProps) {
  const t = useTranslations('admin.plans.create');
  const tLabels = useTranslations('admin.plans.create.labels');
  const tButtons = useTranslations('admin.plans.create.buttons');
  const tMatrix = useTranslations('admin.plans.create.matrix');
  const tErrors = useTranslations('admin.plans.create.fieldErrors');
  const locale = useLocale();
  const { categoryOptions: CATEGORY_OPTIONS, memberTypeOptions: MEMBER_TYPE_OPTIONS } = usePlanOptions();

  const [step, setStep] = useState<StepKey>('basics');
  const [draft, setDraft] = useState<PlanSchemaInput>(
    () => initialValues ?? emptyDraft(currentYear),
  );
  // Which step (if any) failed validation on Next / Save. Drives
  // `status='error'` on the Stepper and turns on the per-field messages
  // for that step. Cleared whenever the user moves between steps.
  const [failedStep, setFailedStep] = useState<StepKey | null>(null);

  // F2 polish round 2 — focus management on step transitions (WCAG 2.4.3
  // Focus Order). Without this, clicking Next leaves focus on the Next
  // button while the visible content swaps — keyboard + SR users lose
  // their place. Each step's <section> takes tabIndex={-1} so we can
  // programmatically focus it; the screen reader then reads the h2.
  const basicsRef = useRef<HTMLElement>(null);
  const feesRef = useRef<HTMLElement>(null);
  const benefitsRef = useRef<HTMLElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  // Don't steal focus on initial render — only on user-driven step changes.
  const isFirstStepRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstStepRenderRef.current) {
      isFirstStepRenderRef.current = false;
      return;
    }
    // Map step → ref inline so the effect's dep array only tracks
    // `step`; the four refs are stable across renders by useRef contract.
    const refForStep: Record<StepKey, React.RefObject<HTMLElement | null>> = {
      basics: basicsRef,
      fees: feesRef,
      benefits: benefitsRef,
      review: reviewRef,
    };
    refForStep[step].current?.focus();
  }, [step]);

  // Step navigation helper — clears the error badge whenever the user
  // explicitly moves through the wizard (Back / Next / Step click).
  // Submit-fail uses raw setStep/setFailedStep so the badge persists
  // until the user actively edits, not just lands on the failed step.
  function navigateToStep(target: StepKey): void {
    setStep(target);
    setFailedStep(null);
  }

  function update<K extends keyof PlanSchemaInput>(key: K, value: PlanSchemaInput[K]): void {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      // A corporate plan cannot bundle another plan, and the bundle input
      // is only rendered for partnership plans — drop a bundle left over
      // from a partnership draft so it can't fail validation unseen.
      if (key === 'plan_category' && value === 'corporate') {
        next.includes_corporate_plan_id = null;
      }
      return next;
    });
  }

  const stepIndex = STEPS.indexOf(step);

  // Per-field messages from the authoritative schema (incl. cross-field
  // rules). Recomputed on every edit, so a fixed field's message clears as
  // soon as its value is valid.
  const fieldErrors = useMemo(() => planFormFieldErrors(draft), [draft]);
  const stepHasErrors = useMemo<Record<StepKey, boolean>>(() => {
    const fields = Object.keys(fieldErrors) as PlanFormField[];
    const has = (s: StepKey) => fields.some((f) => planFieldStep(f) === s);
    return {
      basics: has('basics'),
      fees: has('fees'),
      benefits: has('benefits'),
      review: fields.length > 0,
    };
  }, [fieldErrors]);

  // After a failed Next / Save, move focus to the first invalid field of the
  // step (WCAG 3.3.1): it announces its message via aria-describedby, so the
  // messages don't need role="alert" (several at once would talk over each
  // other, and they would re-fire on every keystroke while fixing a value).
  const [focusErrorRequest, setFocusErrorRequest] = useState(0);
  useEffect(() => {
    if (focusErrorRequest === 0) return;
    const refForStep: Record<StepKey, React.RefObject<HTMLElement | null>> = {
      basics: basicsRef,
      fees: feesRef,
      benefits: benefitsRef,
      review: reviewRef,
    };
    focusField(
      refForStep[step].current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-field-error]') ?? null,
    );
    // Only a new request re-runs this; `step` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusErrorRequest]);

  // Messages show only on the step whose Next / Save failed.
  function fieldError(field: PlanFormField): string | undefined {
    const key = fieldErrors[field];
    if (key === undefined || failedStep !== step) return undefined;
    return tErrors(key);
  }

  function goNext(): void {
    if (stepHasErrors[step]) {
      setFailedStep(step);
      setFocusErrorRequest((n) => n + 1);
      return;
    }
    navigateToStep(STEPS[stepIndex + 1]!);
  }

  const stepperSteps = useMemo(
    () =>
      STEPS.map((s) => ({
        id: s,
        label: t(`steps.${s}`),
        ...(failedStep === s && stepHasErrors[s] ? { status: 'error' as const } : {}),
      })),
    [t, failedStep, stepHasErrors],
  );

  // The failed step's messages, in form order, for the summary above it.
  const summaryItems =
    failedStep === step
      ? (Object.keys(FIELD_DOM_ID) as PlanFormField[])
          .filter((f) => fieldErrors[f] !== undefined && planFieldStep(f) === step)
          .map((f) => ({
            field: FIELD_DOM_ID[f],
            message: (
              <>
                <strong>{tLabels(FIELD_LABEL[f])}</strong>
                {' — '}
                {tErrors(fieldErrors[f]!)}
              </>
            ),
          }))
      : [];

  async function handleSubmit(): Promise<void> {
    const parsed = planSchema.safeParse(draft);
    if (!parsed.success) {
      // Jump to the first step (in wizard order) with an invalid field and
      // show its messages there.
      const targetStep =
        (['basics', 'fees', 'benefits'] as const).find((s) => stepHasErrors[s]) ??
        'basics';
      setFailedStep(targetStep);
      setStep(targetStep);
      setFocusErrorRequest((n) => n + 1);
      return;
    }
    await onSubmit(parsed.data);
  }

  const cancelLabel = tButtons('cancel');

  return (
    <div className="space-y-[var(--aura-space-6)]">
      <Stepper label={t('steps.wizardAriaLabel')} steps={stepperSteps} current={step} />

      {/* Only for MORE THAN ONE error (ux-standards § 11.3): one message is
          already on its field, which takes focus. The summary never takes
          focus itself (a constant focusKey), so the field keeps it. */}
      <FormErrorSummary
        focusKey={0}
        errors={summaryItems.length > 1 ? summaryItems : []}
        onSelect={(field) => focusField(document.getElementById(field))}
      />

      {step === 'basics' ? (
        <StepCard stepRef={basicsRef} id="basics" title={t('steps.basics')}>
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
            <TextField
              id="plan_id"
              label={tLabels('planId')}
              value={draft.plan_id}
              onChange={(e) => update('plan_id', e.target.value.toLowerCase())}
              placeholder={tLabels('planIdPlaceholder')}
              hint={tLabels('planIdHelp')}
              {...optionalError(fieldError('plan_id'))}
            />
            <TextField
              id="plan_year"
              label={tLabels('planYear')}
              type="number"
              min={2000}
              max={2100}
              value={draft.plan_year}
              onChange={(e) =>
                update('plan_year', Number.parseInt(e.target.value, 10) || currentYear)
              }
              {...optionalError(fieldError('plan_year'))}
            />
            <Select
              id="plan_category"
              label={tLabels('planCategory')}
              value={draft.plan_category}
              onChange={(e) => update('plan_category', e.target.value as PlanCategory)}
              options={CATEGORY_OPTIONS}
              {...optionalError(fieldError('plan_category'))}
            />
            <Select
              id="member_type_scope"
              label={tLabels('memberTypeScope')}
              value={draft.member_type_scope}
              onChange={(e) =>
                update('member_type_scope', e.target.value as PlanSchemaInput['member_type_scope'])
              }
              options={MEMBER_TYPE_OPTIONS}
              {...optionalError(fieldError('member_type_scope'))}
            />
          </div>
          <LocaleTextInput
            id="plan_name"
            label={tLabels('planName')}
            value={draft.plan_name}
            onChange={(next) => update('plan_name', next as PlanSchemaInput['plan_name'])}
            required
            {...optionalError(fieldError('plan_name'))}
          />
          <LocaleTextInput
            id="description"
            label={tLabels('description')}
            value={draft.description}
            onChange={(next) => update('description', next as PlanSchemaInput['description'])}
            multiline
            maxLength={2000}
            required
            {...optionalError(fieldError('description'))}
          />
          <TextField
            id="sort_order"
            label={tLabels('sortOrder')}
            type="number"
            min={0}
            max={10_000}
            value={draft.sort_order}
            onChange={(e) => update('sort_order', Number.parseInt(e.target.value, 10) || 0)}
            hint={tLabels('sortOrderHelp')}
            {...optionalError(fieldError('sort_order'))}
          />
        </StepCard>
      ) : null}

      {step === 'fees' ? (
        <StepCard stepRef={feesRef} id="fees" title={t('steps.fees')}>
          <MoneyInput
            id="annual_fee"
            label={tLabels('annualFee')}
            value={draft.annual_fee_minor_units}
            onChange={(n) => update('annual_fee_minor_units', n ?? 0)}
            unit={currencyUnit}
            required
            helpText={
              vatRatePercent === null
                ? tLabels('annualFeeHelpNoRate')
                : tLabels('annualFeeHelp', { rate: vatRatePercent })
            }
            {...optionalError(fieldError('annual_fee_minor_units'))}
          />
          <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
            <MoneyInput
              id="min_turnover"
              label={tLabels('minTurnover')}
              value={draft.min_turnover_minor_units}
              onChange={(n) => update('min_turnover_minor_units', n)}
              unit={currencyUnit}
              {...optionalError(fieldError('min_turnover_minor_units'))}
            />
            <MoneyInput
              id="max_turnover"
              label={tLabels('maxTurnover')}
              value={draft.max_turnover_minor_units}
              onChange={(n) => update('max_turnover_minor_units', n)}
              unit={currencyUnit}
              {...optionalError(fieldError('max_turnover_minor_units'))}
            />
            <TextField
              id="max_duration"
              label={tLabels('maxDurationYears')}
              type="number"
              min={1}
              value={draft.max_duration_years ?? ''}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                update('max_duration_years', Number.isFinite(v) && v > 0 ? v : null);
              }}
              {...optionalError(fieldError('max_duration_years'))}
            />
            <TextField
              id="max_member_age"
              label={tLabels('maxMemberAge')}
              type="number"
              min={1}
              max={199}
              value={draft.max_member_age ?? ''}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                update('max_member_age', Number.isFinite(v) && v > 0 ? v : null);
              }}
              {...optionalError(fieldError('max_member_age'))}
            />
          </div>
          {draft.plan_category === 'partnership' ? (
            <TextField
              id="bundle"
              label={tLabels('includesCorporatePlanId')}
              value={draft.includes_corporate_plan_id ?? ''}
              onChange={(e) =>
                update(
                  'includes_corporate_plan_id',
                  e.target.value.trim() === '' ? null : e.target.value.toLowerCase(),
                )
              }
              placeholder={tLabels('planIdPlaceholder')}
              {...optionalError(fieldError('includes_corporate_plan_id'))}
            />
          ) : null}
        </StepCard>
      ) : null}

      {step === 'benefits' ? (
        <div ref={benefitsRef as React.RefObject<HTMLDivElement>} tabIndex={-1} className="space-y-[var(--aura-space-6)] focus-visible:outline-none">
          <BenefitMatrixEditor
            value={draft.benefit_matrix}
            onChange={(next) => update('benefit_matrix', next)}
            planCategory={draft.plan_category}
            renderSection={({ id, children }) =>
              id === 'benefits' ? (
                <Card as="fieldset" title={t('steps.benefits')} titleId="plan-step-benefits" headingLevel={2} className="min-w-0">
                  {/* No control owns the matrix-level message, so it takes focus itself. */}
                  <FieldError field="benefit_matrix" message={fieldError('benefit_matrix')} focusable />
                  {children}
                </Card>
              ) : (
                <Card as="fieldset" title={tMatrix('section.partnershipBenefits')} titleId="plan-step-partnership" headingLevel={2} className="min-w-0">
                  {children}
                </Card>
              )
            }
          />
        </div>
      ) : null}

      {step === 'review' ? (
        <StepCard stepRef={reviewRef} id="review" title={t('steps.review')}>
          <dl className="grid grid-cols-1 gap-[var(--aura-space-3)] md:grid-cols-2">
            <ReviewItem label={tLabels('planId')}>
              <span className="aura-text-mono">{draft.plan_id}</span>
            </ReviewItem>
            <ReviewItem label={tLabels('planYear')}>{formatCalendarYear(draft.plan_year, locale)}</ReviewItem>
            <ReviewItem label={tLabels('planName')}>{draft.plan_name.en}</ReviewItem>
            <ReviewItem label={tLabels('planCategory')}>
              {CATEGORY_OPTIONS.find((o) => o.value === draft.plan_category)?.label ??
                draft.plan_category}
            </ReviewItem>
            <ReviewItem label={tLabels('annualFee')}>
              {Number.isInteger(draft.annual_fee_minor_units)
                ? formatSatangThb(BigInt(draft.annual_fee_minor_units), locale, currencyCode)
                : '—'}
            </ReviewItem>
            <ReviewItem label={tLabels('memberTypeScope')}>
              {MEMBER_TYPE_OPTIONS.find((o) => o.value === draft.member_type_scope)?.label ??
                draft.member_type_scope}
            </ReviewItem>
          </dl>
          {stepHasErrors.review ? (
            <Alert tone="danger" role="alert">
              {t('errors.stepValidation')}
            </Alert>
          ) : null}
        </StepCard>
      ) : null}

      {/* On a phone Cancel stays in the page and Back / Next are pinned; from
          640px Cancel starts the same row (board `Admin-plan-new`). */}
      {onCancel ? (
        <Button type="button" variant="secondary" fullWidth onClick={onCancel} disabled={submitting} className="sm:hidden">
          {cancelLabel}
        </Button>
      ) : null}
      {/* Stand-in until AURA #116: the ActionBar has no start slot, so Cancel
          rides first in its actions with `me-auto` (`.plan-form-actions--split`). */}
      <ActionBar className="chamber-viewport-actionbar plan-form-actions plan-form-actions--even plan-form-actions--split">
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting} className="me-auto max-sm:hidden">
            {cancelLabel}
          </Button>
        ) : null}
        {stepIndex > 0 ? (
          <Button
            type="button"
            variant="secondary"
            icon="arrow-left"
            onClick={() => navigateToStep(STEPS[stepIndex - 1]!)}
            disabled={submitting}
          >
            {tButtons('back')}
          </Button>
        ) : null}
        {step !== 'review' ? (
          <Button type="button" iconRight="arrow-right" onClick={goNext} disabled={submitting}>
            {tButtons('next')}
          </Button>
        ) : (
          <Button type="button" onClick={handleSubmit} loading={submitting}>
            {submitting ? tButtons('saving') : tButtons('save')}
          </Button>
        )}
      </ActionBar>
    </div>
  );
}

/** One wizard step as a fieldset card, focused when the step opens (WCAG 2.4.3). */
function StepCard({
  stepRef,
  id,
  title,
  children,
}: {
  readonly stepRef: React.RefObject<HTMLElement | null>;
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div ref={stepRef as React.RefObject<HTMLDivElement>} tabIndex={-1} className="focus-visible:outline-none">
      <Card as="fieldset" title={title} titleId={`plan-step-${id}`} headingLevel={2} className="min-w-0">
        <div className="space-y-[var(--aura-space-4)]">{children}</div>
      </Card>
    </div>
  );
}

function ReviewItem({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
