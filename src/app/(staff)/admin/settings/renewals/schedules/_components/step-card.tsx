'use client';

/**
 * F8 Phase 4 Wave I2/I3 · Task 8 — `StepCard`, the plain-language
 * replacement for `schedule-editor.tsx`'s raw `StepRow` (spec §5.2, §5.3,
 * §6.2). Same callback contract as `StepRow` — a drop-in the editor swaps
 * to in Task 9.
 *
 * Key idea: `step_id` and `template_id` are DERIVED values, not free
 * text. The wire grammar (`./step-id-composer`) requires the offset
 * token first in `step_id` (gateway's `deriveOffsetFromStepId` slices the
 * first dot-segment) and the tier last in `template_id` (gateway's
 * `deriveTierFromTemplateId` matches on `endsWith('.'+tier)`). Every
 * friendly-control change (timing, channel, task type) recomposes both
 * identifiers so an admin editing plain-language controls can never
 * produce a malformed wire shape. The Advanced disclosure is an escape
 * hatch for the rare bespoke identifier — editing there sets the raw
 * value directly and stays put until the next friendly-control change
 * recomposes over it (last control touched wins; same "controlled by
 * parent `step` prop" model the rest of the editor uses).
 */
import { useTranslations } from 'next-intl';
import { Mail, ListTodo, Minus, Plus, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { TierBucket } from '@/modules/renewals/client';
import type { ScheduleStepWire } from './schedule-editor';
import { composeStepId, composeTemplateId } from './step-id-composer';
import { EmailPreview } from './email-preview';
import { formatOffset } from './format-offset';

export interface StepCardProps {
  readonly tierBucket: TierBucket;
  readonly step: ScheduleStepWire;
  readonly index: number;
  readonly total: number;
  readonly readOnly: boolean;
  readonly onChange: (next: ScheduleStepWire) => void;
  readonly onRemove: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
}

// Mirrors the previous StepRow offset_days bound (-365..365); the
// stepper now edits the UNSIGNED magnitude, so the floor is 0.
const MAGNITUDE_MIN = 0;
const MAGNITUDE_MAX = 365;

const KNOWN_TASK_TYPES = ['phone_call', 'admin_notify'] as const;
type KnownTaskType = (typeof KNOWN_TASK_TYPES)[number];

function isKnownTaskType(v: string | undefined): v is KnownTaskType {
  return (KNOWN_TASK_TYPES as readonly string[]).includes(v ?? '');
}

function clampMagnitude(n: number): number {
  const truncated = Number.isFinite(n) ? Math.trunc(n) : 0;
  return Math.min(MAGNITUDE_MAX, Math.max(MAGNITUDE_MIN, truncated));
}

// Segmented-control segment shared styling. Base UI's `Radio.Root` (the
// actual `role="radio"` node) is visually hidden (`sr-only`) inside each
// label — the label itself is the visible "button". Its default
// focus-visible ring lives on the hidden node and would never be seen,
// so the ring instead goes on the wrapping label via `focus-within`.
// MUST stay full-opacity `ring-ring`/`border-ring` (never the `/50`
// utility `RadioGroupItem`'s own default style uses) — a half-opacity
// ring on a SELECTED (already-tinted `bg-primary`) segment drops well
// below the WCAG 2.1 SC 1.4.11 (non-text contrast) / 2.4.7 (focus
// visible) threshold.
// The actual `RadioGroupItem` (Base UI `Radio.Root`) is visually hidden
// inside each segment label (see `segmentClass` above). Its own default
// styling (`src/components/ui/radio-group.tsx`) includes a half-opacity
// `focus-visible:ring-ring/50` — invisible in practice once clipped by
// `sr-only`, but overridden here anyway (twMerge drops the `/50` variant
// in favour of the full-opacity one) so no `ring-ring/50` string
// survives in this file's rendered output at all, belt-and-suspenders
// with the label-level `focus-within` ring above.
const HIDDEN_RADIO_CLASS =
  'sr-only focus-visible:ring-ring focus-visible:border-ring';

function segmentClass(selected: boolean, disabled: boolean): string {
  return cn(
    'flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors',
    'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring',
    selected
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-input bg-transparent hover:bg-muted',
    disabled && 'cursor-not-allowed opacity-50',
  );
}

export function StepCard({
  tierBucket,
  step,
  index,
  total,
  readOnly,
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

  const magnitude = Math.abs(step.offset_days);
  const before = step.offset_days <= 0;

  function applyTiming(nextBefore: boolean, nextMagnitude: number) {
    const clamped = clampMagnitude(nextMagnitude);
    const nextDays = nextBefore ? -clamped : clamped;
    // `exactOptionalPropertyTypes` forbids passing `taskType: undefined`
    // explicitly (the composer's param type is `taskType?: string`, not
    // `string | undefined`) — branch instead of ternary-into-undefined.
    // `composeStepId` itself defaults a missing task taskType to
    // 'phone_call', so defaulting here first is behaviourally identical.
    const stepId =
      step.channel === 'task'
        ? composeStepId({
            offsetDays: nextDays,
            channel: 'task',
            taskType: step.task_type ?? 'phone_call',
          })
        : composeStepId({ offsetDays: nextDays, channel: 'email' });
    const base: ScheduleStepWire = { ...step, offset_days: nextDays, step_id: stepId };
    onChange(
      step.channel === 'email'
        ? { ...base, template_id: composeTemplateId(nextDays, tierBucket) }
        : base,
    );
  }

  function handleChannelChange(nextChannel: ScheduleStepWire['channel']) {
    if (nextChannel === step.channel) return;
    if (nextChannel === 'email') {
      onChange({
        step_id: composeStepId({ offsetDays: step.offset_days, channel: 'email' }),
        offset_days: step.offset_days,
        channel: 'email',
        template_id: composeTemplateId(step.offset_days, tierBucket),
      });
    } else {
      const taskType = step.task_type ?? 'phone_call';
      onChange({
        step_id: composeStepId({
          offsetDays: step.offset_days,
          channel: 'task',
          taskType,
        }),
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
      step_id: composeStepId({
        offsetDays: step.offset_days,
        channel: 'task',
        taskType,
      }),
    });
  }

  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Header sentence — reuses the shared offset-sentence formatter
            (existing `stepCard.offsetDay.before/after/exact` ICU keys)
            rather than concatenating separate translated fragments. */}
        <Badge variant="outline" className="font-mono">
          {formatOffset(step.offset_days, t)}
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
              handleChannelChange(v as ScheduleStepWire['channel'])
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

        {/* Timing — N-day stepper + separately-labelled before/after. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`timing-days-${idPrefix}`}>
              {t('stepCard.timing.daysLabel')}
            </Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                disabled={readOnly || magnitude <= MAGNITUDE_MIN}
                onClick={() => applyTiming(before, magnitude - 1)}
                aria-label={t('stepCard.timing.decreaseDays')}
              >
                <Minus aria-hidden="true" className="h-4 w-4" />
              </Button>
              <Input
                id={`timing-days-${idPrefix}`}
                type="number"
                inputMode="numeric"
                min={MAGNITUDE_MIN}
                max={MAGNITUDE_MAX}
                step={1}
                value={magnitude}
                disabled={readOnly}
                className="text-center"
                onChange={(e) => applyTiming(before, Number(e.target.value))}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 shrink-0"
                disabled={readOnly || magnitude >= MAGNITUDE_MAX}
                onClick={() => applyTiming(before, magnitude + 1)}
                aria-label={t('stepCard.timing.increaseDays')}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div>
            <Label id={`timing-baf-label-${idPrefix}`}>
              {t('stepCard.timing.beforeAfterLabel')}
            </Label>
            <RadioGroup
              aria-labelledby={`timing-baf-label-${idPrefix}`}
              value={before ? 'before' : 'after'}
              disabled={readOnly}
              onValueChange={(v) => applyTiming(v === 'before', magnitude)}
              className="grid-cols-2 gap-2"
            >
              {(['before', 'after'] as const).map((dir) => {
                const selected = (dir === 'before') === before;
                const segId = `timing-dir-${idPrefix}-${dir}`;
                return (
                  <label
                    key={dir}
                    htmlFor={segId}
                    className={cn(segmentClass(selected, readOnly), 'capitalize')}
                  >
                    <RadioGroupItem id={segId} value={dir} className={HIDDEN_RADIO_CLASS} />
                    {t(`stepCard.timing.${dir}`)}
                  </label>
                );
              })}
            </RadioGroup>
          </div>
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
                      may hold a bespoke value set via the Advanced panel —
                      show it verbatim rather than throwing MISSING_MESSAGE. */}
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
                      ScheduleStepWire['assignee_role'],
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

        {/* Advanced — raw step_id/template_id escape hatch. Editing here
            sets the value directly; the next friendly-control change
            (timing/channel/task type) recomposes over it. */}
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit text-muted-foreground"
              />
            }
          >
            {t('stepCard.advanced.toggle')}
          </CollapsibleTrigger>
          <CollapsibleContent
            keepMounted
            className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor={`adv-step-id-${idPrefix}`}>
                {t('stepCard.advanced.stepIdLabel')}
              </Label>
              <Input
                id={`adv-step-id-${idPrefix}`}
                value={step.step_id}
                disabled={readOnly}
                maxLength={100}
                onChange={(e) => onChange({ ...step, step_id: e.target.value })}
              />
            </div>
            {step.channel === 'email' ? (
              <div>
                <Label htmlFor={`adv-template-id-${idPrefix}`}>
                  {t('stepCard.advanced.templateIdLabel')}
                </Label>
                <Input
                  id={`adv-template-id-${idPrefix}`}
                  value={step.template_id ?? ''}
                  disabled={readOnly}
                  maxLength={200}
                  onChange={(e) =>
                    onChange({ ...step, template_id: e.target.value })
                  }
                />
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
