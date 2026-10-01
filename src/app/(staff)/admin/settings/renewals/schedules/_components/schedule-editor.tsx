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
 * Read-only mode: the `readOnly` prop renders all controls disabled
 * + a banner-style notice. Server-side RBAC at the PUT route is the
 * canonical gate — this UI affordance is defence-in-depth.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { CalendarPlus } from 'lucide-react';
import { ActionBar, Alert, Button, Tabs, type TabItem } from '@jirawatpyk/aura-react';
import { EmptyState } from '@/components/shell/empty-state';
import { LiveRegion } from '@/components/shell/live-region';

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
import { formatDatePreset } from '@/lib/format-date-localised';

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
  /** The tier shown first (the no-DB preview opens on Premium, as the boards do). */
  readonly defaultBucket?: TierBucket;
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
  defaultBucket = TIER_BUCKETS[0],
}: ScheduleEditorProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  // J1-B8: locale-aware date formatter (next-intl) replaces raw
  // `toLocaleString()` which leaks browser default locale and never
  // surfaces Buddhist Era for `th-TH` users.
  const locale = useLocale();
  const [byBucket, setByBucket] = useState(() => policiesByBucket(initialPolicies));
  // Follow-up (`.superpowers/sdd/followup-saverace-brief.md`) — a ref
  // mirror of `byBucket` so `handleSave`'s success branch can read the
  // CURRENT steps synchronously at the moment a save resolves, not the
  // stale pre-save snapshot it captured before the awaited `fetch`. NOT
  // a side-effect inside a `setState` updater — React StrictMode
  // double-invokes updaters in dev, so mutating an outer variable there
  // is unreliable; this effect-based mirror is the safe alternative.
  const byBucketRef = useRef(byBucket);
  useEffect(() => {
    byBucketRef.current = byBucket;
  }, [byBucket]);
  const [activeBucket, setActiveBucket] = useState<TierBucket>(defaultBucket);
  const [pending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  // C1 (`.superpowers/sdd/followup-reminder-uxwave-brief.md`) — unsaved-
  // changes guard. Every bucket edited since its last SUCCESSFUL save is
  // tracked here (added in `replaceSteps`, deleted on save success below);
  // `dirtyBuckets.size > 0` drives the `beforeunload` effect further down.
  // Simpler than diffing wire-shape against a saved snapshot and matches
  // "unsaved since last save" exactly — see the brief for the trade-off.
  const [dirtyBuckets, setDirtyBuckets] = useState<Set<TierBucket>>(
    () => new Set<TierBucket>(),
  );
  // I3 (`.superpowers/sdd/followup-reminder-uxwave-brief.md`) — reorder
  // (move-up/move-down) used to be silent for keyboard/SR users: the array
  // reorders but the buttons don't move and focus stays put. Mounted
  // unconditionally with empty content (LiveRegion's own contract — a
  // conditionally-mounted live region is not announced by most screen
  // readers), updated by `onMoveUp`/`onMoveDown` below.
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');

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
      // C1 — every edit path (add/remove/reorder/inline-field-change/undo)
      // funnels through this one function, so marking the bucket dirty
      // here covers all of them without threading a flag through each
      // call site.
      setDirtyBuckets((prev) => {
        if (prev.has(b)) return prev;
        const nextDirty = new Set(prev);
        nextDirty.add(b);
        return nextDirty;
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
          // Follow-up (`.superpowers/sdd/followup-saverace-brief.md`) — a
          // save can be in flight while the admin keeps editing THIS
          // bucket: StepCard's fields and the move-up/down reorder
          // buttons are gated only by `readOnly`, never by this save's
          // `pending` flag (only the Add-step/Save buttons are). `stepsNow`
          // above is a snapshot taken BEFORE the awaited `fetch`, so it
          // goes stale the instant a mid-save edit lands. Read the CURRENT
          // steps synchronously via `byBucketRef` and wire-shape-compare
          // against the snapshot (`toWireSteps` strips the editor-only
          // `_uiKey`, so a pure `_uiKey` remap — e.g. from a concurrent
          // reload — never counts as an edit).
          const currentSteps = byBucketRef.current[b]?.steps ?? [];
          const editedDuringSave =
            JSON.stringify(toWireSteps(currentSteps)) !==
            JSON.stringify(toWireSteps(stepsNow));
          // Refresh local cache with server-confirmed policy — but never
          // clobber a newer mid-save edit with the stale pre-save
          // snapshot; keep whatever is currently shown instead.
          setByBucket((prev) => ({
            ...prev,
            [b]: {
              tier_bucket: b,
              steps: editedDuringSave ? (prev[b]?.steps ?? currentSteps) : stepsNow,
              updated_at: body.updated_at,
            },
          }));
          // C1 — this bucket's edits are now persisted; clear its dirty
          // flag so the `beforeunload` guard stops firing once every
          // bucket is saved. If the admin edited THIS bucket again while
          // the save was in flight, that newer edit was never sent to the
          // server — stay dirty so the guard keeps protecting it.
          setDirtyBuckets((prev) => {
            if (editedDuringSave) return prev;
            if (!prev.has(b)) return prev;
            const nextDirty = new Set(prev);
            nextDirty.delete(b);
            return nextDirty;
          });
          // Plain-language save toast (follow-up UX fix): the raw
          // change-diff counts `(+added -removed =unchanged)` read as
          // noise to admins. `unchanged` is dropped entirely; the ICU
          // message keys off `total = added + removed` (=0 → plain
          // "schedule saved" confirmation, otherwise "· {added} added,
          // {removed} removed") so the branch lives in the translation,
          // not here.
          const added = body.change_diff.added?.length ?? 0;
          const removed = body.change_diff.removed?.length ?? 0;
          toast.success(
            t('saved.toast', {
              tier: t(`tabs.${b}`),
              total: added + removed,
              added,
              removed,
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

  // C1 — hand-rolled to match the three sibling admin forms exactly
  // (`member-form.tsx`, `issue-invoice-form.tsx`, broadcast
  // `compose-form.tsx`) rather than the shared invoice-settings
  // `useUnsavedGuard` — kept contained to this surface; a shared-hook
  // extraction is a separate future cleanup. Covers tab close / hard nav /
  // refresh only — App Router exposes no clean SPA route-change
  // interception.
  useEffect(() => {
    const dirty = dirtyBuckets.size > 0;
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Modern browsers ignore the message string and show their own copy;
      // preventDefault + returnValue is the cross-browser invocation pattern.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyBuckets]);

  // 122 US7b-2 (T738), boards `Admin-renewal-schedules` (+`-mobile`): the
  // tiers are AURA Tabs named "Member tier". Every panel stays mounted
  // (`keepMounted`) because each tier keeps its own unsaved edits.
  const tabs: TabItem[] = TIER_BUCKETS.map((b) => {
    const steps = stepsFor(b);
    const lastSavedAt = byBucket[b]?.updated_at;
    const status = [
      t('stepCount', { count: steps.length }),
      ...(lastSavedAt
        ? [t('lastSaved', { date: formatDatePreset(lastSavedAt, locale, 'dateTimeMedium') })]
        : []),
    ].join(' · ');
    return {
      id: b,
      label: t(`tabs.${b}`),
      content: (
        <div className="flex flex-col gap-[var(--aura-space-4)] pt-[var(--aura-space-4)]">
          <h2 className="m-0 text-base font-semibold text-[var(--aura-fg-primary)]">{t(`tabs.${b}`)}</h2>
          <ReminderTimeline tierBucket={b} steps={steps} />
          {steps.length === 0 ? (
            // J8-M28: the standard EmptyState (icon, title, description,
            // CTA); the CTA adds the first step locally.
            <EmptyState
              icon={CalendarPlus}
              title={t('empty.noPoliciesTitle')}
              description={t('empty.noPoliciesDescription')}
              action={
                <Button
                  variant="secondary"
                  icon="plus"
                  disabled={readOnly}
                  onClick={() => replaceSteps(b, [emptyStep(b, steps)])}
                >
                  {t('actions.addStep')}
                </Button>
              }
            />
          ) : (
            <ol className="m-0 flex list-none flex-col gap-[var(--aura-space-3)] p-0">
              {steps.map((step, idx) => (
                // Keyed by `_uiKey`, generated once per step: `step_id` is
                // recomposed on every timing edit, and an index key would
                // swap field values on a reorder (K5, v3 Change 3).
                <li key={step._uiKey}>
                  <StepCard
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
                       * on reversible destructive actions; the toast's
                       * `action` renders an inline 8s Undo button.
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
                      // I3 — new 1-based position of the step that just moved
                      // (0-based idx-1, so 1-based is idx).
                      setReorderAnnouncement(
                        t('reorder.announce', { position: idx, total: steps.length }),
                      );
                    }}
                    onMoveDown={() => {
                      if (idx === steps.length - 1) return;
                      const arr = [...steps];
                      const cur = arr[idx]!;
                      const nxt = arr[idx + 1]!;
                      arr[idx] = nxt;
                      arr[idx + 1] = cur;
                      replaceSteps(b, arr);
                      // I3 — new 1-based position (0-based idx+1, so 1-based
                      // is idx+2).
                      setReorderAnnouncement(
                        t('reorder.announce', { position: idx + 2, total: steps.length }),
                      );
                    }}
                  />
                </li>
              ))}
            </ol>
          )}
          {/* One error for the editor, shown in the tier being saved. */}
          {saveError && b === activeBucket ? (
            <Alert tone="danger" role="alert">
              {saveError}
            </Alert>
          ) : null}
          {/* The save bar: under the steps from 640px, pinned to the bottom of
              a phone screen (globals.css, `.schedule-actions`). */}
          <ActionBar
            label={t('saveBarLabel')}
            status={status}
            className="chamber-viewport-actionbar schedule-actions"
          >
            <Button
              variant="secondary"
              icon="plus"
              disabled={readOnly || pending}
              onClick={() => replaceSteps(b, [...steps, emptyStep(b, steps)])}
            >
              {t('actions.addStep')}
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={readOnly || steps.length === 0}
              onClick={() => handleSave(b)}
            >
              {pending ? t('actions.saving') : t('actions.save')}
            </Button>
          </ActionBar>
        </div>
      ),
    };
  });

  return (
    <div className="flex flex-col gap-[var(--aura-space-3)]">
      {/* I3 — always mounted; a conditionally-mounted live region is not
          announced by most screen readers. Updated by onMoveUp/onMoveDown. */}
      <LiveRegion politeness="polite">{reorderAnnouncement}</LiveRegion>
      {readOnly ? (
        // I2 — informational ("you're in read-only mode"), not a warning.
        <Alert tone="info" role="status">
          {t('manager.readOnlyNotice')}
        </Alert>
      ) : null}
      <Tabs
        label={t('tierTabsLabel')}
        tabs={tabs}
        value={activeBucket}
        onChange={(v) => setActiveBucket(v as TierBucket)}
        keepMounted
      />
    </div>
  );
}
