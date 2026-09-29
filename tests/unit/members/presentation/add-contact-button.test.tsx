/**
 * 122 US5b-1 (board `Admin-member-detail-mobile`; maintainer, 29 Sep) — on a
 * phone "Add contact" is a bare + in the Contacts card head: no border, the
 * word kept as its name. From 640px up it is the outlined "+ Add contact".
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
  it('is a borderless + on a phone that keeps "Add contact" as its name', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AddContactButton memberId="m-1" />
      </NextIntlClientProvider>,
    );
    const button = screen.getByRole('button', { name: enMessages.admin.members.detail.contactActions.add });
    expect(button).toHaveClass('aura-btn--secondary');
    expect(button.className).toContain('max-sm:border-transparent');
  });
});
