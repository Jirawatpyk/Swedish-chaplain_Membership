import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QuickActions } from '@/app/(member)/portal/_components/quick-actions';

const messages = {
  portal: {
    dashboard: {
      quickActions: {
        title: 'Quick actions',
        pay: 'Pay invoice',
        benefits: 'View benefits',
        renew: 'Renew membership',
        editProfile: 'Edit profile',
      },
    },
  },
};

function renderActions(props: React.ComponentProps<typeof QuickActions>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Bangkok">
      <QuickActions {...props} />
    </NextIntlClientProvider>,
  );
}

describe('QuickActions', () => {
  it('renders Pay / Benefits / Edit always, and Renew only when due', () => {
    renderActions({ memberId: 'm1', renewDue: true });
    expect(screen.getByRole('link', { name: 'Pay invoice' })).toHaveAttribute(
      'href',
      '/portal/invoices',
    );
    expect(screen.getByRole('link', { name: 'View benefits' })).toHaveAttribute(
      'href',
      '/portal/benefits',
    );
    expect(screen.getByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/portal/edit',
    );
    expect(screen.getByRole('link', { name: 'Renew membership' })).toHaveAttribute(
      'href',
      '/portal/renewal/m1',
    );
  });

  it('hides the Renew tile when renewal is not due', () => {
    renderActions({ memberId: 'm1', renewDue: false });
    expect(screen.queryByRole('link', { name: 'Renew membership' })).not.toBeInTheDocument();
  });

  it('exposes an accessible group label via the section heading', () => {
    renderActions({ memberId: 'm1', renewDue: false });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Quick actions' }),
    ).toBeInTheDocument();
  });
});
