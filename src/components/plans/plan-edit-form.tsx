/**
 * T120 — PlanEditForm (US3).
 *
 * Reuses the US2 wizard primitives (`LocaleTextInput`, `MoneyInput`,
 * `BenefitMatrixEditor`) but lays them out as a flat form — not a
 * 4-step wizard — because edit sessions are short and admins want
 * to see + change everything in one pass.
 *
 * Prior-year lock: when `isPriorYear === true`, all locked fields
 * per `LOCKED_FIELDS_ON_PRIOR_YEAR` are disabled with a lock-icon
 * tooltip. The `<PriorYearLockBanner>` is rendered at the top.
 *
 * Save-time validation: the draft is diffed against `initialValues`
 * (`computePlanPatch` — the same sparse patch the page sends) and that
 * patch is checked with `planPatchSchema`. Invalid fields get the
 * wizard's per-field messages and focus moves to the first one; the
 * draft only reaches `onSubmit` once the patch is valid. Rules that
 * need the whole stored plan (e.g. a new max turnover below the stored
 * min) are still enforced server-side by the merged-plan check in
 * `update-plan.ts`, which also re-runs the schema + the locked-field
 * rule — so this form is a UX nicety, NOT a security boundary.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2Icon, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
import { LocaleTextInput } from './locale-text-input';
import { MoneyInput } from './money-input';
import { BenefitMatrixEditor } from './benefit-matrix-editor';
import {
  PriorYearLockBanner,
  type CurrentYearPlanStatus,
} from './prior-year-lock-banner';
import { usePlanOptions } from './use-plan-options';
import { FieldError, invalidProps, optionalError } from './plan-field-error';
import type { PlanFormField } from './plan-form-errors';
import { computePlanPatch, planPatchFieldErrors } from './plan-patch';
import {
  LOCKED_FIELDS_ON_PRIOR_YEAR,
  type PlanSchemaInput,
} from '@/modules/plans';

export interface PlanEditFormProps {
  readonly initialValues: PlanSchemaInput;
  readonly currentYear: number;
  readonly currencyPrefix: string;
  /** What `currentYear` holds relative to this plan — picks the prior-year
   *  banner's CTA (open that version / clone the year / create the plan). */
  readonly currentYearStatus?: CurrentYearPlanStatus;
  /** Tenant VAT rate in percent (7 for 7 %) for the fee hint; `null` when unknown. */
  readonly vatRatePercent?: number | null;
  readonly submitting?: boolean;
  readonly onSubmit: (draft: PlanSchemaInput) => Promise<void> | void;
  readonly onCancel?: () => void;
}

/**
 * Wraps a field that may be disabled with a lock icon overlay + a
 * native `title` tooltip. Uses the browser's built-in title-attribute
 * tooltip rather than a Radix/BaseUI `<Tooltip>` wrapper because the
 * wrapped children can contain their own interactive elements (a
 * `<Select>` or `<Button>` that each render a native `<button>`), and
 * putting a `<button>`-based TooltipTrigger around another `<button>`
 * is invalid HTML nesting that throws a React hydration error in
 * dev and emits a "button inside button" DOM warning in prod. The
 * native-title approach has zero HTML-nesting concerns, works on
 * keyboard focus + mouse hover, and the banner at the top of the
 * form already explains the rule in full.
 */
function LockWrapper({
  locked,
  children,
}: {
  readonly locked: boolean;
  readonly children: React.ReactNode;
}) {
  const t = useTranslations('admin.plans.priorYearLock');
  if (!locked) return <>{children}</>;
  return (
    <div className="relative" title={t('fieldTooltip')}>
      <div className="pointer-events-none opacity-60">{children}</div>
      <div
        aria-hidden="true"
        className="absolute right-2 top-2 flex items-center gap-1 text-muted-foreground"
      >
        <Lock className="h-4 w-4" />
      </div>
    </div>
  );
}

export function PlanEditForm({
  initialValues,
  currentYear,
  currencyPrefix,
  currentYearStatus = 'other_plans',
  vatRatePercent = null,
  submitting = false,
  onSubmit,
  onCancel,
}: PlanEditFormProps) {
  const t = useTranslations('admin.plans.create.labels');
  const tEdit = useTranslations('admin.plans.edit');
  const tButtons = useTranslations('admin.plans.create.buttons');
  const tErrors = useTranslations('admin.plans.create.fieldErrors');
  const { memberTypeOptions: MEMBER_TYPE_OPTIONS } = usePlanOptions();

  const [draft, setDraft] = useState<PlanSchemaInput>(initialValues);
  const isPriorYear = draft.plan_year < currentYear;

  function update<K extends keyof PlanSchemaInput>(
    key: K,
    value: PlanSchemaInput[K],
  ): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function isLocked(field: (typeof LOCKED_FIELDS_ON_PRIOR_YEAR)[number]): boolean {
    return isPriorYear && LOCKED_FIELDS_ON_PRIOR_YEAR.includes(field);
  }

  // Per-field messages for the patch this save would send. Recomputed on
  // every edit, so a fixed field's message clears as soon as it is valid;
  // shown only after a save attempt.
  const fieldErrors = useMemo(
    () => planPatchFieldErrors(computePlanPatch(initialValues, draft), draft.plan_category),
    [initialValues, draft],
  );
  const [showErrors, setShowErrors] = useState(false);

  function fieldError(field: PlanFormField): string | undefined {
    const key = fieldErrors[field];
    if (key === undefined || !showErrors) return undefined;
    return tErrors(key);
  }

  // After a failed save, focus the first invalid field (WCAG 3.3.1); it
  // announces its message via aria-describedby.
  const formRef = useRef<HTMLFormElement>(null);
  const [focusErrorRequest, setFocusErrorRequest] = useState(0);
  useEffect(() => {
    if (focusErrorRequest === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-field-error]')
      ?.focus();
  }, [focusErrorRequest]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (Object.keys(fieldErrors).length > 0) {
      setShowErrors(true);
      setFocusErrorRequest((n) => n + 1);
      return;
    }
    await onSubmit(draft);
  }

  return (
    // noValidate: the per-field messages below replace the browser's bubbles
    // (native min/max would otherwise block the submit before they run).
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-6">
      {isPriorYear ? (
        <PriorYearLockBanner
          planId={draft.plan_id}
          planYear={draft.plan_year}
          currentYear={currentYear}
          currentYearStatus={currentYearStatus}
        />
      ) : null}

      {/* Basics */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t('planName')}</h2>
        <LocaleTextInput
          label={t('planName')}
          value={draft.plan_name}
          onChange={(next) => update('plan_name', next as PlanSchemaInput['plan_name'])}
          required
          {...optionalError(fieldError('plan_name'))}
        />
        <LocaleTextInput
          label={t('description')}
          value={draft.description}
          onChange={(next) => update('description', next as PlanSchemaInput['description'])}
          multiline
          maxLength={2000}
          required
          {...optionalError(fieldError('description'))}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label>{t('sortOrder')}</Label>
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
            <FieldError field="sort_order" message={fieldError('sort_order')} />
          </div>
          <LockWrapper locked={isLocked('member_type_scope')}>
            <div className="space-y-1">
              <Label>{t('memberTypeScope')}</Label>
              <Select
                value={draft.member_type_scope}
                onValueChange={(v) => {
                  if (v === null) return;
                  update('member_type_scope', v as PlanSchemaInput['member_type_scope']);
                }}
                disabled={isLocked('member_type_scope')}
                items={MEMBER_TYPE_OPTIONS}
              >
                <SelectTrigger aria-label={t('memberTypeScope')} className="w-full">
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
          </LockWrapper>
        </div>
      </section>

      <Separator />

      {/* Fees */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t('annualFee')}</h2>
        <LockWrapper locked={isLocked('annual_fee_minor_units')}>
          <MoneyInput
            label={t('annualFee')}
            value={draft.annual_fee_minor_units}
            onChange={(n) => update('annual_fee_minor_units', n ?? 0)}
            prefix={currencyPrefix}
            disabled={isLocked('annual_fee_minor_units')}
            required
            {...optionalError(fieldError('annual_fee_minor_units'))}
            helpText={
              vatRatePercent === null
                ? t('annualFeeHelpNoRate')
                : t('annualFeeHelp', { rate: vatRatePercent })
            }
          />
        </LockWrapper>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <LockWrapper locked={isLocked('min_turnover_minor_units')}>
            <MoneyInput
              label={t('minTurnover')}
              value={draft.min_turnover_minor_units}
              onChange={(n) => update('min_turnover_minor_units', n)}
              prefix={currencyPrefix}
              disabled={isLocked('min_turnover_minor_units')}
              {...optionalError(fieldError('min_turnover_minor_units'))}
            />
          </LockWrapper>
          <LockWrapper locked={isLocked('max_turnover_minor_units')}>
            <MoneyInput
              label={t('maxTurnover')}
              value={draft.max_turnover_minor_units}
              onChange={(n) => update('max_turnover_minor_units', n)}
              prefix={currencyPrefix}
              disabled={isLocked('max_turnover_minor_units')}
              {...optionalError(fieldError('max_turnover_minor_units'))}
            />
          </LockWrapper>
          <LockWrapper locked={isLocked('max_duration_years')}>
            <div className="space-y-1">
              <Label htmlFor="max_duration">{t('maxDurationYears')}</Label>
              <Input
                id="max_duration"
                type="number"
                min={1}
                value={draft.max_duration_years ?? ''}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  update('max_duration_years', Number.isFinite(v) && v > 0 ? v : null);
                }}
                disabled={isLocked('max_duration_years')}
                {...invalidProps('max_duration', fieldError('max_duration_years'))}
              />
              <FieldError field="max_duration" message={fieldError('max_duration_years')} />
            </div>
          </LockWrapper>
          <LockWrapper locked={isLocked('max_member_age')}>
            <div className="space-y-1">
              <Label htmlFor="max_member_age">{t('maxMemberAge')}</Label>
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
                disabled={isLocked('max_member_age')}
                {...invalidProps('max_member_age', fieldError('max_member_age'))}
              />
              <FieldError field="max_member_age" message={fieldError('max_member_age')} />
            </div>
          </LockWrapper>
        </div>
      </section>

      <Separator />

      {/* Benefits */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{t('benefitMatrix')}</h2>
        {/* No control owns the matrix-level message, so it takes focus itself. */}
        <FieldError
          field="benefit_matrix"
          message={fieldError('benefit_matrix')}
          focusable
        />
        <LockWrapper locked={isLocked('benefit_matrix')}>
          <BenefitMatrixEditor
            value={draft.benefit_matrix}
            onChange={(next) => update('benefit_matrix', next)}
            planCategory={draft.plan_category}
            disabled={isLocked('benefit_matrix')}
          />
        </LockWrapper>
      </section>

      <Separator />

      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            {tButtons('cancel')}
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting && (
            <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />
          )}
          {submitting ? tEdit('saving') : tEdit('save')}
        </Button>
      </div>
    </form>
  );
}
