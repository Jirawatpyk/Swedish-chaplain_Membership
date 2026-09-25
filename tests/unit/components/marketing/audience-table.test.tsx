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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('pins column widths with table-fixed + a colgroup (6 cols read-only, 7 with the switch)', () => {
    const { container, unmount } = renderTable(false);
    const table = container.querySelector('table');
    expect(table?.className).toContain('table-fixed');
    expect(container.querySelectorAll('colgroup > col')).toHaveLength(6);
    unmount();
    const withSwitch = renderTable(true);
    expect(withSwitch.container.querySelectorAll('colgroup > col')).toHaveLength(7);
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

describe('AudienceTable — header wrap + column budget (cycle 14)', () => {
  it('every header cell may wrap (the primitive is nowrap; SV "REGLAGE" overflowed a 72-px column)', () => {
    const { container } = renderTable(true);
    const ths = Array.from(container.querySelectorAll('th'));
    expect(ths.length).toBe(7);
    for (const th of ths) expect(th.className).toContain('whitespace-normal');
  });
});

describe('AudienceTable — read-only viewer (cycle 15, FR-034/FR-035)', () => {
  it('canMarketing=false → the state badge, and NO switch anywhere', () => {
    renderTable(false);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(en.shared.marketing.state.off_by_staff)).toBeInTheDocument();
  });

  it('canMarketing=true → exactly one switch for the row', () => {
    renderTable(true);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });
});

/**
 * The content box the table lives in at a 1440-px viewport, read from the
 * tokens that build it rather than hard-coded: the expanded staff sidebar
 * (`SIDEBAR_WIDTH`), the `TableContainer` gutters (`--page-padding-x`) and
 * the `Card` gutters (`--card-padding`), less a 16-px allowance for a
 * classic vertical scrollbar.
 */
function contentWidthAt(viewport: number): number {
  const REM = 16;
  const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
  const sidebar = readFileSync(resolve(process.cwd(), 'src/components/ui/sidebar.tsx'), 'utf8');
  const rem = (re: RegExp, src: string): number => {
    const m = re.exec(src);
    if (!m?.[1]) throw new Error(`token not found: ${re}`);
    return Number(m[1]) * REM;
  };
  const sidebarWidth = rem(/const SIDEBAR_WIDTH = "([\d.]+)rem"/, sidebar);
  const pagePadding = rem(/--page-padding-x:\s*([\d.]+)rem/, css);
  const cardPadding = rem(/--card-padding:\s*([\d.]+)rem/, css);
  const SCROLLBAR = 16;
  return viewport - sidebarWidth - 2 * pagePadding - 2 * cardPadding - SCROLLBAR;
}

describe('AudienceTable — fits the staff content area at 1440 px', () => {
  it('the budget is read from real tokens (positive control)', () => {
    // 1440 − 256 sidebar − 2×24 page − 2×24 card − 16 scrollbar.
    expect(contentWidthAt(1440)).toBe(1072);
  });

  it.each([true, false])('canMarketing=%s → min-width fits without horizontal scroll', (canMarketing) => {
    const { container } = renderTable(canMarketing);
    const table = container.querySelector<HTMLElement>('table');
    const minWidth = Number.parseFloat(table?.style.minWidth ?? '');
    expect(Number.isFinite(minWidth)).toBe(true);
    expect(minWidth).toBeLessThanOrEqual(contentWidthAt(1440));
  });

  it('Contact flexes: its <col> has no fixed width; every other column does', () => {
    const { container } = renderTable(true);
    const cols = Array.from(container.querySelectorAll<HTMLElement>('colgroup > col'));
    expect(cols[0]?.style.width).toBe('');
    for (const col of cols.slice(1)) expect(col.style.width).toMatch(/px$/);
  });

  it('"Changed by" + "Changed" are ONE two-line column', () => {
    const { container } = renderTable(true);
    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toContain(t.columns.lastChange);
    const cell = screen.getByText('Staff Member').closest('td');
    expect(cell).not.toBeNull();
    expect(cell).toHaveTextContent('6 Sep 2026, 10:00');
  });

  it('Member and the reason lines wrap instead of widening the column', () => {
    const { container } = renderTable();
    const memberCell = screen.getByRole('link', { name: 'Acme AB' }).closest('td');
    expect(memberCell?.className).toContain('whitespace-normal');
    expect(screen.getByRole('link', { name: 'Acme AB' }).className).toContain('[overflow-wrap:anywhere]');
    expect(container.querySelector('ul')?.className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('AudienceTable — switch column never renders empty', () => {
  it('a contact-owned opt-out shows why there is no switch', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AudienceTable rows={[{ ...row, state: 'off_by_contact', reasons: ['off_by_contact'] }]} canMarketing />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    const note = screen.getByText(en.shared.marketing.switch.readOnly.contact);
    // The primitive's cell is `whitespace-nowrap`: without the override the
    // note ran straight across the Member column.
    expect(note.closest('td')?.className).toContain('whitespace-normal');
  });
});
