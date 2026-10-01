/**
 * `renderSchedulesStateView` — 122 US7b-2 (T738): the reminder schedules
 * page's two non-editor states as AURA alerts, shared with the preview.
 * Renewals switched off reads as an info status; a failed read is a danger
 * alert with Retry, Go back and the reference id.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { renderSchedulesStateView } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedules-state-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const scope = ns.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en);
    return (key: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], scope) as string;
  },
}));

const R = en.admin.renewals;

async function renderView(props: Parameters<typeof renderSchedulesStateView>[0]) {
  const view = (await renderSchedulesStateView(props)) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {view}
    </NextIntlClientProvider>,
  );
}

describe('renderSchedulesStateView', () => {
  it('says renewals are switched off in an AURA info status', async () => {
    await renderView({ kind: 'disabled' });
    const alert = screen.getByText(R.error.featureDisabled).closest('.aura-alert');
    expect(alert).toHaveClass('aura-alert--info');
    expect(alert).toHaveAttribute('role', 'status');
  });

  it('shows a failed read as an AURA danger alert with Retry, Go back and the reference', async () => {
    await renderView({ kind: 'failed', correlationId: 'ref-1234' });
    const alert = screen.getByText(R.error.loadFailed).closest('.aura-alert');
    expect(alert).toHaveClass('aura-alert--danger');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: R.error.retry })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: R.error.goBack })).toHaveAttribute('href', '/admin/renewals');
    expect(screen.getByText(/ref-1234/)).toBeInTheDocument();
  });
});
