/**
 * `/admin/support` — the page every proxy kill-switch 503 names as
 * `supportUrl`. It existed only as a URL until R84 found it answered "Page not
 * available". Staff-only, gated like the dashboard; it gives the support
 * address and says what a paused change means.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { env } from '@/lib/env';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key} ${JSON.stringify(values)}` : `${ns}.${key}`,
  ),
}));
const requirePagePermission = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/lib/rbac', () => ({ requirePagePermission }));

import StaffSupportPage from '@/app/(staff)/admin/support/page';

describe('/admin/support', () => {
  it('is gated like the dashboard (every staff role)', async () => {
    render(await StaffSupportPage());
    expect(requirePagePermission).toHaveBeenCalledWith('dashboard.view');
  });

  it('heads the page and gives the support address as a mailto link', async () => {
    render(await StaffSupportPage());
    expect(screen.getByRole('heading', { level: 1, name: 'admin.support.title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'admin.support.contact.title' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: env.supportEmail })).toHaveAttribute(
      'href',
      `mailto:${env.supportEmail}`,
    );
    expect(screen.getByText('admin.support.contact.includeId')).toBeInTheDocument();
  });

  it('explains a paused change first: maintenance, a feature switched off, and that nothing changed', async () => {
    render(await StaffSupportPage());
    expect(screen.getByRole('heading', { level: 2, name: 'admin.support.paused.title' })).toBeInTheDocument();
    // The retry window is the proxy's own Retry-After (300 s), in minutes.
    expect(screen.getByText('admin.support.paused.maintenance {"minutes":5}')).toBeInTheDocument();
    expect(screen.getByText('admin.support.paused.featureOff')).toBeInTheDocument();
    expect(screen.getByText('admin.support.paused.nothingChanged')).toBeInTheDocument();
    // What happened comes before who to contact (a refused action brought them here).
    const [first, second] = screen.getAllByRole('heading', { level: 2 });
    expect(first).toHaveTextContent('admin.support.paused.title');
    expect(second).toHaveTextContent('admin.support.contact.title');
  });
});
