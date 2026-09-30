/**
 * T120 — PlanEditForm (US3).
 *
 * Reuses the US2 wizard primitives (`LocaleTextInput`, `MoneyInput`,
 * `BenefitMatrixEditor`) but lays them out as a flat form — not a
 * 4-step wizard — because edit sessions are short and admins want
 * to see + change everything in one pass.
 *
 * Prior-year lock: when `isPriorYear === true`, all locked fields
 * per `LOCKED_FIELDS_ON_PRIOR_YEAR` are read-only (or disabled) with
 * AURA's lock icon and read to a screen reader as locked. The
 * `<PriorYearLockBanner>` is rendered at the top.
 *
 * Client-side validation uses `planPatchSchema.partial()` at save
 * time. The server re-runs the same schema + the locked-field rule,
 * so this form is a UX nicety — NOT a security boundary.
 *
 * 122 US6 (T606): on AURA as the `Admin-plan-edit` (+ `-locked`) boards
 * draw it — the "Plan name", "Annual fee" and "Benefit matrix" fieldset
 * cards (a partnership plan's benefits in a card of their own), then
 * Cancel / "Save changes", pinned to the bottom of a phone.
 */
'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ActionBar, Button, Card, Select, TextField } from '@jirawatpyk/aura-react';
import { LocaleTextInput } from './locale-text-input';
import { MoneyInput } from './money-input';
import { BenefitMatrixEditor } from './benefit-matrix-editor';
import {
  PriorYearLockBanner,
  type CurrentYearPlanStatus,
} from './prior-year-lock-banner';
import { PlanLockedNote, lockedFieldProps, lockedSelectProps } from './plan-locked-note';
import { usePlanOptions } from './use-plan-options';
import {
  LOCKED_FIELDS_ON_PRIOR_YEAR,
  type PlanSchemaInput,
} from '@/modules/plans';

export interface PlanEditFormProps {
  readonly initialValues: PlanSchemaInput;
  readonly currentYear: number;
  readonly currencyUnit: string;
  /** What `currentYear` holds relative to this plan — picks the prior-year
   *  banner's CTA (open that version / clone the year / create the plan). */
  readonly currentYearStatus?: CurrentYearPlanStatus;
  /** Tenant VAT rate in percent (7 for 7 %) for the fee hint; `null` when unknown. */
  readonly vatRatePercent?: number | null;
  readonly submitting?: boolean;
  readonly onSubmit: (draft: PlanSchemaInput) => Promise<void> | void;
  readonly onCancel?: () => void;
}

export function PlanEditForm({
  initialValues,
  currentYear,
  currencyUnit,
  currentYearStatus = 'other_plans',
  vatRatePercent = null,
  submitting = false,
  onSubmit,
  onCancel,
}: PlanEditFormProps) {
  const t = useTranslations('admin.plans.create.labels');
  const tEdit = useTranslations('admin.plans.edit');
  const tButtons = useTranslations('admin.plans.create.buttons');
  const tMatrix = useTranslations('admin.plans.create.matrix');
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

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    await onSubmit(draft);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-[var(--aura-space-6)]">
      {isPriorYear ? (
        <>
          <PriorYearLockBanner
            planId={draft.plan_id}
            planYear={draft.plan_year}
            currentYear={currentYear}
            currentYearStatus={currentYearStatus}
          />
          <PlanLockedNote />
        </>
      ) : null}

      <SectionCard id="name" title={t('planName')}>
        <LocaleTextInput
          label={t('planName')}
          value={draft.plan_name}
          onChange={(next) => update('plan_name', next as PlanSchemaInput['plan_name'])}
          required
        />
        <LocaleTextInput
          label={t('description')}
          value={draft.description}
          onChange={(next) => update('description', next as PlanSchemaInput['description'])}
          multiline
          maxLength={2000}
          required
        />
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
          <TextField
            id="sort_order"
            label={t('sortOrder')}
            type="number"
            min={0}
            max={10_000}
            value={draft.sort_order}
            onChange={(e) => update('sort_order', Number.parseInt(e.target.value, 10) || 0)}
          />
          <Select
            id="member_type_scope"
            label={t('memberTypeScope')}
            value={draft.member_type_scope}
            onChange={(e) =>
              update('member_type_scope', e.target.value as PlanSchemaInput['member_type_scope'])
            }
            options={MEMBER_TYPE_OPTIONS}
            {...lockedSelectProps(isLocked('member_type_scope'))}
          />
        </div>
      </SectionCard>

      <SectionCard id="fee" title={t('annualFee')}>
        <MoneyInput
          id="annual_fee"
          label={t('annualFee')}
          value={draft.annual_fee_minor_units}
          onChange={(n) => update('annual_fee_minor_units', n ?? 0)}
          unit={currencyUnit}
          locked={isLocked('annual_fee_minor_units')}
          required
          helpText={
            vatRatePercent === null
              ? t('annualFeeHelpNoRate')
              : t('annualFeeHelp', { rate: vatRatePercent })
          }
        />
        <div className="grid grid-cols-1 gap-[var(--aura-space-4)] md:grid-cols-2">
          <MoneyInput
            id="min_turnover"
            label={t('minTurnover')}
            value={draft.min_turnover_minor_units}
            onChange={(n) => update('min_turnover_minor_units', n)}
            unit={currencyUnit}
            locked={isLocked('min_turnover_minor_units')}
          />
          <MoneyInput
            id="max_turnover"
            label={t('maxTurnover')}
            value={draft.max_turnover_minor_units}
            onChange={(n) => update('max_turnover_minor_units', n)}
            unit={currencyUnit}
            locked={isLocked('max_turnover_minor_units')}
          />
          <TextField
            id="max_duration"
            label={t('maxDurationYears')}
            type="number"
            min={1}
            value={draft.max_duration_years ?? ''}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              update('max_duration_years', Number.isFinite(v) && v > 0 ? v : null);
            }}
            {...lockedFieldProps(isLocked('max_duration_years'))}
          />
          <TextField
            id="max_member_age"
            label={t('maxMemberAge')}
            type="number"
            min={1}
            max={199}
            value={draft.max_member_age ?? ''}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              update('max_member_age', Number.isFinite(v) && v > 0 ? v : null);
            }}
            {...lockedFieldProps(isLocked('max_member_age'))}
          />
        </div>
      </SectionCard>

      <BenefitMatrixEditor
        value={draft.benefit_matrix}
        onChange={(next) => update('benefit_matrix', next)}
        planCategory={draft.plan_category}
        locked={isLocked('benefit_matrix')}
        renderSection={({ id, children }) => (
          <SectionCard
            id={id === 'benefits' ? 'benefits' : 'partnership'}
            title={id === 'benefits' ? t('benefitMatrix') : tMatrix('section.partnershipBenefits')}
          >
            {children}
          </SectionCard>
        )}
      />

      {/* Cancel before the primary action (ux-standards § 11.1); pinned to
          the bottom of a phone (globals.css `.plan-form-actions`). */}
      <ActionBar className="chamber-viewport-actionbar plan-form-actions">
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            {tButtons('cancel')}
          </Button>
        ) : null}
        <Button type="submit" loading={submitting}>
          {submitting ? tEdit('saving') : tEdit('save')}
        </Button>
      </ActionBar>
    </form>
  );
}

/** One part of the form as an AURA fieldset card named by its h2. */
function SectionCard({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Card as="fieldset" title={title} titleId={`plan-edit-${id}`} headingLevel={2} className="min-w-0">
      <div className="space-y-[var(--aura-space-4)]">{children}</div>
    </Card>
  );
}
