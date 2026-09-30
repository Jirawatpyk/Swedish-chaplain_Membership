/**
 * 122 US5b-2 (T572–T573) — the new / edit member page frame and the form's
 * core on AURA (boards `Admin-member-new`, `-edit`, each with `-mobile`):
 * Cancel at the top right from 1024px (the shell's back link below it), one
 * card per fieldset, the AURA error summary and the footer as an action bar
 * (pinned on phones, a right-aligned row from 640px).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberForm } from '@/components/members/member-form';
import { MemberFormFrame } from '@/app/(staff)/admin/members/_components/member-form-frame';

const T = enMessages.admin.members.create;

beforeEach(() => {
  // RHF async validation needs real timers (tests/setup.ts installs fake ones).
  vi.useRealTimers();
});

function renderForm(onCancel?: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={[]}
        defaultPlanYear={2026}
        onSubmit={vi.fn()}
        submitting={false}
        {...(onCancel ? { onCancel } : {})}
      />
    </NextIntlClientProvider>,
  );
}

describe('MemberFormFrame (T572)', () => {
  it('puts Cancel at the top right as an AURA secondary link, hidden below 1024px', () => {
    render(
      <MemberFormFrame title="Add member" subtitle="Create a member" cancelHref="/admin/members" cancelLabel="Cancel">
        <p>form</p>
      </MemberFormFrame>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Add member' })).toBeInTheDocument();
    const cancel = screen.getByRole('link', { name: 'Cancel' });
    expect(cancel).toHaveAttribute('href', '/admin/members');
    expect(cancel).toHaveClass('aura-btn--secondary');
    expect(cancel).toHaveClass('max-lg:hidden');
    expect(screen.getByText('form').closest('[data-slot="layout-container"][data-variant="form"]')).not.toBeNull();
  });
});

describe('MemberForm core (T573)', () => {
  it('shows each fieldset as its own card named by its heading', () => {
    renderForm();
    const contact = screen.getByRole('group', { name: T.sections.primaryContact });
    expect(contact).toHaveClass('aura-card');
    expect(within(contact).getByRole('heading', { level: 2, name: T.sections.primaryContact })).toBeInTheDocument();
  });

  it('puts Cancel then the submit button in one action bar', () => {
    renderForm(vi.fn());
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(bar).toHaveClass('chamber-viewport-actionbar');
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([T.cancel, T.submit]);
    expect(buttons[1]).toHaveAttribute('type', 'submit');
    expect(buttons[1]).toHaveClass('aura-btn--primary');
  });

  it('lists the failing fields in the AURA error summary, each named in bold', async () => {
    const { container } = renderForm();
    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);
    const heading = await screen.findByText(T.errorSummaryTitle);
    const summary = heading.closest('[role="alert"]');
    expect(summary).toHaveClass('aura-error-summary');
    const link = summary?.querySelector('a[href="#company_name"]');
    expect(link?.querySelector('strong')).toHaveTextContent(T.fields.companyName);
  });
});
