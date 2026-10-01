'use client';

/**
 * F8 Phase 4 Wave I2/I3 · Task 8 — `StepCard`, the plain-language
 * replacement for `schedule-editor.tsx`'s raw `StepRow` (spec §5.2, §5.3,
 * §6.2). Same callback contract as `StepRow` — a drop-in the editor swaps
 * to in Task 9.
 *
 * v2 rework (`.superpowers/sdd/rework-stepcard-v2-brief.md`, live QA +
 * code review) — three fixes shipped together:
 *   1. The channel segmented control's hidden `RadioGroupItem` was an
 *      in-flow 16px box (twMerge doesn't remove it — `sr-only` and
 *      `relative`/`size-4` are DIFFERENT class groups, so both survive,
 *      and Tailwind's generated stylesheet happens to order `.relative`
 *      AFTER `.sr-only` so `position: relative` wins the cascade). Now
 *      an absolutely-positioned, zero-layout, fully transparent overlay
 *      instead — see `HIDDEN_RADIO_CLASS`.
 *   2. The day-stepper + separate Before/After toggle is replaced by
 *      ONE plain-language "Send timing" `<Select>` of the tier's
 *      standard reminder points (`TIER_REMINDER_OFFSETS`), with
 *      already-used (offset, channel) combinations disabled.
 *   3. Every step_id recompose path funnels through the collision-safe
 *      `composeUniqueStepId` (never a bare `composeStepId`), closing
 *      the duplicate-`step_id` class of bug at its source.
 *
 * v3 rework (`.superpowers/sdd/rework-stepcard-v3-brief.md`, live QA
 * final decisions) — three more fixes:
 *   1. The "Send timing" `<Select>` gains a "Custom…" option. Selecting
 *      it (or loading a step whose offset isn't one of the tier's
 *      standard points) reveals a numeric day input + a before/after
 *      segmented toggle so the admin can set ANY offset — recomposed
 *      through the same `composeUniqueStepId`/`composeTemplateId` path
 *      as every standard option (see `applyTiming`/`applyCustomDays`).
 *   2. The "Advanced (raw identifiers)" `Collapsible` — the raw
 *      `step_id`/`template_id` inputs plus the v2-added raw-offset
 *      input — is REMOVED entirely. The admin never needs to hand-edit
 *      derived identifiers; doing so was a footgun (a typo makes the
 *      email undeliverable) and, worse, the raw-offset input was the
 *      one place a keystroke could recompose `step_id` on every change
 *      — see Change 3 below.
 *   3. `step_id` is a DERIVED value recomposed on every timing/channel
 *      edit — including on every keystroke of the new custom-day input.
 *      `schedule-editor.tsx` used to key `<StepCard>` by `step_id`
 *      itself, so a recompose changed the React key and remounted the
 *      whole card, dropping focus mid-typing. The editor now keys by a
 *      stable `_uiKey` (`schedule-editor.tsx`'s `EditorStep`) that never
 *      changes across edits — every `{...step, ...}` spread in this
 *      file carries it forward automatically, and the two places that
 *      build a fresh object instead of spreading (`handleChannelChange`)
 *      thread it through explicitly.
 *
 * Key idea (unchanged): `step_id` and `template_id` are DERIVED values,
 * not free text. The wire grammar (`./step-id-composer`) requires the
 * offset token first in `step_id` (gateway's `deriveOffsetFromStepId`
 * slices the first dot-segment) and the tier last in `template_id`
 * (gateway's `deriveTierFromTemplateId` matches on `endsWith('.'+tier)`).
 * Every friendly-control change (timing, channel, task type) recomposes
 * both identifiers so an admin editing plain-language controls can
 * never produce a malformed wire shape.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Combobox,
  IconButton,
  NumberField,
  RadioGroup,
  Select,
  type ComboboxOption,
} from '@jirawatpyk/aura-react';
import {
  TIER_REMINDER_OFFSETS,
  offsetKeyFromDays,
  daysFromOffsetKey,
  RENEWAL_KNOWN_TASK_TYPES,
  isKnownTaskType,
} from '@/modules/renewals/client';
import type { TierBucket } from '@/modules/renewals/client';
import type { EditorStep } from './schedule-editor';
import { composeUniqueStepId, composeTemplateId } from './step-id-composer';
import { EmailPreview } from './email-preview';
import { timingSentence } from './format-offset';

export interface StepCardProps {
  readonly tierBucket: TierBucket;
  readonly step: EditorStep;
  readonly index: number;
  readonly total: number;
  readonly readOnly: boolean;
  /**
   * Every OTHER step currently in this tier bucket (i.e. the full step
   * list minus this card's own step). Drives two v2 rework features:
   *   - the "Send timing" dropdown's disabled (already-used) options
   *     (offsets scoped to THIS step's channel — see
   *     `usedOffsetsForChannel` below);
   *   - collision-safe `step_id` recompose via `composeUniqueStepId`
   *     (scoped to the whole bucket — `step_id` uniqueness is bucket-
   *     wide, not per-channel).
   */
  readonly siblingSteps: ReadonlyArray<EditorStep>;
  readonly onChange: (next: EditorStep) => void;
  readonly onRemove: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
}

// Custom-day input bound — mirrors the previous Advanced-panel raw-offset
// bound's magnitude half (the sign is now a separate before/after toggle,
// so this is a 0..365 MAGNITUDE bound, not the old -365..365 signed one).
const OFFSET_MAX = 365;

function clampMagnitude(n: number): number {
  const truncated = Number.isFinite(n) ? Math.trunc(n) : 0;
  return Math.min(OFFSET_MAX, Math.max(0, truncated));
}

// Sentinel `<Select>` value for the "Custom…" option. Safe from collision
// with any real offset key — `offsetKeyFromDays` always produces `t-N`/
// `t+N` (see `reminder-offsets.ts`), never a bare word.
const CUSTOM_SENTINEL = 'custom';

/**
 * 122 US7b-2 (T736), boards `Admin-renewal-schedules` (+`-mobile`): the card on
 * AURA controls — `RadioGroup` for the channel and the custom direction,
 * `Select` for the timing and the assignee role, `NumberField` for custom
 * days, a `Combobox` with `allowCustomValue` for the task type, and
 * `IconButton`s to move and remove. The derived-identifier logic is unchanged.
 */
export function StepCard({
  tierBucket,
  step,
  index,
  total,
  readOnly,
  siblingSteps,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StepCardProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  // J1-B10 precedent (schedule-editor.tsx StepRow) — Base UI `Tabs.Panel`
  // keeps all 5 tier panels mounted via `hidden`, so every id here must
  // be namespaced per-tier-per-row or duplicate ids collide across the
  // 5 concurrently-mounted panels (WCAG 4.1.1).
  const idPrefix = `${tierBucket}-${index}`;
  // The timing heading names the card: each icon button is described by it,
  // so "Move up" says which step it moves (nine cards repeat the same three).
  const headingId = useId();
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const lastMove = useRef<'up' | 'down' | null>(null);
  // A step moved to either end disables the button just pressed; hand focus to
  // the other arrow so it never drops to the page (WCAG 2.4.3).
  useEffect(() => {
    const pressed = lastMove.current;
    lastMove.current = null;
    if (pressed === 'up' && index === 0) downRef.current?.focus();
    else if (pressed === 'down' && index === total - 1) upRef.current?.focus();
  }, [index, total]);

  // v3 Change 1 — has the admin explicitly opened the "Custom…" branch
  // this session? Needed because selecting "Custom…" does NOT itself
  // change `step.offset_days` (there's no day value yet), so without
  // this the Select's `value` (derived from `step.offset_days`) would
  // immediately snap back to the standard option on the next render.
  // Reset to `false` whenever a standard option is picked directly.
  const [customMode, setCustomMode] = useState(false);

  // Issue 3(b) — every OTHER step_id in this bucket (uniqueness per
  // `parseSchedulePolicySteps` is bucket-wide, not per-channel).
  const siblingStepIds = new Set(siblingSteps.map((s) => s.step_id));

  // Issue 2 — offsets already used by ANOTHER step of the SAME channel.
  // The natural collision key is (offset, channel) — see
  // `composeStepId`'s own doc comment ("two steps may share an offset
  // across channels").
  const usedOffsetsForChannel = new Set(
    siblingSteps.filter((s) => s.channel === step.channel).map((s) => s.offset_days),
  );

  const standardOffsetKeys = TIER_REMINDER_OFFSETS[tierBucket];
  const currentOffsetKey = offsetKeyFromDays(step.offset_days);
  const isCurrentStandard = (standardOffsetKeys as readonly string[]).includes(currentOffsetKey);

  // v3 Change 1 (load reflection) — a non-standard `step.offset_days`
  // (legacy data, or a value the admin previously set via Custom…) must
  // show "Custom…" selected + the day input pre-filled WITHOUT the
  // admin having to touch the Select — never silently snapped to the
  // nearest standard value.
  const showCustomTiming = customMode || !isCurrentStandard;
  const customDaysMagnitude = Math.abs(step.offset_days);
  const customBefore = step.offset_days < 0;

  function applyTiming(nextDays: number) {
    // `exactOptionalPropertyTypes` forbids passing `taskType: undefined`
    // explicitly — branch instead of ternary-into-undefined.
    const stepId =
      step.channel === 'task'
        ? composeUniqueStepId(
            { offsetDays: nextDays, channel: 'task', taskType: step.task_type ?? 'phone_call' },
            siblingStepIds,
          )
        : composeUniqueStepId({ offsetDays: nextDays, channel: 'email' }, siblingStepIds);
    const base: EditorStep = { ...step, offset_days: nextDays, step_id: stepId };
    onChange(
      step.channel === 'email'
        ? { ...base, template_id: composeTemplateId(nextDays, tierBucket) }
        : base,
    );
  }

  function handleTimingSelect(v: string) {
    if (v === CUSTOM_SENTINEL) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    applyTiming(daysFromOffsetKey(v));
  }

  // v3 Change 1 — the custom-day input + before/after toggle both funnel
  // through here, exactly like a standard `<Select>` option does via
  // `applyTiming` (same recompose path, same collision-safe composer).
  function applyCustomDays(magnitude: number, before: boolean) {
    applyTiming(before ? -magnitude : magnitude);
  }

  function handleChannelChange(nextChannel: EditorStep['channel']) {
    if (nextChannel === step.channel) return;
    if (nextChannel === 'email') {
      onChange({
        _uiKey: step._uiKey,
        step_id: composeUniqueStepId(
          { offsetDays: step.offset_days, channel: 'email' },
          siblingStepIds,
        ),
        offset_days: step.offset_days,
        channel: 'email',
        template_id: composeTemplateId(step.offset_days, tierBucket),
      });
    } else {
      const taskType = step.task_type ?? 'phone_call';
      onChange({
        _uiKey: step._uiKey,
        step_id: composeUniqueStepId(
          { offsetDays: step.offset_days, channel: 'task', taskType },
          siblingStepIds,
        ),
        offset_days: step.offset_days,
        channel: 'task',
        task_type: taskType,
        assignee_role: step.assignee_role ?? 'admin',
      });
    }
  }

  function handleTaskTypeChange(taskType: string) {
    onChange({
      ...step,
      task_type: taskType,
      // Offset-first — gateway's `deriveOffsetFromStepId` slices only the
      // FIRST dot-segment of `step_id`, so a multi-underscore taskType
      // (e.g. `quarterly_review_meeting`) never disturbs offset
      // resolution; the offset token is composed before the task type
      // regardless of its shape (see `composeStepId`).
      step_id: composeUniqueStepId(
        { offsetDays: step.offset_days, channel: 'task', taskType },
        siblingStepIds,
      ),
    });
  }

  // Known catalogue + load-reflection (no-data-loss): a `task_type` NOT in
  // `RENEWAL_KNOWN_TASK_TYPES` (bespoke/legacy data) is injected as its own
  // option so the combobox trigger displays it instead of falling back to
  // the placeholder — mirrors `address-section.tsx`'s `withCurrentValue`
  // pattern. `RENEWAL_KNOWN_TASK_TYPES` is a SUGGESTED list, not
  // authoritative (see `client.ts` doc comment) — `allowCustomValue` below
  // is the real no-data-loss guarantee; this injection only makes an
  // already-set bespoke value show as "selected" in the open list too.
  const taskTypeOptions: ComboboxOption[] = useMemo(() => {
    const known = RENEWAL_KNOWN_TASK_TYPES.map((v) => ({
      value: v,
      label: t(`stepCard.taskType.${v}`),
    }));
    const current = step.task_type;
    return current && !isKnownTaskType(current)
      ? [...known, { value: current, label: current }]
      : known;
  }, [t, step.task_type]);

  const timingValue = showCustomTiming ? CUSTOM_SENTINEL : currentOffsetKey;
  const timingOptions = [
    ...standardOffsetKeys.map((key) => {
      const days = daysFromOffsetKey(key);
      // The current step's own offset is NEVER disabled, even if a
      // pre-existing sibling duplicate shares it — only an OTHER step's use
      // of this offset blocks it.
      return {
        value: key,
        label: timingSentence(days, t),
        disabled: days !== step.offset_days && usedOffsetsForChannel.has(days),
      };
    }),
    // Never disabled: collisions among custom values are resolved by
    // `composeUniqueStepId` once a day is picked.
    { value: CUSTOM_SENTINEL, label: t('stepCard.timing.customOption') },
  ];

  return (
    <div className="flex flex-col gap-[var(--aura-space-3)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-[var(--aura-space-4)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--aura-space-2)]">
        {/* The timing in plain language, not "T-30". */}
        <h3 id={headingId} className="m-0 text-sm font-semibold text-[var(--aura-fg-primary)]">
          {timingSentence(step.offset_days, t)}
        </h3>
        <div className="flex items-center gap-[var(--aura-space-1)]">
          <IconButton
            ref={upRef}
            icon="arrow-up"
            label={t('actions.moveUp')}
            aria-describedby={headingId}
            touchHeight
            disabled={readOnly || index === 0}
            onClick={() => {
              lastMove.current = 'up';
              onMoveUp();
            }}
          />
          <IconButton
            ref={downRef}
            icon="arrow-down"
            label={t('actions.moveDown')}
            aria-describedby={headingId}
            touchHeight
            disabled={readOnly || index === total - 1}
            onClick={() => {
              lastMove.current = 'down';
              onMoveDown();
            }}
          />
          <IconButton
            icon="trash-2"
            tone="danger"
            label={t('actions.removeStep')}
            aria-describedby={headingId}
            touchHeight
            disabled={readOnly}
            onClick={onRemove}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[var(--aura-space-3)] sm:grid-cols-2 sm:items-start">
        <RadioGroup
          id={`channel-${idPrefix}`}
          label={t('stepCard.channelLabel')}
          orientation="horizontal"
          options={[
            { value: 'email', label: t('stepCard.channel.email') },
            { value: 'task', label: t('stepCard.channel.task') },
          ]}
          value={step.channel}
          disabled={readOnly}
          onChange={(v) => handleChannelChange(v as EditorStep['channel'])}
        />
        <Select
          id={`timing-${idPrefix}`}
          label={t('stepCard.timing.label')}
          value={timingValue}
          options={timingOptions}
          disabled={readOnly}
          onChange={(e) => handleTimingSelect(e.target.value)}
        />
      </div>

      {showCustomTiming ? (
        <div className="grid grid-cols-1 gap-[var(--aura-space-3)] sm:grid-cols-2 sm:items-start">
          <NumberField
            id={`custom-days-${idPrefix}`}
            label={t('stepCard.timing.customDaysLabel')}
            min={0}
            max={OFFSET_MAX}
            step={1}
            value={customDaysMagnitude}
            disabled={readOnly}
            onChange={(n) => applyCustomDays(clampMagnitude(n ?? 0), customBefore)}
          />
          <RadioGroup
            id={`direction-${idPrefix}`}
            label={t('stepCard.timing.direction.label')}
            orientation="horizontal"
            options={[
              { value: 'before', label: t('stepCard.timing.direction.before') },
              { value: 'after', label: t('stepCard.timing.direction.after') },
            ]}
            value={customBefore ? 'before' : 'after'}
            disabled={readOnly}
            onChange={(v) => applyCustomDays(customDaysMagnitude, v === 'before')}
          />
        </div>
      ) : null}

      {step.channel === 'email' ? (
        <EmailPreview tierBucket={tierBucket} offsetDays={step.offset_days} />
      ) : (
        <div className="grid grid-cols-1 gap-[var(--aura-space-3)] sm:grid-cols-2 sm:items-start">
          {/* The known catalogue is suggestions only: many more real task
              types exist, so a typed type is kept (`allowCustomValue`), and
              the hint says so. */}
          <Combobox
            id={`task-type-${idPrefix}`}
            label={t('stepCard.taskType.label')}
            hint={t('stepCard.taskType.hint')}
            options={taskTypeOptions}
            value={step.task_type ?? 'phone_call'}
            onChange={(v) => {
              if (v) handleTaskTypeChange(v);
            }}
            emptyText={t('stepCard.taskType.emptyMessage')}
            clearable={false}
            disabled={readOnly}
            allowCustomValue
          />
          <Select
            id={`assignee-${idPrefix}`}
            label={t('stepCard.assigneeLabel')}
            value={step.assignee_role ?? 'admin'}
            options={(['admin', 'manager', 'executive_director'] as const).map((role) => ({
              value: role,
              label: t(`stepCard.assigneeRole.${role}`),
            }))}
            disabled={readOnly}
            onChange={(e) =>
              onChange({
                ...step,
                assignee_role: e.target.value as Exclude<EditorStep['assignee_role'], undefined>,
              })
            }
          />
        </div>
      )}
    </div>
  );
}
