/**
 * ADMIN-6 (055-member-number) — MemberNumberField renders the formatted
 * member number and a copy button with the correct aria label.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MemberNumberField } from '@/components/members/member-number-field';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const messages = {
  admin: {
    members: {
      detail: {
        fields: { memberNumber: 'Member No.' },
        copy: { copyMemberNumber: 'Copy member number' },
      },
    },
  },
};

describe('MemberNumberField (admin detail)', () => {
  it('shows the formatted member number + a copy button', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MemberNumberField formatted="SCCM-0042" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('SCCM-0042')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy member number' }),
    ).toBeInTheDocument();
  });
});
