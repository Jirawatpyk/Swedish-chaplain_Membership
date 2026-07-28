/**
 * Review-fix I-1 (enterprise-ux, Wave 2 Task 5) — `MarkPaidOfflineDialog`
 * must show WHICH member/company is being settled when opened from the
 * pipeline table's row ⋯ menu: a money mutation (mints a §86/4 tax invoice
 * + completes the cycle) offered no in-dialog confirmation of identity on a
 * dense table. Mirrors the sibling "Mark contacted" dialog (`OutreachDialog`)
 * in the same ⋯ menu, which already shows the company name.
 *
 * Render-only test (no submit click): passing `open` directly to a
 * controlled Base UI Dialog is safe under jsdom — see
 * `plan-change-confirm-dialog.test.tsx`. Only a click-through submit flow
 * with `startTransition` deadlocks (the dialog-jsdom-hang memory documented
 * in `cycle-admin-actions.test.tsx`), which this test does not exercise.
 *
 * The cycle-detail caller (`cycle-admin-actions.tsx`) passes NO
 * `companyName` prop at all — the "without companyName" case below pins
 * that the dialog body stays exactly as it was pre-fix for that caller
 * (behaviour-preserving).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MarkPaidOfflineDialog } from '@/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const CYCLE_ID = '11111111-1111-1111-1111-111111111111';

function renderWithCompany(companyName: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkPaidOfflineDialog
        cycleId={CYCLE_ID}
        open
        onOpenChange={() => {}}
        companyName={companyName}
      />
    </NextIntlClientProvider>,
  );
}

function renderWithoutCompany() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MarkPaidOfflineDialog cycleId={CYCLE_ID} open onOpenChange={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe('MarkPaidOfflineDialog — I-1 member-identity confirmation', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => cleanup());

  it('shows the company name when opened from the pipeline row ⋯ menu', () => {
    renderWithCompany('Acme Co., Ltd.');
    expect(screen.getByText('For Acme Co., Ltd.')).toBeInTheDocument();
  });

  it('renders nothing extra when companyName is absent (cycle-detail caller)', () => {
    renderWithoutCompany();
    expect(screen.queryByText(/^For /)).toBeNull();
  });
});
