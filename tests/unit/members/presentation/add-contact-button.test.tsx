/**
 * 122 US5b-1 (maintainer, 29 Sep) — "Add contact" keeps its word and its
 * outline at every width, like the page's other card-head buttons ("New
 * invoice"), though the phone board draws a bare +.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('@/components/members/contact-form-dialog', () => ({
  ContactFormDialog: ({ trigger }: { trigger: ReactElement }) => trigger,
}));

const { AddContactButton } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/add-contact-button'
);

describe('AddContactButton (122 US5b-1)', () => {
  it('shows "Add contact" as an outlined button at every width', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AddContactButton memberId="m-1" />
      </NextIntlClientProvider>,
    );
    const label = enMessages.admin.members.detail.contactActions.add;
    const button = screen.getByRole('button', { name: label });
    expect(button).toHaveClass('aura-btn--secondary');
    expect(button.className).not.toContain('border-transparent');
    expect(button.querySelector('.max-sm\\:sr-only')).toBeNull();
  });
});
