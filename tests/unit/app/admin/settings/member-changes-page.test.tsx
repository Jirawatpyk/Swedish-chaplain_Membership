/**
 * Spec 122 US10c (T1024; board `Admin-settings-member-changes`) — the
 * member-change approval page frame on AURA: one AURA card titled "Approval
 * requirement" (an h2 under the page h1) with its intro, and the switch inside
 * it. The switch's own behaviour is pinned by approval-switch.test.tsx.
 *
 * The async RSC default export is invoked directly with mocked boundaries and
 * rendered with renderToStaticMarkup (same approach as audit-page-frame).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined), obj);
}

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => (key: string) => {
    const val = getPath(getPath(en as unknown, ns), key);
    return typeof val === 'string' ? val : `MISSING_KEY:${ns}.${key}`;
  }),
}));
vi.mock('@/lib/env', () => ({ env: { features: { memberChangeApproval: true } } }));
vi.mock('@/lib/rbac', () => ({ requirePagePermission: vi.fn().mockResolvedValue({ user: { id: 'u1', role: 'admin' } }) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-1' }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/members-change-request-deps', () => ({
  buildChangeRequestDeps: () => ({
    tenantMemberChangeSettings: {
      readInTenant: async () => ({ ok: true, value: { memberChangeApprovalEnabled: true } }),
    },
  }),
}));
vi.mock('@/modules/members', () => ({
  countPendingChangeRequests: async () => ({ ok: true, value: { count: 3 } }),
}));
// The client switch (next-intl hooks have no provider here) — a marker that
// shows where it sits and what it was given.
vi.mock('@/app/(staff)/admin/settings/member-changes/_components/approval-switch', () => ({
  ApprovalSwitch: (p: { initialEnabled: boolean; pendingCount: number }) => (
    <div data-testid="approval-switch" data-enabled={String(p.initialEnabled)} data-pending={p.pendingCount} />
  ),
}));

import MemberChangesSettingsPage from '@/app/(staff)/admin/settings/member-changes/page';

const t = en.admin.settings.memberChanges;

async function renderPage(): Promise<HTMLElement> {
  const html = renderToStaticMarkup((await MemberChangesSettingsPage()) as ReactElement);
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('member-change approval page on AURA', () => {
  it('puts the switch in one AURA card titled "Approval requirement" (h2) with its intro', async () => {
    const root = await renderPage();
    const card = root.querySelector('.aura-card');
    expect(card).not.toBeNull();
    const heading = card!.querySelector('h2');
    expect(heading?.textContent).toBe(t.title);
    expect(card!.textContent).toContain(t.cardDescription);
    const sw = card!.querySelector('[data-testid="approval-switch"]');
    expect(sw?.getAttribute('data-enabled')).toBe('true');
    expect(sw?.getAttribute('data-pending')).toBe('3');
  });
});
