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
  AlertCircle,
  CalendarPlus,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shell/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';

// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import {
  TIER_BUCKETS,
  TIER_REMINDER_OFFSETS,
  daysFromOffsetKey,
  type TierBucket,
} from '@/modules/renewals/client';
import { StepCard } from './step-card';
import { ReminderTimeline } from './reminder-timeline';
import { composeUniqueStepId, composeTemplateId } from './step-id-composer';

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

/**
 * v3 rework (`.superpowers/sdd/rework-stepcard-v3-brief.md`, Change 3) —
 * editor-local step shape. `step_id` is recomposed on every timing/
 * channel edit (including on every keystroke in the new custom-day
 * input — see `step-card.tsx`), so keying `<StepCard>` by `step_id`
 * remounted the whole card mid-edit and dropped focus. `_uiKey` is a
 * STABLE, edit-independent identity generated once per step (see
 * `nextUiKey` below) that never itself gets recomputed on edit — every
 * `{...step, ...}` spread inside `step-card.tsx`'s onChange handlers
 * carries it forward automatically (TypeScript's structural typing
 * doesn't strip extra runtime properties from a spread), and the two
 * handlers that build a fresh literal instead of spreading
 * (`handleChannelChange`'s two branches) thread it through explicitly.
 *
 * NEVER sent over the wire — `toWireSteps` strips it before every PUT
 * (see `handleSave`) so the request body stays byte-identical to
 * `{ steps: ScheduleStepWire[] }`.
 */
export interface EditorStep extends ScheduleStepWire {
  readonly _uiKey: string;
}

export interface EditorSchedulePolicy {
  tier_bucket: TierBucket;
  steps: EditorStep[];
  updated_at: string;
}

// Deterministic, monotonically-incrementing `_uiKey` source. `Math.random()`
// / `Date.now()` / an argless `new Date()` are BANNED for this purpose (v3
// brief) — a random or clock-based key would defeat the whole point of a
// STABLE key. Module-level so every step ever created by this editor
// (across every tier bucket) gets a globally distinct key.
let uiKeySeq = 0;

function nextUiKey(tierBucket: TierBucket): string {
  return `${tierBucket}-${uiKeySeq++}`;
}

/**
 * Strip `_uiKey` before the PUT body is built. Exported for direct unit
 * testing (same "extract for testability" convention as
 * `isOfflineFetchError` / `emptyStep` below) — proves the wire payload
 * stays byte-identical to `ScheduleStepWire[]` without needing to mock
 * `fetch` end to end.
 */
export function toWireSteps(steps: ReadonlyArray<EditorStep>): ScheduleStepWire[] {
  return steps.map(({ _uiKey, ...wire }) => wire);
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

/**
 * Task 9: compose VALID wire identifiers for a fresh step instead of the
 * placeholder `new-<uuid>` / `renewal.t-30` shape the old `StepRow`-era
 * default used (no tier suffix on `template_id` — the gateway's
 * `deriveTierFromTemplateId` can never resolve it, so the step could
 * never actually send).
 *
 * v2 rework (`.superpowers/sdd/rework-stepcard-v2-brief.md`, Issue 3a):
 * previously this ALWAYS defaulted to -30/email, so clicking "Add step"
 * twice produced two `t-30.email` steps — a duplicate React list key
 * AND a 422 from the Domain's bucket-wide `parseSchedulePolicySteps`
 * uniqueness check. `existingSteps` (the bucket's current step list) now
 * lets the default ADVANCE to the tier's first standard offset not
 * already used by an existing EMAIL step (the natural collision key is
 * offset+channel, matching `composeStepId`'s own contract). If every
 * standard offset is already taken, fall back to the first standard
 * offset and let `composeUniqueStepId` (step-id-composer.ts)
 * deterministically disambiguate the step_id.
 *
 * Exported for direct unit testing —
 * tests/unit/components/schedules/schedule-editor.test.tsx.
 */
export function emptyStep(
  tier: TierBucket,
  existingSteps: ReadonlyArray<ScheduleStepWire>,
): EditorStep {
  const usedEmailOffsets = new Set(
    existingSteps.filter((s) => s.channel === 'email').map((s) => s.offset_days),
  );
  const standardOffsetDays = TIER_REMINDER_OFFSETS[tier].map(daysFromOffsetKey);
  const offsetDays =
    standardOffsetDays.find((d) => !usedEmailOffsets.has(d)) ?? standardOffsetDays[0] ?? -30;
  const existingIds = new Set(existingSteps.map((s) => s.step_id));
  return {
    // v3 — the other half of Change 3 ("Add step" gets a fresh stable
    // key; `policiesByBucket` below covers the "loaded from server" half).
    _uiKey: nextUiKey(tier),
    step_id: composeUniqueStepId({ offsetDays, channel: 'email' }, existingIds),
    offset_days: offsetDays,
    channel: 'email',
    template_id: composeTemplateId(offsetDays, tier),
  };
}

function policiesByBucket(
  policies: ReadonlyArray<SchedulePolicyWire>,
): Record<TierBucket, EditorSchedulePolicy | undefined> {
  const out: Partial<Record<TierBucket, EditorSchedulePolicy>> = {};
  for (const p of policies) {
    out[p.tier_bucket] = {
      tier_bucket: p.tier_bucket,
      steps: p.steps.map((s) => ({ ...s, _uiKey: nextUiKey(p.tier_bucket) })),
      updated_at: p.updated_at,
    };
  }
  return out as Record<TierBucket, EditorSchedulePolicy | undefined>;
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
    (b: TierBucket): EditorStep[] => {
      const policy = byBucket[b];
      return policy ? [...policy.steps] : [];
    },
    [byBucket],
  );

  const replaceSteps = useCallback(
    (b: TierBucket, next: EditorStep[]) => {
      setByBucket((prev) => {
        const existing = prev[b];
        const updated: EditorSchedulePolicy = {
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
              // v3 Change 3 — `stepsNow` carries the editor-local `_uiKey`;
              // strip it so the wire body stays byte-identical to
              // `{ steps: ScheduleStepWire[] }`.
              body: JSON.stringify({ steps: toWireSteps(stepsNow) }),
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
              <ReminderTimeline tierBucket={b} steps={steps} />
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
                      onClick={() => replaceSteps(b, [emptyStep(b, steps)])}
                    >
                      <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
                      {t('actions.addStep')}
                    </Button>
                  }
                />
              ) : null}
              {steps.map((step, idx) => (
                <StepCard
                  // K5: previously `${b}-${idx}` — array-index keys make
                  // React reconciliation diff by position, so when admin
                  // clicks Move-up/Move-down the input field values
                  // appeared to swap (state stayed bound to the index
                  // that no longer pointed at the same step).
                  //
                  // v3 rework (Change 3): `${b}-${step.step_id}` (the K5
                  // fix) was itself a bug — `step_id` is recomposed on
                  // every timing/channel edit (including every keystroke
                  // in the new custom-day input), so the key changed
                  // mid-edit and remounted the card, dropping focus.
                  // `_uiKey` is generated once per step and never
                  // recomputed on edit — see its doc comment above.
                  key={step._uiKey}
                  tierBucket={b}
                  step={step}
                  index={idx}
                  total={steps.length}
                  readOnly={readOnly}
                  siblingSteps={steps.filter((_, i) => i !== idx)}
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
                        date: fmt.dateTime(new Date(lastSavedAt), 'dateTimeMedium'),
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={readOnly || pending}
                    onClick={() => replaceSteps(b, [...steps, emptyStep(b, steps)])}
                  >
                    <Plus aria-hidden="true" className="mr-1 h-4 w-4" />
                    {t('actions.addStep')}
                  </Button>
                  <Button
                    type="button"
                    disabled={readOnly || pending || steps.length === 0}
                    aria-busy={pending}
                    onClick={() => handleSave(b)}
                  >
                    {pending ? (
                      <>
                        <Loader2
                          aria-hidden="true"
                          className="mr-1 h-4 w-4 motion-safe:animate-spin"
                        />
                        {t('actions.saving')}
                      </>
                    ) : (
                      t('actions.save')
                    )}
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
