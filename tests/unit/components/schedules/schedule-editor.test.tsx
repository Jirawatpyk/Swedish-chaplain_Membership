/**
 * `schedule-editor.tsx` unit tests.
 *
 *   - `isOfflineFetchError()` — K16-2 (R14-S7) 3-browser offline-detection
 *     regex coverage (unchanged by the v2 StepCard rework).
 *   - `emptyStep()` — v2 rework (`.superpowers/sdd/rework-stepcard-v2-
 *     brief.md`) Issue 3(a): "Add step" used to always default to
 *     `-30/email`, so two consecutive clicks produced two `t-30.email`
 *     steps (duplicate React key + a 422 from the Domain's bucket-wide
 *     `parseSchedulePolicySteps` uniqueness check). `emptyStep` now
 *     takes the bucket's EXISTING steps and advances to the tier's
 *     first unused standard email offset, falling back to
 *     `composeUniqueStepId`'s deterministic disambiguator once every
 *     standard offset is already taken.
 *   - UI-level: two consecutive "Add step" clicks on the mounted
 *     `<ScheduleEditor>` produce two steps with distinct `step_id`s —
 *     the end-to-end guard for the same Issue 3 regression.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
// F8 Phase 8 path-alignment fix — schedule-editor.tsx moved to
// `(staff)/admin/settings/renewals/schedules/...` post-Wave K16. The
// test's import path lagged behind the source move; corrected here so
// `pnpm typecheck` stays green on the F8 branch (regression surfaced
// after .next type-generation refreshed at Phase 8 ship).
import {
  isOfflineFetchError,
  emptyStep,
  toWireSteps,
  ScheduleEditor,
  type EditorStep,
  type ScheduleStepWire,
} from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';
import { offsetKeyFromDays } from '@/modules/renewals/client';

// Base UI Radio uses PointerEvent internally; jsdom lacks it. Same
// polyfill as tests/unit/components/schedules/step-card.test.tsx /
// tests/unit/members/presentation/members-table-selection.test.tsx.
// Needed by the v3 "`_uiKey` React-key stability" describe block below,
// which drives the real (unmocked) channel RadioGroup.
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

describe('isOfflineFetchError() — schedule-editor offline detection', () => {
  describe('returns true for browser-emitted offline TypeErrors', () => {
    it('Chrome: "TypeError: Failed to fetch"', () => {
      const e = new TypeError('Failed to fetch');
      expect(isOfflineFetchError(e)).toBe(true);
    });

    it('Firefox: "TypeError: NetworkError when attempting to fetch resource"', () => {
      const e = new TypeError(
        'NetworkError when attempting to fetch resource',
      );
      expect(isOfflineFetchError(e)).toBe(true);
    });

    it('Safari: "TypeError: Load failed"', () => {
      // K14-8 (R13-S5) closure: Safari was previously falling through
      // to the generic "saveFailed" copy because neither /fetch/i nor
      // /network/i matched its `Load failed` message.
      const e = new TypeError('Load failed');
      expect(isOfflineFetchError(e)).toBe(true);
    });

    it('matches case-insensitively', () => {
      // Real Safari uses lowercase "Load failed"; pin the regex flag
      // is `i` so a Safari version that emitted "LOAD FAILED" would
      // still match.
      expect(isOfflineFetchError(new TypeError('LOAD FAILED'))).toBe(true);
      expect(isOfflineFetchError(new TypeError('Failed to FETCH'))).toBe(true);
      expect(isOfflineFetchError(new TypeError('NETWORKError'))).toBe(true);
    });
  });

  describe('returns false for non-offline causes', () => {
    it('non-TypeError instance (e.g. plain Error) is NOT offline', () => {
      // K15 / K1-E6: server-thrown errors (500, JSON parse failure on
      // a malformed body) come through as plain Error or SyntaxError.
      // Those must route to "saveFailed" not "offline".
      const e = new Error('Failed to fetch');
      expect(isOfflineFetchError(e)).toBe(false);
    });

    it('SyntaxError with offline-like text is NOT offline', () => {
      const e = new SyntaxError(
        'Unexpected token < in JSON at position 0',
      );
      expect(isOfflineFetchError(e)).toBe(false);
    });

    it('TypeError with non-matching message (real code bug) is NOT offline', () => {
      // `TypeError: Cannot read properties of undefined (reading 'x')`
      // is a code bug — must NOT be classified as offline because that
      // would mask the bug under "check your connection" copy.
      const e = new TypeError(
        "Cannot read properties of undefined (reading 'x')",
      );
      expect(isOfflineFetchError(e)).toBe(false);
    });

    it('non-Error throw (string, object) is NOT offline', () => {
      expect(isOfflineFetchError('Failed to fetch')).toBe(false);
      expect(isOfflineFetchError({ message: 'Failed to fetch' })).toBe(false);
      expect(isOfflineFetchError(null)).toBe(false);
      expect(isOfflineFetchError(undefined)).toBe(false);
    });

    it('TypeError with empty message is NOT offline', () => {
      expect(isOfflineFetchError(new TypeError(''))).toBe(false);
    });
  });
});

describe('emptyStep() — Issue 3(a): offset-advance default avoids the t-30.email collision', () => {
  it('defaults to the tier\'s FIRST standard offset (email) when the bucket is empty', () => {
    const s = emptyStep('regular', []);
    // 'regular' tier standard offsets: t-60, t-30, t-14, t-7, t+0, t+7.
    expect(s.offset_days).toBe(-60);
    expect(s.channel).toBe('email');
    expect(s.step_id).toBe('t-60.email');
    expect(s.template_id).toBe('renewal.t-60.regular');
  });

  it('advances to the next unused standard email offset when an earlier one is taken', () => {
    const existing: ScheduleStepWire[] = [
      { step_id: 't-60.email', offset_days: -60, channel: 'email', template_id: 'renewal.t-60.regular' },
    ];
    const s = emptyStep('regular', existing);
    expect(s.offset_days).toBe(-30);
    expect(s.step_id).toBe('t-30.email');
  });

  it('ignores task-channel steps at the same offset (natural collision key is offset+channel)', () => {
    const existing: ScheduleStepWire[] = [
      {
        step_id: 't-60.task.phone_call',
        offset_days: -60,
        channel: 'task',
        task_type: 'phone_call',
        assignee_role: 'admin',
      },
    ];
    const s = emptyStep('regular', existing);
    expect(s.offset_days).toBe(-60); // email is still free at -60
  });

  it('falls back to the FIRST standard offset + a deterministic disambiguator once every standard email offset is taken', () => {
    const tierOffsetDays = [-60, -30, -14, -7, 0, 7]; // 'regular' tier, ascending
    const existing: ScheduleStepWire[] = tierOffsetDays.map((d) => ({
      step_id: `${offsetKeyFromDays(d)}.email`,
      offset_days: d,
      channel: 'email',
      template_id: 'renewal.x.regular',
    }));
    const s = emptyStep('regular', existing);
    expect(s.offset_days).toBe(-60); // falls back to the first standard offset
    expect(s.step_id).toBe('t-60.email.2'); // disambiguated — distinct from the existing t-60.email
  });

  it('two sequential calls (second fed the first as an existing step) never collide', () => {
    const first = emptyStep('regular', []);
    const second = emptyStep('regular', [first]);
    expect(second.step_id).not.toBe(first.step_id);
    expect(second.offset_days).not.toBe(first.offset_days);
  });

  // v3 rework (`.superpowers/sdd/rework-stepcard-v3-brief.md`, Change 3)
  // — the "Add step" half of the stable-`_uiKey` guarantee. `_uiKey` is
  // what `<StepCard>` is now keyed by (schedule-editor.tsx), so two
  // freshly-added rows must never share one.
  it('two sequential calls produce distinct `_uiKey`s', () => {
    const first = emptyStep('regular', []);
    const second = emptyStep('regular', [first]);
    expect(first._uiKey).not.toBe(second._uiKey);
    expect(typeof first._uiKey).toBe('string');
    expect(first._uiKey.length).toBeGreaterThan(0);
  });
});

// v3 rework Change 3 — `toWireSteps` is the other half of the guarantee:
// `_uiKey` must never reach the server.
describe('toWireSteps() — strips `_uiKey` before the PUT body is built', () => {
  it('produces a byte-identical ScheduleStepWire[] with no `_uiKey` key', () => {
    const editorSteps: EditorStep[] = [
      {
        _uiKey: 'regular-0',
        step_id: 't-30.email',
        offset_days: -30,
        channel: 'email',
        template_id: 'renewal.t-30.regular',
      },
      {
        _uiKey: 'regular-1',
        step_id: 't+7.task.phone_call',
        offset_days: 7,
        channel: 'task',
        task_type: 'phone_call',
        assignee_role: 'admin',
      },
    ];
    const wire = toWireSteps(editorSteps);
    const expected: ScheduleStepWire[] = [
      { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
      { step_id: 't+7.task.phone_call', offset_days: 7, channel: 'task', task_type: 'phone_call', assignee_role: 'admin' },
    ];
    expect(wire).toEqual(expected);
    // Assert the KEY itself is absent (not merely `undefined`) — matches
    // what `JSON.stringify` actually sends over the wire.
    wire.forEach((s) => expect(Object.prototype.hasOwnProperty.call(s, '_uiKey')).toBe(false));
    expect(JSON.stringify({ steps: wire })).not.toContain('_uiKey');
  });
});

// v3 rework Change 3 — the actual remount-bug regression guard: keying
// `<StepCard>` by `_uiKey` (not the recomposed `step_id`) means an edit
// that changes `step_id` must NOT tear down and recreate the card's DOM.
describe('<ScheduleEditor> — `_uiKey` React-key stability (Change 3 remount-bug fix)', () => {
  // tests/setup.ts installs FAKE timers globally
  // (`shouldAdvanceTime: false`) for deterministic TTL tests elsewhere in
  // the suite. `@testing-library/react`'s `waitFor` polls via
  // `setTimeout`, which never fires under those fake timers — the test
  // below hangs to the full 30s suite timeout without this. Same
  // real-timers-for-this-block convention as
  // tests/unit/components/invoices/invoice-create-switcher.test.tsx.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useFakeTimers();
  });

  it('does not remount the StepCard DOM node when an edit recomposes step_id', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ScheduleEditor initialPolicies={[]} readOnly={false} />
      </NextIntlClientProvider>,
    );
    // Seed one step in the active tab (email channel, standard offset —
    // see the emptyStep() describe block above).
    fireEvent.click(screen.getAllByRole('button', { name: /add step/i })[0]!);

    // Capture a DOM node scoped to the mounted StepCard. If the card
    // remounted, React would tear down this exact node and create a
    // brand-new one in its place — even though it would look identical
    // — so a captured *reference* is the correct way to detect a
    // remount (unlike a textContent/attribute comparison, which a
    // remount would still satisfy).
    const removeButtonBefore = screen.getByRole('button', { name: /remove step/i });

    // Switching channel (Email → Task) recomposes `step_id`
    // (`step-card.tsx`'s `handleChannelChange`) — the same class of edit
    // as the new custom-day input, which recomposes `step_id` on every
    // keystroke. Driven via the segment's <label> text — Base UI Radio
    // toggles through its associated <label>, not a direct click on
    // role=radio (same proven pattern as
    // tests/unit/components/invoices/invoice-create-switcher.test.tsx).
    //
    // The literal custom-day-input recompose path is covered directly,
    // at the callback/data level, by step-card.test.tsx's "preserves
    // the stable _uiKey" test — driving Base UI's real popup-based
    // <Select> through a full, unmocked <ScheduleEditor> mount isn't
    // practical in jsdom. The remount mechanism under test here (keying
    // by `_uiKey` survives a step_id-changing edit) is identical
    // regardless of which control triggers the recompose.
    //
    // `{ selector: 'label' }` disambiguates from `ReminderTimeline`'s
    // "Task" legend entry (a <span>, always rendered) — only the
    // channel segment's <label> should receive the click.
    fireEvent.click(screen.getByText('Task', { selector: 'label' }));

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /task/i })).toBeChecked();
    });

    const removeButtonAfter = screen.getByRole('button', { name: /remove step/i });
    expect(removeButtonAfter).toBe(removeButtonBefore);
  });
});

describe('<ScheduleEditor> — two consecutive "Add step" clicks (guards Issue 3 end to end)', () => {
  it('produce two steps with distinct step_ids, not a duplicate t-30.email pair', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ScheduleEditor initialPolicies={[]} readOnly={false} />
      </NextIntlClientProvider>,
    );
    // First click: the EmptyState CTA and the bottom toolbar both render
    // an "Add step" button while the active tab (first tier bucket) has
    // zero steps — either one adds the first step (both compute
    // `emptyStep(bucket, [])`).
    const addButtons = screen.getAllByRole('button', { name: /add step/i });
    fireEvent.click(addButtons[0]!);
    // EmptyState is now gone (1 step) — exactly one "Add step" button
    // remains (the persistent bottom toolbar one).
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));

    // Both steps default to Email — the reminder timeline's
    // screen-reader text-alternative list renders one <li> per step
    // (inactive tier tabs stay `hidden`, so this only reflects the
    // active tab's 2 steps). Two DISTINCT offsets is direct evidence of
    // two DISTINCT step_ids (the bug this guards against: two IDENTICAL
    // `t-30.email` entries would render identical text here).
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).not.toBe(items[1]!.textContent);
  });
});
