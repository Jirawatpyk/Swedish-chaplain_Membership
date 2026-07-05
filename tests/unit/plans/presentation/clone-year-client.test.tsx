/**
 * CloneYearClient — pre-flight count behaviour (code-review round-2 regressions).
 *
 * Guards two bugs an earlier fix introduced and this change corrects:
 *   #1 net-zero year edit must not strand the count at null (the refetch effect
 *      keys on the IMMEDIATE sourceYear, so returning to the default restores).
 *   #2 an unknown count ("…", incl. a failed fetch) must NOT disable Clone —
 *      the count is display-only; the clone uses the real Source year.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CloneYearClient } from '@/app/(staff)/admin/plans/clone/clone-year-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const messages = {
  common: { errors: { readOnlyMode: 'ro', generic: 'err', network: 'net' } },
  admin: {
    plans: {
      errors: { readOnlyMode: 'ro', generic: 'err', network: 'net' },
      clone: {
        description: 'Clone {count} plans from {sourceYear} to {targetYear}',
        sourceLabel: 'Source year',
        targetLabel: 'Target year',
        activateClonedLabel: 'Activate cloned',
        cancel: 'Cancel',
        submit: 'Clone {count} plans',
        submitting: 'Cloning…',
        title: 'Clone plans',
        errors: { targetYearPopulated: 'x', noPlans: 'y' },
      },
    },
  },
};

function renderClient() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CloneYearClient
        defaultSourceYear={2026}
        defaultTargetYear={2027}
        defaultSourcePlanCount={5}
      />
    </NextIntlClientProvider>,
  );
}

function cloneButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Clone/ }) as HTMLButtonElement;
}

describe('CloneYearClient pre-flight count', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the default count and enables Clone on mount', () => {
    renderClient();
    expect(cloneButton()).not.toBeDisabled();
    expect(screen.getByText('Clone 5 plans from 2026 to 2027')).toBeTruthy();
  });

  it('#2: changing the source year blanks the count to "…" but keeps Clone enabled', () => {
    renderClient();
    const input = document.getElementById('source_year') as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: '2028' } });
    });
    // Count unknown → "…", but the button must NOT be disabled by it.
    expect(cloneButton()).not.toBeDisabled();
    expect(
      screen.getByText('Clone … plans from 2028 to 2027'),
    ).toBeTruthy();
  });

  it('#G: a transient out-of-range year while typing shows "…", never "Clone 0 plans"', () => {
    renderClient();
    const input = document.getElementById('source_year') as HTMLInputElement;
    // "202" (mid-typing "2028") is < 2000 → out of range. It must read "…"
    // (unknown), NOT a misleading "0 plans".
    act(() => {
      fireEvent.change(input, { target: { value: '202' } });
    });
    expect(screen.queryByText(/Clone 0 plans/)).toBeNull();
    expect(screen.getByText('Clone … plans from 202 to 2027')).toBeTruthy();
  });

  it('#191: clearing the field on the default year keeps the count (same-value edit does not strand it at "…")', () => {
    renderClient();
    const input = document.getElementById('source_year') as HTMLInputElement;
    // On the default year (count 5), select-all-delete → parseInt('') || default
    // = the SAME year → setSourceYear is a no-op. The count must NOT blank: the
    // onChange only clears it when the year actually changes.
    act(() => {
      fireEvent.change(input, { target: { value: '' } });
    });
    expect(screen.getByText('Clone 5 plans from 2026 to 2027')).toBeTruthy();
    expect(cloneButton()).not.toBeDisabled();
  });

  it('editing the source year up then back to the default restores the count (up-then-back recovery)', () => {
    renderClient();
    const input = document.getElementById('source_year') as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: '2028' } });
    });
    expect(screen.getByText('Clone … plans from 2028 to 2027')).toBeTruthy();
    // Back to the default year within the debounce window: the effect keys on
    // the immediate sourceYear, so the default branch restores the count
    // synchronously — no stranded "…".
    act(() => {
      fireEvent.change(input, { target: { value: '2026' } });
    });
    expect(screen.getByText('Clone 5 plans from 2026 to 2027')).toBeTruthy();
    expect(cloneButton()).not.toBeDisabled();
  });
});
