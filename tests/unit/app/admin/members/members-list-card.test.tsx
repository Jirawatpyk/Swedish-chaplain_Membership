/**
 * Spec 122 (US8a T809) — the list card rule: a page whose main content is a
 * list frames its filters and table in one AURA card that drops its frame
 * below 640px, as Plans, Renewals and Invoices do (10 of the 14 list boards).
 * The members list drew its filters and table straight on the page; its
 * filtered and error states already used the card.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock('@/lib/rbac', () => ({ canPerform: vi.fn(), requirePagePermission: vi.fn() }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/members', () => ({}));
vi.mock('@/modules/members/members-deps', () => ({ buildMembersDeps: vi.fn() }));
vi.mock('@/modules/plans', () => ({ listPlans: vi.fn() }));
vi.mock('@/modules/plans/plans-deps', () => ({ buildPlansDeps: vi.fn() }));
vi.mock('@/modules/insights', () => ({ projectEngagementScore: vi.fn() }));
vi.mock('@/modules/renewals', () => ({}));
vi.mock('@/components/members/directory-filters', () => ({
  DirectoryFilters: () => <div data-testid="filters-stub" />,
}));
vi.mock('@/app/(staff)/admin/members/_components/directory-with-bulk', () => ({
  DirectoryWithBulk: () => <div data-testid="table-stub" />,
}));
vi.mock('@/app/(staff)/admin/members/_components/export-backup-button', () => ({ ExportBackupButton: () => null }));
vi.mock('@/components/members/members-table-skeleton', () => ({ MembersTableSkeleton: () => null }));

const { renderMembersDirectoryBody } = await import('@/app/(staff)/admin/members/page');

describe('members list card (list card rule)', () => {
  it('the list state frames the filters and the table in one card, frameless on a phone', () => {
    const tree = renderMembersDirectoryBody({
      plans: [],
      portalInviteCount: null,
      isAdmin: true,
      state: { kind: 'list', rows: [], page: 1, pageSize: 25, total: 0, filtered: false } as never,
    });
    const d = new DOMParser().parseFromString(renderToStaticMarkup(tree as ReactElement), 'text/html');
    const card = d.querySelector('[data-testid="filters-stub"]')?.closest('.aura-card');
    expect(card).not.toBeNull();
    expect(card?.className).toContain('aura-card--flush-below-sm');
    expect(card?.querySelector('[data-testid="table-stub"]')).not.toBeNull();
  });
});
