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
  CalendarPlus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shell/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
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

/**
 * K16-2 (R14-S7) — offline detection helper.
 *
 * Extracted from the schedule-save catch block so the K14-8 3-browser
 * regex coverage can be unit-tested without mounting the full editor.
 * Exported for `tests/unit/components/schedules/schedule-editor.test.ts`.
 *
 * Browser → `e.message` mapping:
 *   - Chrome:  `TypeError: Failed to fetch`         → `/fetch/i`
 *   - Firefox: `TypeError: NetworkError when…`      → `/network/i`
 *   - Safari:  `TypeError: Load failed`             → `/load failed/i`
 *
 * Returns `true` only when ALL of:
 *   1. `e instanceof TypeError` — non-TypeError throws (e.g. AbortError,
 *      DOMException, server-thrown SyntaxError) are NOT offline.
 *   2. The message matches one of the 3 browser patterns. Other
 *      TypeErrors (e.g. `TypeError: prop is undefined`) are NOT
 *      offline — those represent code bugs, not network failure.
 */
export function isOfflineFetchError(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false;
  const msg = e.message;
  return (
    /fetch/i.test(msg) ||
    /network/i.test(msg) ||
    /load failed/i.test(msg)
  );
}

function emptyStep(): ScheduleStepWire {
  // J8-M33: random suffix so multiple "Add step" clicks within one
  // session produce unique step_ids — server zod's distinct-step_ids
  // invariant otherwise rejects the save with `invalid_steps` 422.
  // 8-hex chars from a v4 UUID gives 16M possibilities, plenty for the
  // 20-step cap on a single bucket.
  return {
    step_id: `new-${crypto.randomUUID().slice(0, 8)}`,
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
        {/*
         * J7-H17: required + aria-required on text inputs so the
         * server's `invalid_steps` 422 has a matching client-side
         * cue (HTML5 invalid pseudo-class fires too). Empty step_id
         * fails the wire-level zod (.min(1)) anyway — the attr
         * stops admin from submitting before the round-trip.
         */}
        <div>
          <Label htmlFor={`step-id-${idPrefix}`}>{t('stepCard.stepIdLabel')}</Label>
          <Input
            id={`step-id-${idPrefix}`}
            value={step.step_id}
            disabled={readOnly}
            required
            aria-required="true"
            maxLength={100}
            onChange={(e) => onChange({ ...step, step_id: e.target.value })}
          />
        </div>
        <div>
          {/*
           * J8-M19: replaced the legacy `T±` mangled label
           * (.slice(0,1)+'±' built from "T-30") with a proper
           * localized i18n key. Previous code rendered "T±" in EN
           * and the same mangled string in TH/SV — admin had no
           * idea what the offset_days field was for.
           */}
          <Label htmlFor={`offset-days-${idPrefix}`}>
            {t('stepCard.offsetDaysLabel')}
          </Label>
          <Input
            id={`offset-days-${idPrefix}`}
            type="number"
            value={step.offset_days}
            disabled={readOnly}
            required
            aria-required="true"
            min={-365}
            max={365}
            step={1}
            onChange={(e) =>
              onChange({ ...step, offset_days: Number(e.target.value) })
            }
          />
        </div>
        <div>
          {/*
            K3-BLK-1: previously the rendered label was
            `"Email / Task"` — those are option VALUES, not the field's
            name. Screen-reader users heard "Email / Task, combobox"
            without a clue what the field controls (WCAG 4.1.2
            Name/Role/Value). Now uses a dedicated `channelLabel` i18n
            key that names the field ("Delivery channel" / "ช่องทางการ
            ส่ง" / "Leveranskanal"); the option values render inside
            the SelectContent below where they belong.
          */}
          <Label htmlFor={`channel-${idPrefix}`}>
            {t('stepCard.channelLabel')}
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
            <SelectTrigger id={`channel-${idPrefix}`} className="w-full">
              {/* Base UI's `<SelectValue />` renders the raw value string
                  ("email" / "task") not the translated children of the
                  selected `<SelectItem>` — so the trigger looked
                  un-translated AND truncated. `<TranslatedSelectValue>`
                  passes the raw value through `t()` to render the same
                  label as the dropdown items. `w-full` on the trigger
                  makes it span the form column so the translated label
                  isn't clipped (line-clamp-1 was hiding longer locales). */}
              <TranslatedSelectValue
                placeholder={t('stepCard.channelLabel')}
                translate={(v) => {
                  if (!v) return null;
                  // Round 5 SUG-6 — try/catch shields the runtime from
                  // a `MISSING_MESSAGE` throw if a future channel enum
                  // value (e.g. 'sms') ships before the i18n keys do.
                  // Falls back to the raw enum literal — visible-but-
                  // ugly is better than blank-trigger or 500-page.
                  try {
                    return t(`stepCard.channel.${v}` as 'stepCard.channel.email');
                  } catch {
                    return v;
                  }
                }}
              />
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
            {/* J7-H17: email steps require a template_id (server zod
             * enforces .min(1) when channel='email'); mirror the rule
             * client-side via required+aria-required. */}
            <Input
              id={`template-${idPrefix}`}
              value={step.template_id ?? ''}
              disabled={readOnly}
              required
              aria-required="true"
              maxLength={200}
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
              {/* J7-H17: task steps require task_type (server zod
               * enforces .min(1) when channel='task'). */}
              <Input
                id={`task-type-${idPrefix}`}
                value={step.task_type ?? ''}
                disabled={readOnly}
                required
                aria-required="true"
                maxLength={100}
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
                <SelectTrigger id={`assignee-${idPrefix}`} className="w-full">
                  {/* Same un-translated-trigger fix as the channel
                      Select above — Base UI's `<SelectValue />` renders
                      the raw enum literal. */}
                  <TranslatedSelectValue
                    placeholder={t('stepCard.assigneeLabel')}
                    translate={(v) => {
                      if (!v) return null;
                      // Round 5 SUG-6 — same MISSING_MESSAGE shield as
                      // the channel select above.
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
                  {/*
                   * J8-M20: previously rendered raw enum values
                   * ("admin"/"manager"/"executive_director"). TH+SV
                   * admins saw English-only role names — break of
                   * ux-standards § i18n no-hardcoded-strings rule.
                   */}
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
            // K1-E6: route returns `{error: {code: '...'}, correlationId}`
            // (per `errorResponse` in renewals-route-helpers). Previously
            // `body?.error === 'invalid_steps'` always evaluated false
            // because `body.error` is an OBJECT, not a bare string —
            // every save failure showed the generic "save failed" toast.
            // Now read `body.error.code` to match the actual envelope.
            const body = (await res.json().catch(() => null)) as
              | { error?: { code?: string } }
              | null;
            setSaveError(
              body?.error?.code === 'invalid_steps'
                ? t('error.invalidSteps')
                : t('error.saveFailed'),
            );
            toast.error(t('error.saveFailed'));
            return;
          }
          // K1-E6: `res.json()` here previously had NO `.catch`. A 200
          // with malformed body (e.g. Vercel edge HTML error page)
          // would throw SyntaxError that landed in the empty
          // `catch {}` below — the user saw "save failed" while the
          // server actually persisted the change, leading to duplicate
          // saves on retry + double `renewal_schedule_policy_updated`
          // audit entries. Wrap in `.catch` so a malformed-body case
          // surfaces explicitly (no silent rollback of UI state).
          const body = (await res.json().catch(() => null)) as {
            change_diff?: {
              added?: string[];
              removed?: string[];
              unchanged?: string[];
            };
            updated_at?: string;
          } | null;
          if (
            !body ||
            !body.change_diff ||
            typeof body.updated_at !== 'string'
          ) {
            // K1-E6: Treat malformed-but-OK response as an error toast.
            // The save MAY have succeeded server-side; surface honestly
            // rather than silently flipping local state to "saved".
             
            console.error(
              '[F8] schedule save: malformed success body',
              body,
            );
            setSaveError(t('error.saveFailed'));
            toast.error(t('error.saveFailed'));
            return;
          }
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
              added: body.change_diff.added?.length ?? 0,
              removed: body.change_diff.removed?.length ?? 0,
              unchanged: body.change_diff.unchanged?.length ?? 0,
            }),
          );
        } catch (e) {
          // K1-E6: previously `catch {}` collapsed every cause
          // (network, JSON parse, DOM exception) to "save failed".
          // Log for diagnosability while keeping a user-facing toast.
          //
          // K13-8 (UX-K-2): differentiate offline (TypeError from a
          // failed fetch — typical browser message "Failed to fetch"
          // or "NetworkError" depending on browser) from server-error
          // / JSON-parse / DOM exceptions. ux-standards § 4.4 prefers
          // context-specific copy over a generic "save failed" so the
          // admin's recovery action is obvious ("check connection" vs
          // "contact support").

          console.error('[F8] schedule save: client handler failed', e);
          // K16-2 (R14-S7): extracted to `isOfflineFetchError` helper
          // (exported for direct unit testing). Pre-K16 inline regex
          // was correct but untestable in isolation without mounting
          // the full editor + mocking fetch — ~50 LOC test scaffold
          // for a 3-line branch. The helper keeps the call-site one-
          // liner while making the branch CI-enforceable.
          const messageKey = isOfflineFetchError(e)
            ? 'error.offline'
            : 'error.saveFailed';
          setSaveError(t(messageKey));
          toast.error(t(messageKey));
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
                /*
                 * J8-M28: replaced the bare-text "No schedule policies"
                 * placeholder with the standard `<EmptyState>` anatomy
                 * from `docs/ux-standards.md` § 3.1 — icon + title +
                 * description + primary CTA. The CTA inserts the first
                 * step locally so admin can immediately start editing
                 * (the save button persists at the bottom of the tab).
                 */
                <EmptyState
                  icon={CalendarPlus}
                  title={t('empty.noPoliciesTitle')}
                  description={t('empty.noPoliciesDescription')}
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={readOnly}
                      onClick={() => replaceSteps(b, [emptyStep()])}
                    >
                      <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
                      {t('actions.addStep')}
                    </Button>
                  }
                />
              ) : null}
              {steps.map((step, idx) => (
                <StepRow
                  // K5: previously `${b}-${idx}` — array-index keys
                  // make React reconciliation diff by position, so when
                  // admin clicks Move-up/Move-down the input field
                  // values appeared to swap (state stayed bound to the
                  // index that no longer pointed at the same step).
                  // step_id is unique-per-row (enforced by `emptyStep()`
                  // via `crypto.randomUUID()`) and stable across
                  // reorders — React now correctly tracks the same
                  // logical row even when its index changes.
                  key={`${b}-${step.step_id}`}
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
                    /*
                     * J8-M26: Remove-step is locally destructive (the
                     * step disappears from the editor's draft list)
                     * but reversible until the admin clicks Save —
                     * after Save the server-side upsert removes the
                     * step from the policy's persisted JSONB. ux-
                     * standards § 5.3 calls for an Undo affordance
                     * on reversible destructive actions; sonner's
                     * `action` prop renders an inline 8s Undo button.
                     * The captured `previousSteps` snapshot restores
                     * the exact array (including the removed step's
                     * field values) — admin can experiment freely
                     * before committing.
                     */
                    const previousSteps = [...steps];
                    const arr = [...steps];
                    arr.splice(idx, 1);
                    replaceSteps(b, arr);
                    toast.info(t('actions.stepRemoved'), {
                      duration: 8_000,
                      action: {
                        label: t('actions.undo'),
                        onClick: () => replaceSteps(b, previousSteps),
                      },
                    });
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
