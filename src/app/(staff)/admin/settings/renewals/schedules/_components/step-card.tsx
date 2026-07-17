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
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Mail, ListTodo, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import {
  TIER_REMINDER_OFFSETS,
  offsetKeyFromDays,
  daysFromOffsetKey,
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

const KNOWN_TASK_TYPES = ['phone_call', 'admin_notify'] as const;
type KnownTaskType = (typeof KNOWN_TASK_TYPES)[number];

function isKnownTaskType(v: string | undefined): v is KnownTaskType {
  return (KNOWN_TASK_TYPES as readonly string[]).includes(v ?? '');
}

// Segmented-control segment shared styling.
function segmentClass(selected: boolean, disabled: boolean): string {
  return cn(
    'relative flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors',
    'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring',
    selected
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-input bg-transparent hover:bg-muted',
    disabled && 'cursor-not-allowed opacity-50',
  );
}

// v2 rework Issue 1 (confirmed alignment bug) — the previous
// `'sr-only focus-visible:ring-ring focus-visible:border-ring'` did NOT
// collapse the hidden `RadioGroupItem` out of flow. `sr-only` and the
// base `RadioGroupItem` classes (`relative flex size-4 shrink-0
// rounded-full border ...`) belong to DIFFERENT twMerge class groups
// (`sr-only` is its own group — not the `position`/`size` groups), so
// twMerge keeps BOTH class sets. Tailwind's generated stylesheet then
// happens to order `.relative { position: relative }` AFTER
// `.sr-only`'s `position: absolute`, so `position: relative` wins the
// cascade and the "hidden" radio stayed a 16px in-flow box — shoving
// the centred icon+label ~10-13px right inside each segment.
//
// Fix: make the radio a full-bleed, absolutely-positioned, fully
// transparent OVERLAY instead. It covers the whole segment `<label>`
// (which needs its own `relative` — see `segmentClass` above) so it
// stays clickable/keyboard-focusable everywhere in the segment,
// contributes ZERO layout box of its own, and the segment's flex
// content (icon+label) is genuinely centred. The focus ring lives on
// the wrapping `<label>` via `focus-within:ring-2 focus-within:ring-ring
// focus-within:border-ring` (full-opacity — WCAG 2.1 SC 1.4.11 non-text
// contrast / SC 2.4.7 focus visible; never the half-opacity
// `ring-ring/50` the base `RadioGroupItem` style uses).
const HIDDEN_RADIO_CLASS = 'absolute inset-0 size-full cursor-pointer opacity-0';

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
      step_id: composeUniqueStepId(
        { offsetDays: step.offset_days, channel: 'task', taskType },
        siblingStepIds,
      ),
    });
  }

  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Header sentence — v2 rework Issue 4: plain language, not the
            cryptic "T-30" form. */}
        <Badge variant="outline" className="font-normal">
          {timingSentence(step.offset_days, t)}
        </Badge>
        {/* Reorder/remove block — verbatim from schedule-editor.tsx's
            StepRow (lines ~184-215): same aria-labels, same disabled
            rules (readOnly OR at either end of the list). */}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={readOnly || index === 0}
            onClick={onMoveUp}
            aria-label={t('actions.moveUp')}
          >
            <ChevronUp aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={readOnly || index === total - 1}
            onClick={onMoveDown}
            aria-label={t('actions.moveDown')}
          >
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={readOnly}
            onClick={onRemove}
            aria-label={t('actions.removeStep')}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-4">
        {/* Channel — segmented control (Email / Task). */}
        <div>
          <Label id={`channel-group-label-${idPrefix}`}>
            {t('stepCard.channelLabel')}
          </Label>
          <RadioGroup
            aria-labelledby={`channel-group-label-${idPrefix}`}
            value={step.channel}
            disabled={readOnly}
            onValueChange={(v) =>
              handleChannelChange(v as EditorStep['channel'])
            }
            className="grid-cols-2 gap-2"
          >
            {(['email', 'task'] as const).map((ch) => {
              const selected = step.channel === ch;
              const segId = `channel-${idPrefix}-${ch}`;
              const Icon = ch === 'email' ? Mail : ListTodo;
              return (
                <label
                  key={ch}
                  htmlFor={segId}
                  className={segmentClass(selected, readOnly)}
                >
                  <RadioGroupItem id={segId} value={ch} className={HIDDEN_RADIO_CLASS} />
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {t(`stepCard.channel.${ch}`)}
                </label>
              );
            })}
          </RadioGroup>
        </div>

        {/* Timing — v2 rework Issue 2: ONE plain-language "Send timing"
            dropdown of the tier's standard reminder points, replacing
            the day-stepper + separate Before/After toggle. v3 rework
            Change 1: a "Custom…" option at the end reveals a numeric
            day input + before/after toggle for an arbitrary offset. */}
        <div>
          <Label htmlFor={`timing-${idPrefix}`}>{t('stepCard.timing.label')}</Label>
          <Select
            value={showCustomTiming ? CUSTOM_SENTINEL : currentOffsetKey}
            disabled={readOnly}
            onValueChange={(v) => handleTimingSelect(v as string)}
          >
            <SelectTrigger id={`timing-${idPrefix}`} className="w-full">
              <TranslatedSelectValue
                placeholder={t('stepCard.timing.label')}
                translate={(v) => {
                  if (!v) return null;
                  if (v === CUSTOM_SENTINEL) return t('stepCard.timing.customOption');
                  return timingSentence(daysFromOffsetKey(v), t);
                }}
              />
            </SelectTrigger>
            <SelectContent>
              {standardOffsetKeys.map((key) => {
                const days = daysFromOffsetKey(key);
                // The current step's own offset is NEVER disabled, even
                // if a pre-existing sibling duplicate happens to share
                // it (a legacy/collision edge case) — only an OTHER
                // step's use of this offset blocks selection.
                const disabled = days !== step.offset_days && usedOffsetsForChannel.has(days);
                return (
                  <SelectItem key={key} value={key} disabled={disabled}>
                    {timingSentence(days, t)}
                  </SelectItem>
                );
              })}
              {/* v3 Change 1 — ONE more option at the end. Never
                  disabled: an arbitrary custom offset can't collide the
                  way a standard one can (collisions among custom values
                  are resolved by `composeUniqueStepId` once the admin
                  picks a day). */}
              <SelectItem value={CUSTOM_SENTINEL}>
                {t('stepCard.timing.customOption')}
              </SelectItem>
            </SelectContent>
          </Select>

          {showCustomTiming ? (
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`custom-days-${idPrefix}`}>
                  {t('stepCard.timing.customDaysLabel')}
                </Label>
                <Input
                  id={`custom-days-${idPrefix}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={OFFSET_MAX}
                  step={1}
                  value={customDaysMagnitude}
                  disabled={readOnly}
                  onChange={(e) =>
                    applyCustomDays(clampMagnitude(Number(e.target.value)), customBefore)
                  }
                />
              </div>
              <div>
                <Label id={`direction-group-label-${idPrefix}`}>
                  {t('stepCard.timing.direction.label')}
                </Label>
                <RadioGroup
                  aria-labelledby={`direction-group-label-${idPrefix}`}
                  value={customBefore ? 'before' : 'after'}
                  disabled={readOnly}
                  onValueChange={(v) => applyCustomDays(customDaysMagnitude, v === 'before')}
                  className="grid-cols-2 gap-2"
                >
                  {(['before', 'after'] as const).map((dir) => {
                    const selected = customBefore === (dir === 'before');
                    const segId = `direction-${idPrefix}-${dir}`;
                    return (
                      <label
                        key={dir}
                        htmlFor={segId}
                        className={segmentClass(selected, readOnly)}
                      >
                        <RadioGroupItem id={segId} value={dir} className={HIDDEN_RADIO_CLASS} />
                        {t(`stepCard.timing.direction.${dir}`)}
                      </label>
                    );
                  })}
                </RadioGroup>
              </div>
            </div>
          ) : null}
        </div>

        {/* Channel-specific fields. */}
        {step.channel === 'email' ? (
          <EmailPreview tierBucket={tierBucket} offsetDays={step.offset_days} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`task-type-${idPrefix}`}>
                {t('stepCard.taskType.label')}
              </Label>
              <Select
                value={step.task_type ?? 'phone_call'}
                disabled={readOnly}
                onValueChange={(v) => handleTaskTypeChange(v as string)}
              >
                <SelectTrigger id={`task-type-${idPrefix}`} className="w-full">
                  {/* Fallback-to-raw-value pattern (Round 5 SUG-6, mirrored
                      from StepRow's channel/assignee selects): the friendly
                      list only offers the 2 known types, but `task_type`
                      may hold a bespoke value (e.g. legacy data) — show it
                      verbatim rather than throwing MISSING_MESSAGE. */}
                  <TranslatedSelectValue
                    placeholder={t('stepCard.taskType.label')}
                    translate={(v) => {
                      if (!v) return null;
                      if (isKnownTaskType(v)) return t(`stepCard.taskType.${v}`);
                      return v;
                    }}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="phone_call">
                    {t('stepCard.taskType.phone_call')}
                  </SelectItem>
                  <SelectItem value="admin_notify">
                    {t('stepCard.taskType.admin_notify')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor={`assignee-${idPrefix}`}>
                {t('stepCard.assigneeLabel')}
              </Label>
              <Select
                value={step.assignee_role ?? 'admin'}
                disabled={readOnly}
                onValueChange={(v) =>
                  onChange({
                    ...step,
                    assignee_role: v as Exclude<
                      EditorStep['assignee_role'],
                      undefined
                    >,
                  })
                }
              >
                <SelectTrigger id={`assignee-${idPrefix}`} className="w-full">
                  <TranslatedSelectValue
                    placeholder={t('stepCard.assigneeLabel')}
                    translate={(v) => {
                      if (!v) return null;
                      try {
                        return t(
                          `stepCard.assigneeRole.${v}` as 'stepCard.assigneeRole.admin',
                        );
                      } catch {
                        return v;
                      }
                    }}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">
                    {t('stepCard.assigneeRole.admin')}
                  </SelectItem>
                  <SelectItem value="manager">
                    {t('stepCard.assigneeRole.manager')}
                  </SelectItem>
                  <SelectItem value="executive_director">
                    {t('stepCard.assigneeRole.executive_director')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
