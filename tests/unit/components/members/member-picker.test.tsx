/**
 * Bug 1 (a11y debt found during PR-B review, 2026-07-14 — pre-existing,
 * NOT introduced by PR-B) — `<MemberPicker>`'s trigger advertised
 * `aria-controls` pointing at a precomputed id (`${listboxId}-list`)
 * passed to `<CommandList id={...}>`. cmdk (`cmdk@1.1.1`) silently
 * overwrites any `id` prop on `<CommandList>`/`<CommandInput>` with its
 * own internal `useId()`-generated id — verified directly against the
 * installed source (`node_modules/cmdk/dist/index.mjs`): the `id:
 * b.listId` key sits AFTER the `...c` prop spread, so the caller's id
 * never lands on the DOM. The trigger's `aria-controls` therefore pointed
 * at an element that never existed — a screen reader following that
 * relationship found nothing.
 *
 * `src/components/ui/combobox.tsx` (PR-B task 5) already solves this via
 * a ref-callback that reads the REAL rendered listbox id back off cmdk's
 * own documented `[cmdk-list]` selector, rather than pre-computing one.
 * This test proves the same technique applied to `MemberPicker` — it
 * renders the REAL Popover + cmdk stack (no primitive mocking) and
 * asserts the ARIA relationship actually RESOLVES in the DOM, which is
 * exactly the assertion the shipped bug would have failed.
 *
 * jsdom workarounds mirror `tests/unit/components/ui/combobox-a11y.test.tsx`
 * / `tests/unit/members/presentation/country-combobox.test.tsx`:
 *   1. Real timers — `tests/setup.ts` installs fake timers globally;
 *      React 19's scheduler needs real ones for the popover's open
 *      transition to flush.
 *   2. `ResizeObserver` + `Element.scrollIntoView` stubs — cmdk's
 *      `<CommandList>` mount effect and item-highlight logic call both;
 *      jsdom implements neither.
 *   3. `global.fetch` is stubbed — unlike the two harnesses above,
 *      `MemberPicker` fetches `/api/members` on open (debounced search),
 *      so a real network call would hang the test without a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberPicker } from '@/components/members/member-picker';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Harness({
  value = null,
  onChange = () => {},
}: {
  readonly value?: string | null;
  readonly onChange?: (id: string | null) => void;
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <label id="link-member-label" htmlFor="link-member">
        Link to member company
      </label>
      <MemberPicker
        id="link-member"
        value={value}
        onChange={onChange}
        aria-labelledby="link-member-label"
      />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              { member_id: 'm-1', company_name: 'Acme AB', country: 'SE', status: 'active' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useFakeTimers({
    now: new Date('2026-04-09T12:00:00.000Z'),
    shouldAdvanceTime: false,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});

describe('<MemberPicker> — aria-controls resolves to a real DOM element (Bug 1)', () => {
  it('opening the popover sets aria-controls to an id that actually exists in the DOM', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');

    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));

    const controlsId = trigger.getAttribute('aria-controls');
    expect(controlsId).not.toBeNull();
    // The actual defect: cmdk overwrites CommandList's id with its own
    // useId()-generated one, so a precomputed id the trigger advertises
    // points at nothing. This is the assertion that would have caught it.
    expect(document.getElementById(controlsId as string)).not.toBeNull();
  });

  it('the resolved aria-controls target is the rendered listbox itself', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);

    const listbox = await screen.findByRole('listbox');
    expect(listbox.id).toBe(trigger.getAttribute('aria-controls'));
  });
});
