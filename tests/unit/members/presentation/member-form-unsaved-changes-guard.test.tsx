/**
 * PR-B task 9 — MemberForm unsaved-changes guard (`docs/ux-patterns.md § 4.2`
 * names "member edit" explicitly; PR-B roughly doubled the form's size, so
 * losing ~40 filled fields to a stray tab-close/refresh is a real, expensive
 * failure).
 *
 * Clone of the two established `beforeunload` guards
 * (`issue-invoice-form.tsx` T061f-form, `compose-form.tsx` UX-3): a listener
 * is attached ONLY while `formState.isDirty && !submitting`, so this test
 * exercises exactly those three states — pristine, dirty, dirty-but-
 * submitting — the same shape as
 * `tests/unit/app/admin/invoices/issue-invoice-form.test.tsx`
 * ("beforeunload dirty guard").
 */
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  // PR-B task 5 — CountryCombobox (rendered inside CompanySection) calls
  // useLocale() to resolve i18n-iso-countries' locale data; the minimal
  // mock above is a full replace (not `importOriginal` partial), so it
  // must also stub this export or the render throws.
  useLocale: () => 'en',
}));

import { MemberForm, type PlanOption } from '@/components/members/member-form';

const PLANS: PlanOption[] = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

function renderForm(submitting: boolean) {
  return render(
    <MemberForm
      plans={PLANS}
      defaultPlanYear={2026}
      onSubmit={() => undefined}
      submitting={submitting}
    />,
  );
}

describe('MemberForm — beforeunload unsaved-changes guard', () => {
  it('does not register a beforeunload listener while the form is pristine', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    try {
      renderForm(false);
      expect(addSpy.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(false);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('registers a beforeunload listener once a field is edited (dirty)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    try {
      const { container } = renderForm(false);
      fireEvent.change(container.querySelector('#company_name')!, {
        target: { value: 'Acme Co., Ltd.' },
      });
      expect(addSpy.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('removes the beforeunload listener once the form goes back to pristine (unmount cleanup)', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      const { container, unmount } = renderForm(false);
      fireEvent.change(container.querySelector('#company_name')!, {
        target: { value: 'Acme Co., Ltd.' },
      });
      unmount();
      expect(removeSpy.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('does not register a beforeunload listener while submitting, even if dirty', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    try {
      const { container } = renderForm(true);
      fireEvent.change(container.querySelector('#company_name')!, {
        target: { value: 'Acme Co., Ltd.' },
      });
      expect(addSpy.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(false);
    } finally {
      addSpy.mockRestore();
    }
  });
});
