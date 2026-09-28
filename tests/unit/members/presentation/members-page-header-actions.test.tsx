/**
 * `/admin/members` scrolled sideways on a 360 / 390 px phone in Swedish: the
 * two header actions ("Exportera säkerhetskopia", "Lägg till medlem") sat in
 * their own `flex` row with no wrap, so PageHeader's wrapping actions row saw
 * one child that could not shrink. The actions must reach PageHeader as its
 * direct children so its `flex-wrap` / full-width-on-phone rule applies.
 */
import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '@/components/layout/page-header';

vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue({ user: { role: 'admin' } }),
  canPerform: () => true,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/app/(staff)/admin/members/_components/export-backup-button', () => ({
  ExportBackupButton: () => <button type="button">exportBackup</button>,
}));

import MembersListPage from '@/app/(staff)/admin/members/page';

function findPageHeaderActions(node: ReactNode): ReactNode {
  if (!isValidElement(node)) return undefined;
  const el = node as ReactElement<{ actions?: ReactNode; children?: ReactNode }>;
  if (el.type === PageHeader) return el.props.actions;
  const kids = el.props.children;
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const hit = findPageHeaderActions(child);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe('/admin/members header actions', () => {
  it('reach PageHeader as direct children of its wrapping actions row', async () => {
    const tree = await MembersListPage({ searchParams: Promise.resolve({}) });
    const actions = findPageHeaderActions(tree);
    render(<PageHeader title="Members" actions={actions} />);

    const row = document.querySelector('[data-slot="page-header-actions"]');
    expect(screen.getByRole('link', { name: /addMember/ }).parentElement).toBe(row);
    expect(screen.getByRole('button', { name: 'exportBackup' }).parentElement).toBe(row);
  });
});
