/**
 * 108 T025 (US1, FR-003) — the "no primary contact" warning banner.
 *
 * When a member has no contact with `is_primary AND removed_at IS NULL`, every
 * money email for them is skipped. The skip is recorded in the audit log, but an
 * audit row is not a surface anyone watches: staff need to see, on the member
 * and on the invoice, that receipts are silently not going out — and they must
 * not be able to dismiss that away while it is still true.
 *
 * This file pins the contract the pages depend on: the alert role (so it is
 * announced, not merely coloured), the absence of any dismiss affordance, and
 * a route to the fix.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { NoPrimaryContactBanner } from '@/components/members/no-primary-contact-banner';

function renderBanner(props: { memberId: string; contactsHref?: string }) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <NoPrimaryContactBanner {...props} />
    </NextIntlClientProvider>,
  );
}

describe('NoPrimaryContactBanner (108 FR-003)', () => {
  it('is announced as an alert', () => {
    renderBanner({ memberId: 'member-1' });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('says plainly that payment emails are not being sent', () => {
    renderBanner({ memberId: 'member-1' });
    const alert = screen.getByRole('alert');
    // The copy has to name the CONSEQUENCE, not just the missing data — "no
    // primary contact" alone reads like a tidy-up task, not like lost receipts.
    expect(alert.textContent).toContain('No primary contact');
    expect(alert.textContent?.toLowerCase()).toContain('not being sent');
  });

  it('offers no way to dismiss it (it stays until the data is fixed)', () => {
    renderBanner({ memberId: 'member-1' });
    const alert = screen.getByRole('alert');
    expect(alert.querySelectorAll('button')).toHaveLength(0);
  });

  it('links to the member page when rendered away from it (the invoice page)', () => {
    renderBanner({ memberId: 'member-42', contactsHref: '/admin/members/member-42' });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/admin/members/member-42');
  });

  it('renders no link when it is already on the member page', () => {
    renderBanner({ memberId: 'member-1' });
    expect(screen.queryByRole('link')).toBeNull();
  });
});
