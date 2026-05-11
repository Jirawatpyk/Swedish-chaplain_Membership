/**
 * F8 Phase 4 Wave J4 (H13) — `<CycleCompanyCell>` unit tests.
 *
 * Pins the smart-feature #2 (at-risk visibility) regression net for
 * the `MailX` icon badge that surfaces `members.email_unverified`
 * directly on the pipeline row. Without this badge admins only learn
 * the email is unverified by clicking "Send reminder" and reading
 * the toast — by which point a T-30 cycle may have advanced to T+0.
 *
 * Test scope:
 *   1. Renders the company link without the icon when emailUnverified
 *      is false (default — most rows in production).
 *   2. Renders the icon + accessible label when emailUnverified=true.
 *   3. Falls back to the localised "(Unknown company)" placeholder
 *      when companyName is empty (existing behaviour, regression net).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CycleCompanyCell } from '@/components/renewals/cycle-cells';

const messages = {
  admin: {
    renewals: {
      table: {
        unknownCompany: '(Unknown company)',
        emailUnverifiedHint:
          'Email unverified — recent bounces detected; system reminders are paused until the contact email is updated and re-verified.',
      },
    },
  },
};

function renderCell(props: {
  memberId: string;
  companyName: string;
  emailUnverified?: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CycleCompanyCell {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<CycleCompanyCell>', () => {
  it('renders the company link without the email-unverified badge by default', () => {
    renderCell({
      memberId: 'm-1',
      companyName: 'Acme Co',
    });
    expect(screen.getByRole('link', { name: /Acme Co/ })).toBeDefined();
    expect(
      screen.queryByLabelText(/Email unverified/i),
    ).toBeNull();
  });

  it('renders the email-unverified badge with accessible label when emailUnverified=true', () => {
    renderCell({
      memberId: 'm-2',
      companyName: 'Bouncing Co',
      emailUnverified: true,
    });
    // Company link still rendered.
    expect(screen.getByRole('link', { name: /Bouncing Co/ })).toBeDefined();
    // Badge exposes the localised hint to screen readers via aria-label.
    const badge = screen.getByLabelText(/Email unverified/i);
    expect(badge).toBeDefined();
    // Native browser tooltip via title attr.
    expect(badge.getAttribute('title')).toMatch(/Email unverified/);
    // Role=img landmark so SR announces "image" not "graphic".
    expect(badge.getAttribute('role')).toBe('img');
  });

  it('falls back to localised "(Unknown company)" placeholder when companyName is empty', () => {
    renderCell({
      memberId: 'm-3',
      companyName: '',
    });
    expect(screen.getByText('(Unknown company)')).toBeDefined();
  });

  it('combines empty companyName + emailUnverified=true: shows fallback link AND badge', () => {
    renderCell({
      memberId: 'm-4',
      companyName: '',
      emailUnverified: true,
    });
    expect(screen.getByText('(Unknown company)')).toBeDefined();
    expect(screen.getByLabelText(/Email unverified/i)).toBeDefined();
  });
});
