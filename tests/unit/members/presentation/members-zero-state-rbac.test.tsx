/**
 * `MembersZeroState` × RBAC — the "Add your first member" CTA links to
 * `/admin/members/new`, which is gated on `members.write`. A manager
 * (`members.read` only) who followed it hit a 404, so the CTA must follow
 * the SAME evaluated permission as its target page and fall back to a
 * plain hint when the viewer cannot add members.
 *
 * The permission comes from the evaluator, never from `ROLE_BUNDLES` —
 * super-admin keys are granted by the evaluator, not the bundle.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * React rendering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { MembersZeroState } from '@/components/members/empty-states';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';

beforeEach(() => vi.useRealTimers());

const copy = en.admin.members.emptyStates.zero;

function renderAs(role: 'manager' | 'admin') {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MembersZeroState canAddMember={hasPermission(role, 'members.write')} />
    </NextIntlClientProvider>,
  );
}

describe('MembersZeroState × members.write', () => {
  it('manager: no "Add your first member" link — shows the admin-only hint instead', () => {
    renderAs('manager');
    expect(screen.queryByRole('link', { name: copy.cta })).toBeNull();
    expect(screen.getByText(copy.adminOnlyHint)).toBeInTheDocument();
  });

  it('admin: the CTA links to /admin/members/new and no hint is shown', () => {
    renderAs('admin');
    expect(screen.getByRole('link', { name: copy.cta })).toHaveAttribute(
      'href',
      '/admin/members/new',
    );
    expect(screen.queryByText(copy.adminOnlyHint)).toBeNull();
  });
});
