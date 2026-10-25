/**
 * The staff maintenance banner (board `State-maintenance`): while
 * READ_ONLY_MODE is on, every staff page says changes are paused and links to
 * `/admin/support`. Before it, staff learned of the freeze only by being
 * refused. Advisory, like the portal's banner: null while writable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const readOnly = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/env', () => ({
  env: {
    get flags() {
      return { readOnlyMode: readOnly.value };
    },
  },
}));
const pathname = vi.hoisted(() => ({ value: '/admin' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string) => `${ns}.${key}`),
}));

import { StaffReadOnlyBanner } from '@/components/layout/staff-read-only-banner';

afterEach(() => {
  readOnly.value = false;
  pathname.value = '/admin';
});

describe('<StaffReadOnlyBanner>', () => {
  it('renders nothing while writes are open', async () => {
    expect(await StaffReadOnlyBanner()).toBeNull();
  });

  it('says changes are paused and links to Help and support while READ_ONLY_MODE is on', async () => {
    readOnly.value = true;
    render((await StaffReadOnlyBanner())!);
    expect(screen.getByRole('status')).toHaveTextContent('admin.maintenanceBanner.title');
    expect(screen.getByText('admin.maintenanceBanner.body')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'admin.maintenanceBanner.help' })).toHaveAttribute(
      'href',
      '/admin/support',
    );
  });

  it('stays off the help page itself, which states the pause in its own status', async () => {
    readOnly.value = true;
    pathname.value = '/admin/support';
    render((await StaffReadOnlyBanner())!);
    expect(screen.queryByTestId('staff-read-only-banner')).not.toBeInTheDocument();
  });
});
