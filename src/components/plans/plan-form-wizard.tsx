/**
 * T108 — PlanFormWizard (US2).
 *
 * 4-step wizard (Basics → Fees → Benefits → Review) with per-step
 * validation. Next button is disabled until the current step's
 * minimum fields pass the relevant subset of `planSchema`. Final
 * Save runs the full schema.
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

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { LocaleTextInput } from './locale-text-input';
import { MoneyInput } from './money-input';
import { BenefitMatrixEditor } from './benefit-matrix-editor';
import { usePlanOptions } from './use-plan-options';
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
  readonly submitting?: boolean;
  readonly initialValues?: PlanSchemaInput;
  readonly onSubmit: (draft: PlanSchemaInput) => Promise<void> | void;
  readonly onCancel?: () => void;
}

export function PlanFormWizard({
  currentYear,
  currencyPrefix,
  submitting = false,
  initialValues,
  onSubmit,
  onCancel,
}: PlanFormWizardProps) {
  const t = useTranslations('admin.plans.create');
  const tLabels = useTranslations('admin.plans.create.labels');
  const tButtons = useTranslations('admin.plans.create.buttons');
  const { categoryOptions: CATEGORY_OPTIONS, memberTypeOptions: MEMBER_TYPE_OPTIONS } = usePlanOptions();

  const [step, setStep] = useState<StepKey>('basics');
  const [draft, setDraft] = useState<PlanSchemaInput>(
    () => initialValues ?? emptyDraft(currentYear),
  );

  function update<K extends keyof PlanSchemaInput>(key: K, value: PlanSchemaInput[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const stepIndex = STEPS.indexOf(step);

  // Step-level validity — minimal gate to enable Next.
  const stepValid = useMemo<Record<StepKey, boolean>>(() => {
    const basics =
      /^[a-z0-9-]{1,63}$/.test(draft.plan_id) &&
      Number.isInteger(draft.plan_year) &&
      draft.plan_year >= 2000 &&
      draft.plan_year <= 2100 &&
      (draft.plan_name.en?.trim().length ?? 0) > 0;
    const fees =
      Number.isInteger(draft.annual_fee_minor_units) &&
      draft.annual_fee_minor_units >= 0;
    const benefits = draft.benefit_matrix !== undefined;
    const finalParse = planSchema.safeParse(draft);
    return {
      basics,
      fees: basics && fees,
      benefits: basics && fees && benefits,
      review: finalParse.success,
    };
  }, [draft]);

  const canProceed = stepValid[step];

  async function handleSubmit(): Promise<void> {
    const parsed = planSchema.safeParse(draft);
    if (!parsed.success) {
      return;
    }
    await onSubmit(parsed.data);
  }

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <ol className="flex items-center gap-4 text-sm" aria-label={t('steps.wizardAriaLabel')}>
        {STEPS.map((s, idx) => (
          <li
            key={s}
            aria-current={idx === stepIndex ? 'step' : undefined}
            className={
              idx === stepIndex
                ? 'font-semibold text-foreground'
                : idx < stepIndex
                  ? 'text-muted-foreground line-through'
                  : 'text-muted-foreground'
            }
          >
            {idx + 1}. {t(`steps.${s}`)}
          </li>
        ))}
      </ol>

      <Separator />

      {step === 'basics' ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">{t('steps.basics')}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="plan_id">{tLabels('planId')}</Label>
              <Input
                id="plan_id"
                value={draft.plan_id}
                onChange={(e) => update('plan_id', e.target.value.toLowerCase())}
                placeholder={tLabels('planIdPlaceholder')}
              />
              <p className="text-muted-foreground text-sm">{tLabels('planIdHelp')}</p>
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
              />
            </div>
            <div className="space-y-1">
              <Label>{tLabels('planCategory')}</Label>
              <Select
                value={draft.plan_category}
                onValueChange={(v) => update('plan_category', v as PlanCategory)}
                items={CATEGORY_OPTIONS}
              >
                <SelectTrigger aria-label={tLabels('planCategory')} className="w-full">
                  <SelectValue />
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
                  <SelectValue />
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
          />
          <LocaleTextInput
            label={tLabels('description')}
            value={draft.description}
            onChange={(next) => update('description', next as PlanSchemaInput['description'])}
            multiline
            maxLength={2000}
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
            />
            <p className="text-muted-foreground text-sm">{tLabels('sortOrderHelp')}</p>
          </div>
        </section>
      ) : null}

      {step === 'fees' ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">{t('steps.fees')}</h2>
          <MoneyInput
            label={tLabels('annualFee')}
            value={draft.annual_fee_minor_units}
            onChange={(n) => update('annual_fee_minor_units', n ?? 0)}
            prefix={currencyPrefix}
            required
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <MoneyInput
              label={tLabels('minTurnover')}
              value={draft.min_turnover_minor_units}
              onChange={(n) => update('min_turnover_minor_units', n)}
              prefix={currencyPrefix}
            />
            <MoneyInput
              label={tLabels('maxTurnover')}
              value={draft.max_turnover_minor_units}
              onChange={(n) => update('max_turnover_minor_units', n)}
              prefix={currencyPrefix}
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
              />
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
              />
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
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {step === 'benefits' ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">{t('steps.benefits')}</h2>
          <BenefitMatrixEditor
            value={draft.benefit_matrix}
            onChange={(next) => update('benefit_matrix', next)}
            planCategory={draft.plan_category}
          />
        </section>
      ) : null}

      {step === 'review' ? (
        <section className="space-y-4">
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
                <dd>{draft.plan_category}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('annualFee')}</dt>
                <dd>
                  {currencyPrefix} {(draft.annual_fee_minor_units / 100).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tLabels('memberTypeScope')}</dt>
                <dd>{draft.member_type_scope}</dd>
              </div>
            </dl>
          </div>
          {!stepValid.review ? (
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
              onClick={() => setStep(STEPS[stepIndex - 1]!)}
              disabled={submitting}
            >
              {tButtons('back')}
            </Button>
          ) : null}
          {step !== 'review' ? (
            <Button
              type="button"
              onClick={() => setStep(STEPS[stepIndex + 1]!)}
              disabled={!canProceed || submitting}
            >
              {tButtons('next')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!stepValid.review || submitting}
            >
              {submitting ? tButtons('saving') : tButtons('save')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
