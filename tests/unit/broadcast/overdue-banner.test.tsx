/**
 * Task 3 (2026-08-01-broadcast-review-queue-pr1) — `OverdueBanner`.
 *
 * Mirrors the shipped erasure-log breach banner
 * (`src/app/(staff)/admin/compliance/erasure-log/page.tsx:179-184`):
 * a destructive `role="alert"` div rendered only when there is an
 * overdue count to report. `OverdueBanner` uses `useTranslations`
 * (sync, RSC-safe — no `next-intl/server` mock needed), so this test
 * renders it under `NextIntlClientProvider` with the real `en.json`
 * messages (like the erasure-log breach-banner tests), not the
 * `vi.mock('next-intl/server')` pattern used for async Server
 * Components such as `SlaBanner`.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { OverdueBanner } from '@/components/broadcast/admin/overdue-banner';

function renderBanner(count: number) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <OverdueBanner count={count} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('OverdueBanner', () => {
  it('renders nothing when count is 0', () => {
    const { container } = renderBanner(0);
    expect(container.firstChild).toBeNull();
  });
  it('renders a destructive alert with the count when > 0', () => {
    renderBanner(3);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/3 broadcasts have been waiting over 48 hours/);
    expect(alert.className).toContain('bg-destructive-surface');
  });
});
