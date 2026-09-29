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
  ExportBackupButton: ({ className }: { className?: string }) => (
    <button type="button" className={className}>
      exportBackup
    </button>
  ),
}));

import MembersListPage, { renderMembersListView } from '@/app/(staff)/admin/members/page';

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

describe('/admin/members as on the boards (US5a)', () => {
  it('hides "Export backup" on a phone (board Admin-members-mobile)', async () => {
    const tree = await MembersListPage({ searchParams: Promise.resolve({}) });
    render(<PageHeader title="Members" actions={findPageHeaderActions(tree)} />);
    expect(screen.getByRole('button', { name: 'exportBackup' })).toHaveClass('max-sm:hidden');
  });

  it('puts the manager notice above the filters (board Admin-state-members-manager)', () => {
    render(
      renderMembersListView({
        title: 'Members',
        subtitle: 'sub',
        addMemberLabel: 'Add',
        canWrite: false,
        canBulk: false,
        readOnlyNotice: 'You can view members only.',
        body: <div data-testid="body">filters</div>,
      }),
    );
    const notice = screen.getByText('You can view members only.');
    expect(notice.compareDocumentPosition(screen.getByTestId('body')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
