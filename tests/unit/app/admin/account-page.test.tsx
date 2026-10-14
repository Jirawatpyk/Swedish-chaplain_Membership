/**
 * Spec 122 US10c (T1025; board `Admin-account`, `-mobile`) — the staff
 * account page on AURA: the role is an AURA badge in the page header, styled
 * as on the users list (super admin solid with its shield), and the
 * change-password form sits in one AURA card under its explanation. The
 * board draws no second "Change password" heading inside the card — the page
 * h1 already says it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined), obj);
}

const { roleRef } = vi.hoisted(() => ({ roleRef: { role: 'super_admin' } }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => (key: string) => {
    const val = getPath(getPath(en as unknown, ns), key);
    return typeof val === 'string' ? val : `MISSING_KEY:${ns}.${key}`;
  }),
}));
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockImplementation(async () => ({
    user: { id: 'u1', role: roleRef.role, email: 'malin.berg@swecham.example' },
  })),
}));
// The client form (next-intl hooks have no provider here) — a marker.
vi.mock('@/components/auth/change-password-form', () => ({
  ChangePasswordForm: () => <form data-testid="change-password-form" />,
}));

import StaffAccountPage from '@/app/(staff)/admin/account/page';

const t = en.auth.changePassword;

async function renderPage(): Promise<HTMLElement> {
  const html = renderToStaticMarkup((await StaffAccountPage()) as ReactElement);
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

beforeEach(() => {
  roleRef.role = 'super_admin';
});

describe('staff account page on AURA', () => {
  it('shows the role as an AURA badge in the header, super admin solid as on the users list', async () => {
    const root = await renderPage();
    const badge = root.querySelector('.aura-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain(en.shell.roleBadge.super_admin);
    expect(badge!.className).toMatch(/solid/);
  });

  it('a plain admin gets the accent badge, without the shield', async () => {
    roleRef.role = 'admin';
    const root = await renderPage();
    const badge = root.querySelector('.aura-badge')!;
    expect(badge.textContent).toContain(en.shell.roleBadge.admin);
    expect(badge.className).toMatch(/accent/);
    expect(badge.querySelector('svg')).toBeNull();
  });

  it('puts the form in one AURA card under its explanation, with no second heading', async () => {
    const root = await renderPage();
    const card = root.querySelector('.aura-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(t.description);
    expect(card!.querySelector('[data-testid="change-password-form"]')).not.toBeNull();
    expect(card!.querySelector('h2, h3')).toBeNull();
  });

  // 200% text at 390: an address has no break opportunity, so it pushed the
  // page 39px sideways until it was allowed to break anywhere (WCAG 1.4.10).
  it('lets the email under the title break anywhere', async () => {
    const root = await renderPage();
    const email = [...root.querySelectorAll('span')].find((e) => e.textContent === 'malin.berg@swecham.example');
    expect(email).toBeDefined();
    expect(email!.className).toMatch(/\[overflow-wrap:anywhere\]/);
  });
});
