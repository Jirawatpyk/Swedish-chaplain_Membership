/**
 * 108 PR-D review cycle 11 (UX M1 / M3 / L8, a11y 4 / 8 / 12) — `AudienceTable`
 * structure pins.
 *
 *   - the scrollable region is named in the viewer's locale (`aria-label` on
 *     the `Table` primitive → its `role="region"` wrapper), not the primitive's
 *     English "Data table" fallback;
 *   - `table-fixed` + an explicit `<colgroup>` so the header does not shift
 *     every time a filter changes the rows (same recipe as the members table);
 *   - the reasons list keeps list semantics under Tailwind preflight
 *     (`role="list"`);
 *   - the member link reads as a link at rest (`text-primary`), and the email
 *     wraps at any point instead of `break-all`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

// The switch column mounts `MarketingSwitch`, which reads the app router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import {
  AudienceTable,
  type AudienceTableRow,
} from '@/app/(staff)/admin/marketing/audience/_components/audience-table';

const t = en.admin.marketing.audience;

const row: AudienceTableRow = {
  contactId: 'c-1',
  memberId: '11111111-1111-4111-8111-111111111111',
  companyName: 'Acme AB',
  contactName: 'Jane Doe',
  email: 'jane.doe@example.com',
  isPrimary: false,
  memberStatus: 'active',
  memberHalted: false,
  memberErased: false,
  state: 'off_by_staff',
  reasons: ['off_by_staff'],
  changedBy: 'Staff Member',
  changedAt: '6 Sep 2026, 10:00',
};

function renderTable(canMarketing = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AudienceTable rows={[row]} canMarketing={canMarketing} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('AudienceTable — structure (cycle 11)', () => {
  it('names the scrollable region in the viewer locale, never "Data table"', () => {
    renderTable();
    expect(screen.getByRole('region', { name: t.tableCaption })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Data table' })).toBeNull();
  });

  it('pins column widths with table-fixed + a colgroup (7 cols read-only, 8 with the switch)', () => {
    const { container, unmount } = renderTable(false);
    const table = container.querySelector('table');
    expect(table?.className).toContain('table-fixed');
    expect(container.querySelectorAll('colgroup > col')).toHaveLength(7);
    unmount();
    const withSwitch = renderTable(true);
    expect(withSwitch.container.querySelectorAll('colgroup > col')).toHaveLength(8);
  });

  it('keeps list semantics on the reasons list', () => {
    const { container } = renderTable();
    const list = container.querySelector('ul');
    expect(list).toHaveAttribute('role', 'list');
  });

  it('the member link is visibly a link at rest; the email wraps anywhere', () => {
    renderTable();
    const link = screen.getByRole('link', { name: 'Acme AB' });
    expect(link.className).toContain('text-primary');
    const email = screen.getByText('jane.doe@example.com');
    expect(email.className).not.toContain('break-all');
    expect(email.className).toContain('[overflow-wrap:anywhere]');
  });
});
