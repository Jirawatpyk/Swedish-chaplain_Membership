/**
 * Record-payment date clamp must use the TENANT-timezone "today"
 * (Asia/Bangkok), supplied by the server as the `todayIso` prop —
 * NOT a client-side `new Date().toISOString()` (UTC).
 *
 * Regression: during 17:00–23:59 UTC (= 00:00–06:59 Asia/Bangkok) an
 * invoice issued that Bangkok-day has `issue_date` one calendar day
 * AHEAD of the UTC date. The native `<input type="date">` was clamped
 * `min={issueDate}` (Bangkok) but `max={UTC today}`, yielding
 * `min > max` → the input has NO satisfiable value → the form silently
 * refuses to submit (record manual/offline payment becomes impossible
 * for ~7h every day). Fix threads a server-computed Bangkok-local
 * `todayIso` so `min ≤ max` always holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PaymentForm } from '@/app/(staff)/admin/invoices/_components/payment-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// tests/setup.ts installs global fake timers; the date-seeding effect
// + RTL effect flush need real timers.
beforeEach(() => {
  vi.useRealTimers();
});

function renderForm(props: { issueDate: string | null; todayIso: string }) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PaymentForm
        invoiceId="11111111-1111-4111-8111-111111111111"
        documentNumber="SC-2026-000048"
        issueDate={props.issueDate}
        todayIso={props.todayIso}
      />
    </NextIntlClientProvider>,
  );
}

describe('PaymentForm date clamp (tenant-TZ today)', () => {
  it('clamps max + default to the server-provided todayIso, not client UTC', () => {
    // todayIso is a fixed far-future date that can never equal the real
    // UTC "now": if the component still used new Date() the assertions
    // below would read a 2026-xx-xx UTC date and fail.
    const { container } = renderForm({
      issueDate: '2030-03-14',
      todayIso: '2030-03-15',
    });
    const date = container.querySelector('#date') as HTMLInputElement | null;
    if (!date) throw new Error('payment date input did not render');

    expect(date.getAttribute('min')).toBe('2030-03-14'); // issue date (lower bound)
    expect(date.getAttribute('max')).toBe('2030-03-15'); // tenant-TZ today, NOT UTC
    expect(date.value).toBe('2030-03-15'); // default = tenant-TZ today
  });

  it('same-day issue (issueDate === todayIso) keeps min ≤ max (the bug scenario)', () => {
    const { container } = renderForm({
      issueDate: '2030-03-15',
      todayIso: '2030-03-15',
    });
    const date = container.querySelector('#date') as HTMLInputElement | null;
    if (!date) throw new Error('payment date input did not render');

    const min = date.getAttribute('min');
    const max = date.getAttribute('max');
    expect(min).toBe('2030-03-15');
    expect(max).toBe('2030-03-15');
    // min ≤ max ⇒ a satisfiable value exists ⇒ form is submittable.
    expect(min! <= max!).toBe(true);
    expect(date.value).toBe('2030-03-15');
  });
});

describe('PaymentForm out-of-range date feedback (not native-only)', () => {
  it('shows an app inline error + aria-invalid on submit with an out-of-range date', async () => {
    const { container } = renderForm({
      issueDate: '2030-03-14',
      todayIso: '2030-03-15',
    });
    const date = container.querySelector('#date') as HTMLInputElement | null;
    const form = container.querySelector('form');
    if (!date || !form) throw new Error('payment form did not render');

    // Pick a future date (> max) — out of [min, max].
    fireEvent.change(date, { target: { value: '2030-03-20' } });
    fireEvent.submit(form);

    // App-rendered inline error (role=alert), NOT just the browser's
    // native validation bubble.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/payment date must be on or after/i);
    expect(alert.textContent).toContain('2030-03-15'); // the {max} bound
    // a11y: the field is marked invalid + points at the error.
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(date.getAttribute('aria-describedby') ?? '').toContain('date-error');
  });
});
