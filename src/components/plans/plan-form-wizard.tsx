/**
 * T108 — PlanFormWizard (US2).
 *
 * 4-step wizard (Basics → Fees → Benefits → Review) with per-step
 * validation. Next validates the current step against `planSchema`
 * (shape + the cross-field rules); a failing step stays put, its
 * Stepper circle turns into an error and each offending field shows
 * its message (see `plan-form-errors.ts`). Final Save runs the full
 * schema and jumps back to the first failing step.
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Stepper, type StepperStep } from '@/components/ui/stepper';
import { LocaleTextInput } from './locale-text-input';
import { MoneyInput } from './money-input';
import { BenefitMatrixEditor } from './benefit-matrix-editor';
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

export interface PlanFormWizardProps {
  readonly currentYear: number;
  readonly currencyPrefix: string;
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
  currencyPrefix,
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
    refForStep[step].current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-field-error]')
      ?.focus();
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

  // Canonical Stepper primitive (`@/components/ui/stepper`) — replaces the
  // earlier ad-hoc `<ol>` text list so F2 plan creation shares the visual
  // language used by F5 PaySheet + F6 webhook-config-wizard (circle +
  // connector line + Check icon on completed steps + WCAG `aria-current`).
  // Round 2 adds an `error` status (driven by `failedStep`) so a final-
  // submit validation failure is signalled visually on the offending
  // step's circle rather than only via a generic error toast on Review.
  const stepperSteps: StepperStep[] = useMemo(
    () =>
      STEPS.map((s, idx) => ({
        id: s,
        label: t(`steps.${s}`),
        status:
          s === failedStep && stepHasErrors[s]
            ? 'error'
            : idx < stepIndex
              ? 'complete'
              : idx === stepIndex
                ? 'current'
                : 'upcoming',
      })),
    [stepIndex, failedStep, stepHasErrors, t],
  );

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

  return (
    <div className="space-y-6">
      <Stepper
        steps={stepperSteps}
        aria-label={t('steps.wizardAriaLabel')}
        compact
      />
      {/* F2 polish round 2 — mobile-only compact summary. Stepper hides
          labels below sm:640px so 3-4 long Thai/Swedish labels don't
          overflow; this single-line summary replaces them. aria-hidden
          because the Stepper already exposes `aria-current="step"` to
          screen readers — we don't want a double announcement. */}
      <p
        className="text-muted-foreground sm:hidden text-center text-sm"
        aria-hidden="true"
      >
        {t('steps.mobileSummary', {
          current: stepIndex + 1,
          total: STEPS.length,
          label: t(`steps.${step}`),
        })}
      </p>

      <Separator />

      {step === 'basics' ? (
        <section
          ref={basicsRef}
          tabIndex={-1}
          className="space-y-4 focus-visible:outline-none"
        >
          <h2 className="text-lg font-semibold">{t('steps.basics')}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="plan_id">{tLabels('planId')}</Label>
              <Input
                id="plan_id"
                value={draft.plan_id}
                onChange={(e) => update('plan_id', e.target.value.toLowerCase())}
                placeholder={tLabels('planIdPlaceholder')}
                {...invalidProps('plan_id', fieldError('plan_id'))}
              />
              <p className="text-muted-foreground text-sm">{tLabels('planIdHelp')}</p>
              <FieldError field="plan_id" message={fieldError('plan_id')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan_year">{tLabels('planYear')}</Label>
              <Input
                id="plan_year"
                type="number"
                min={2000}
                max={2100}
                value={draft.plan_year}
                onChange={(e) =>
                  update('plan_year', Number.parseInt(e.target.value, 10) || currentYear)
                }
                {...invalidProps('plan_year', fieldError('plan_year'))}
              />
              <FieldError field="plan_year" message={fieldError('plan_year')} />
            </div>
            <div className="space-y-1">
              <Label>{tLabels('planCategory')}</Label>
              <Select
                value={draft.plan_category}
                onValueChange={(v) => update('plan_category', v as PlanCategory)}
                items={CATEGORY_OPTIONS}
              >
                <SelectTrigger aria-label={tLabels('planCategory')} className="w-full">
                  <TranslatedSelectValue
                    translate={(v) =>
                      CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? null
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{tLabels('memberTypeScope')}</Label>
              <Select
                value={draft.member_type_scope}
                onValueChange={(v) =>
                  update('member_type_scope', v as PlanSchemaInput['member_type_scope'])
                }
                items={MEMBER_TYPE_OPTIONS}
              >
                <SelectTrigger aria-label={tLabels('memberTypeScope')} className="w-full">
                  <TranslatedSelectValue
                    translate={(v) =>
                      MEMBER_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? null
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {MEMBER_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <LocaleTextInput
            label={tLabels('planName')}
            value={draft.plan_name}
            onChange={(next) => update('plan_name', next as PlanSchemaInput['plan_name'])}
            required
            {...optionalError(fieldError('plan_name'))}
          />
          <LocaleTextInput
            label={tLabels('description')}
            value={draft.description}
            onChange={(next) => update('description', next as PlanSchemaInput['description'])}
            multiline
            maxLength={2000}
            required
            {...optionalError(fieldError('description'))}
          />
          <div className="space-y-1">
            <Label htmlFor="sort_order">{tLabels('sortOrder')}</Label>
            <Input
              id="sort_order"
              type="number"
              min={0}
              max={10_000}
              value={draft.sort_order}
              onChange={(e) =>
                update('sort_order', Number.parseInt(e.target.value, 10) || 0)
              }
              {...invalidProps('sort_order', fieldError('sort_order'))}
            />
            <p className="text-muted-foreground text-sm">{tLabels('sortOrderHelp')}</p>
            <FieldError field="sort_order" message={fieldError('sort_order')} />
          </div>
        </section>
      ) : null}

      {step === 'fees' ? (
        <section
          ref={feesRef}
          tabIndex={-1}
          className="space-y-4 focus-visible:outline-none"
        >
          <h2 className="text-lg font-semibold">{t('steps.fees')}</h2>
          <MoneyInput
            label={tLabels('annualFee')}
            value={draft.annual_fee_minor_units}
            onChange={(n) => update('annual_fee_minor_units', n ?? 0)}
            prefix={currencyPrefix}
            required
            helpText={
              vatRatePercent === null
                ? tLabels('annualFeeHelpNoRate')
                : tLabels('annualFeeHelp', { rate: vatRatePercent })
            }
            {...optionalError(fieldError('annual_fee_minor_units'))}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <MoneyInput
              label={tLabels('minTurnover')}
              value={draft.min_turnover_minor_units}
              onChange={(n) => update('min_turnover_minor_units', n)}
              prefix={currencyPrefix}
              {...optionalError(fieldError('min_turnover_minor_units'))}
            />
            <MoneyInput
              label={tLabels('maxTurnover')}
              value={draft.max_turnover_minor_units}
              onChange={(n) => update('max_turnover_minor_units', n)}
              prefix={currencyPrefix}
              {...optionalError(fieldError('max_turnover_minor_units'))}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="max_duration">{tLabels('maxDurationYears')}</Label>
              <Input
                id="max_duration"
                type="number"
                min={1}
                value={draft.max_duration_years ?? ''}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  update('max_duration_years', Number.isFinite(v) && v > 0 ? v : null);
                }}
                {...invalidProps('max_duration', fieldError('max_duration_years'))}
              />
              <FieldError field="max_duration" message={fieldError('max_duration_years')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="max_member_age">{tLabels('maxMemberAge')}</Label>
              <Input
                id="max_member_age"
                type="number"
                min={1}
                max={199}
                value={draft.max_member_age ?? ''}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  update('max_member_age', Number.isFinite(v) && v > 0 ? v : null);
                }}
                {...invalidProps('max_member_age', fieldError('max_member_age'))}
              />
              <FieldError field="max_member_age" message={fieldError('max_member_age')} />
            </div>
          </div>
          {draft.plan_category === 'partnership' ? (
            <div className="space-y-1">
              <Label htmlFor="bundle">{tLabels('includesCorporatePlanId')}</Label>
              <Input
                id="bundle"
                value={draft.includes_corporate_plan_id ?? ''}
                onChange={(e) =>
                  update(
                    'includes_corporate_plan_id',
                    e.target.value.trim() === '' ? null : e.target.value.toLowerCase(),
                  )
                }
                placeholder={tLabels('planIdPlaceholder')}
                {...invalidProps('bundle', fieldError('includes_corporate_plan_id'))}
              />
              <FieldError field="bundle" message={fieldError('includes_corporate_plan_id')} />
            </div>
          ) : null}
        </section>
      ) : null}

      {step === 'benefits' ? (
        <section
          ref={benefitsRef}
          tabIndex={-1}
          className="space-y-4 focus-visible:outline-none"
        >
          <h2 className="text-lg font-semibold">{t('steps.benefits')}</h2>
          {/* No control owns the matrix-level message, so it takes focus itself. */}
          <FieldError
            field="benefit_matrix"
            message={fieldError('benefit_matrix')}
            focusable
          />
          <BenefitMatrixEditor
            value={draft.benefit_matrix}
            onChange={(next) => update('benefit_matrix', next)}
            planCategory={draft.plan_category}
          />
        </section>
      ) : null}

      {step === 'review' ? (
        <section
          ref={reviewRef}
          tabIndex={-1}
          className="space-y-4 focus-visible:outline-none"
        >
          <h2 className="text-lg font-semibold">{t('steps.review')}</h2>
          <div className="rounded-md border p-4 text-sm">
            <dl className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{tLabels('planId')}</dt>
                <dd className="font-mono">{draft.plan_id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('planYear')}</dt>
                <dd>{draft.plan_year}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('planName')}</dt>
                <dd>{draft.plan_name.en}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('planCategory')}</dt>
                <dd>
                  {CATEGORY_OPTIONS.find((o) => o.value === draft.plan_category)?.label ??
                    draft.plan_category}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('annualFee')}</dt>
                <dd>
                  {Number.isInteger(draft.annual_fee_minor_units)
                    ? formatSatangThb(
                        BigInt(draft.annual_fee_minor_units),
                        locale,
                        currencyCode,
                      )
                    : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('memberTypeScope')}</dt>
                <dd>
                  {MEMBER_TYPE_OPTIONS.find((o) => o.value === draft.member_type_scope)
                    ?.label ?? draft.member_type_scope}
                </dd>
              </div>
            </dl>
          </div>
          {stepHasErrors.review ? (
            <p className="text-destructive text-sm" role="alert">
              {t('errors.stepValidation')}
            </p>
          ) : null}
        </section>
      ) : null}

      <Separator />

      <div className="flex items-center justify-between gap-4">
        <div>
          {onCancel ? (
            <Button variant="ghost" type="button" onClick={onCancel} disabled={submitting}>
              {tButtons('cancel')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {stepIndex > 0 ? (
            <Button
              variant="outline"
              type="button"
              onClick={() => navigateToStep(STEPS[stepIndex - 1]!)}
              disabled={submitting}
            >
              {tButtons('back')}
            </Button>
          ) : null}
          {step !== 'review' ? (
            <Button type="button" onClick={goNext} disabled={submitting}>
              {tButtons('next')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting ? (
                <>
                  <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  {tButtons('saving')}
                </>
              ) : (
                tButtons('save')
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// `aria-invalid` + `aria-describedby` for a raw <Input> whose message is
// rendered by <FieldError field={id}>.
function invalidProps(
  id: string,
  message: string | undefined,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return message ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {};
}

// `exactOptionalPropertyTypes` — spread the `error` prop only when set.
function optionalError(message: string | undefined): { error?: string } {
  return message ? { error: message } : {};
}

function FieldError({
  field,
  message,
  focusable = false,
}: {
  readonly field: string;
  readonly message: string | undefined;
  /** For a message no input points at — it receives the error focus itself. */
  readonly focusable?: boolean;
}) {
  if (!message) return null;
  return (
    <p
      id={`${field}-error`}
      className="text-destructive text-sm"
      {...(focusable ? { tabIndex: -1, 'data-field-error': true } : {})}
    >
      {message}
    </p>
  );
}
