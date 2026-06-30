/**
 * MemberForm error summary (audit XF-09).
 *
 * A long form (~15 fields) must surface a focusable error summary at the top
 * on a failed submit with >1 error (ux-standards § 11.3), each row a link that
 * jumps to the offending field. Single-error submits stay inline-only (covered
 * by member-form-server-field-error.test.tsx). Rendered against real en.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberForm } from '@/components/members/member-form';

beforeEach(() => {
  // RHF async validation needs real timers (tests/setup.ts installs fake ones).
  vi.useRealTimers();
});

describe('MemberForm error summary (XF-09)', () => {
  it('renders a focusable summary with jump links when >1 field fails on submit', async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={[]}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
        />
      </NextIntlClientProvider>,
    );
    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    // Empty submit fails company_name, plan_id, first/last name, email (>1).
    const heading = await screen.findByText(
      'Please fix the following before continuing:',
    );
    const region = heading.closest('[role="alert"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('tabindex')).toBe('-1');

    const links = region?.querySelectorAll('a[href^="#"]') ?? [];
    expect(links.length).toBeGreaterThan(1);
    // The first required field is anchored so the link jumps straight to it.
    expect(region?.querySelector('a[href="#company_name"]')).not.toBeNull();
  });
});
