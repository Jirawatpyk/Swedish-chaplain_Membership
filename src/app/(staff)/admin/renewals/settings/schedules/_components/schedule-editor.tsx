'use client';

/**
 * F8 Phase 4 Wave I1b · T087 — Schedule editor client component.
 *
 * 5 tabs (one per tier_bucket); per-bucket step list with:
 *   - Add / Remove step
 *   - Move-up / Move-down reorder buttons (keyboard-first, WCAG 2.1 AA)
 *     instead of drag-drop — more accessible for screen readers and
 *     avoids adding a dnd dependency. Functional equivalent of
 *     "drag-reorder" per tasks.md T087 + matches docs/ux-standards.md
 *     keyboard-first principle.
 *   - Inline edit of step_id / offset_days / channel / template_id /
 *     task_type / assignee_role
 *   - Save → PUT /api/admin/renewals/settings/schedules/[tierBucket]
 *     → toast feedback with change diff (FR-058 audit-toast contract).
 *
 * Manager-role detection: `readOnly` prop renders all controls disabled
 * + a banner-style notice. Server-side RBAC at the PUT route is the
 * canonical gate — this UI affordance is defence-in-depth.
 */
import { useCallback, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  AlertCircle,
} from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import { TIER_BUCKETS, type TierBucket } from '@/modules/renewals/client';

// ---------------------------------------------------------------------------
// Wire-shape types — match the route-handler JSON contract.
// ---------------------------------------------------------------------------

export interface ScheduleStepWire {
  step_id: string;
  offset_days: number;
  channel: 'email' | 'task';
  template_id?: string;
  task_type?: string;
  assignee_role?: 'admin' | 'manager' | 'executive_director';
}

export interface SchedulePolicyWire {
  tier_bucket: TierBucket;
  steps: ReadonlyArray<ScheduleStepWire>;
  updated_at: string;
}

export interface ScheduleEditorProps {
  readonly initialPolicies: ReadonlyArray<SchedulePolicyWire>;
  readonly readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyStep(): ScheduleStepWire {
  return {
    step_id: 'new-step',
    offset_days: -30,
    channel: 'email',
    template_id: 'renewal.t-30',
  };
}

function policiesByBucket(
  policies: ReadonlyArray<SchedulePolicyWire>,
): Record<TierBucket, SchedulePolicyWire | undefined> {
  const out: Partial<Record<TierBucket, SchedulePolicyWire>> = {};
  for (const p of policies) {
    out[p.tier_bucket] = p;
  }
  return out as Record<TierBucket, SchedulePolicyWire | undefined>;
}

function formatOffset(
  days: number,
  t: ReturnType<typeof useTranslations<'admin.renewals.settings.schedules'>>,
): string {
  if (days === 0) return t('stepCard.offsetDay.exact');
  if (days < 0)
    return t('stepCard.offsetDay.before', { days: Math.abs(days) });
  return t('stepCard.offsetDay.after', { days });
}

// ---------------------------------------------------------------------------
// Per-step row sub-component
// ---------------------------------------------------------------------------

interface StepRowProps {
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

function StepRow({
  tierBucket,
  step,
  index,
  total,
  readOnly,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StepRowProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  // J1-B10: prefix every form-field id with `tierBucket` because base-ui
  // `Tabs.Panel` keeps inactive panels mounted via `hidden`. Without the
  // prefix the same `step-id-0` exists 5 times in the DOM and
  // `<Label htmlFor>` resolves to the wrong field on 4 of 5 tabs
  // (WCAG 4.1.1 Parsing — duplicate id attributes).
  const idPrefix = `${tierBucket}-${index}`;
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline" className="font-mono">
          {formatOffset(step.offset_days, t)} ·{' '}
          {t(`stepCard.channel.${step.channel}`)}
        </Badge>
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
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`step-id-${idPrefix}`}>{t('stepCard.stepIdLabel')}</Label>
          <Input
            id={`step-id-${idPrefix}`}
            value={step.step_id}
            disabled={readOnly}
            onChange={(e) => onChange({ ...step, step_id: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor={`offset-days-${idPrefix}`}>
            {t('stepCard.offsetDay.before', { days: 30 }).slice(0, 1)}±
          </Label>
          <Input
            id={`offset-days-${idPrefix}`}
            type="number"
            value={step.offset_days}
            disabled={readOnly}
            onChange={(e) =>
              onChange({ ...step, offset_days: Number(e.target.value) })
            }
          />
        </div>
        <div>
          <Label htmlFor={`channel-${idPrefix}`}>
            {t('stepCard.channel.email')} / {t('stepCard.channel.task')}
          </Label>
          <Select
            value={step.channel}
            disabled={readOnly}
            onValueChange={(v) => {
              const nextChannel = v as ScheduleStepWire['channel'];
              if (nextChannel === 'email') {
                onChange({
                  step_id: step.step_id,
                  offset_days: step.offset_days,
                  channel: 'email',
                  template_id: step.template_id ?? 'renewal.placeholder',
                });
              } else {
                onChange({
                  step_id: step.step_id,
                  offset_days: step.offset_days,
                  channel: 'task',
                  task_type: step.task_type ?? 'phone_call',
                  assignee_role: step.assignee_role ?? 'admin',
                });
              }
            }}
          >
            <SelectTrigger id={`channel-${idPrefix}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">
                {t('stepCard.channel.email')}
              </SelectItem>
              <SelectItem value="task">
                {t('stepCard.channel.task')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {step.channel === 'email' ? (
          <div>
            <Label htmlFor={`template-${idPrefix}`}>
              {t('stepCard.templateIdLabel')}
            </Label>
            <Input
              id={`template-${idPrefix}`}
              value={step.template_id ?? ''}
              disabled={readOnly}
              onChange={(e) =>
                onChange({ ...step, template_id: e.target.value })
              }
            />
          </div>
        ) : (
          <>
            <div>
              <Label htmlFor={`task-type-${idPrefix}`}>
                {t('stepCard.taskTypeLabel')}
              </Label>
              <Input
                id={`task-type-${idPrefix}`}
                value={step.task_type ?? ''}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({ ...step, task_type: e.target.value })
                }
              />
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
                <SelectTrigger id={`assignee-${idPrefix}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="manager">manager</SelectItem>
                  <SelectItem value="executive_director">
                    executive_director
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main editor — orchestrates 5 tabs
// ---------------------------------------------------------------------------

export function ScheduleEditor({
  initialPolicies,
  readOnly,
}: ScheduleEditorProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  // J1-B8: locale-aware date formatter (next-intl) replaces raw
  // `toLocaleString()` which leaks browser default locale and never
  // surfaces Buddhist Era for `th-TH` users.
  const fmt = useFormatter();
  const [byBucket, setByBucket] = useState(() => policiesByBucket(initialPolicies));
  const [activeBucket, setActiveBucket] = useState<TierBucket>(
    TIER_BUCKETS[0],
  );
  const [pending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  const stepsFor = useCallback(
    (b: TierBucket): ScheduleStepWire[] => {
      const policy = byBucket[b];
      return policy ? [...policy.steps] : [];
    },
    [byBucket],
  );

  const replaceSteps = useCallback(
    (b: TierBucket, next: ScheduleStepWire[]) => {
      setByBucket((prev) => {
        const existing = prev[b];
        const updated: SchedulePolicyWire = {
          tier_bucket: b,
          steps: next,
          updated_at: existing?.updated_at ?? '',
        };
        return { ...prev, [b]: updated };
      });
    },
    [],
  );

  const handleSave = useCallback(
    (b: TierBucket) => {
      setSaveError(null);
      const stepsNow = stepsFor(b);
      startTransition(async () => {
        try {
          const res = await fetch(
            `/api/admin/renewals/settings/schedules/${b}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ steps: stepsNow }),
            },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as
              | { error?: string }
              | null;
            setSaveError(
              body?.error === 'invalid_steps'
                ? t('error.invalidSteps')
                : t('error.saveFailed'),
            );
            toast.error(t('error.saveFailed'));
            return;
          }
          const body = (await res.json()) as {
            change_diff: {
              added: string[];
              removed: string[];
              unchanged: string[];
            };
            updated_at: string;
          };
          // Refresh local cache with server-confirmed policy.
          setByBucket((prev) => ({
            ...prev,
            [b]: {
              tier_bucket: b,
              steps: stepsNow,
              updated_at: body.updated_at,
            },
          }));
          toast.success(
            t('saved.toast', {
              tier: t(`tabs.${b}`),
              added: body.change_diff.added.length,
              removed: body.change_diff.removed.length,
              unchanged: body.change_diff.unchanged.length,
            }),
          );
        } catch {
          setSaveError(t('error.saveFailed'));
          toast.error(t('error.saveFailed'));
        }
      });
    },
    [stepsFor, t],
  );

  return (
    <Tabs
      value={activeBucket}
      onValueChange={(v) => setActiveBucket(v as TierBucket)}
    >
      <TabsList className="flex-wrap">
        {TIER_BUCKETS.map((b) => (
          <TabsTrigger key={b} value={b}>
            {t(`tabs.${b}`)}
          </TabsTrigger>
        ))}
      </TabsList>

      {readOnly ? (
        <Card className="mt-3 border-amber-300 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 py-3 text-sm"
          >
            <AlertCircle aria-hidden="true" className="h-4 w-4 text-amber-700 dark:text-amber-500" />
            {t('manager.readOnlyNotice')}
          </CardContent>
        </Card>
      ) : null}

      {TIER_BUCKETS.map((b) => {
        const steps = stepsFor(b);
        const lastSavedAt = byBucket[b]?.updated_at;
        return (
          <TabsContent key={b} value={b} className="mt-4">
            <div className="flex flex-col gap-4">
              {steps.length === 0 ? (
                <Card>
                  <CardContent
                    role="status"
                    className="py-8 text-center text-muted-foreground"
                  >
                    {t('error.noPolicies')}
                  </CardContent>
                </Card>
              ) : null}
              {steps.map((step, idx) => (
                <StepRow
                  key={`${b}-${idx}`}
                  tierBucket={b}
                  step={step}
                  index={idx}
                  total={steps.length}
                  readOnly={readOnly}
                  onChange={(next) => {
                    const arr = [...steps];
                    arr[idx] = next;
                    replaceSteps(b, arr);
                  }}
                  onRemove={() => {
                    const arr = [...steps];
                    arr.splice(idx, 1);
                    replaceSteps(b, arr);
                  }}
                  onMoveUp={() => {
                    if (idx === 0) return;
                    const arr = [...steps];
                    const prev = arr[idx - 1]!;
                    const cur = arr[idx]!;
                    arr[idx - 1] = cur;
                    arr[idx] = prev;
                    replaceSteps(b, arr);
                  }}
                  onMoveDown={() => {
                    if (idx === steps.length - 1) return;
                    const arr = [...steps];
                    const cur = arr[idx]!;
                    const nxt = arr[idx + 1]!;
                    arr[idx] = nxt;
                    arr[idx + 1] = cur;
                    replaceSteps(b, arr);
                  }}
                />
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col text-xs text-muted-foreground">
                  <span aria-live="polite">
                    {t('stepCount', { count: steps.length })}
                  </span>
                  {lastSavedAt ? (
                    <span>
                      {t('lastSaved', {
                        date: fmt.dateTime(new Date(lastSavedAt), {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        }),
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={readOnly || pending}
                    onClick={() => replaceSteps(b, [...steps, emptyStep()])}
                  >
                    <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
                    {t('actions.addStep')}
                  </Button>
                  <Button
                    type="button"
                    disabled={readOnly || pending || steps.length === 0}
                    onClick={() => handleSave(b)}
                  >
                    {pending ? t('actions.saving') : t('actions.save')}
                  </Button>
                </div>
              </div>
              {saveError ? (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="text-sm text-destructive"
                >
                  {saveError}
                </div>
              ) : null}
            </div>
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
