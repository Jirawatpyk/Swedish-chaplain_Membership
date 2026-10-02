/**
 * ADMIN-5 (055-member-number) — MembersTableSkeleton must have the live
 * table's shape (CLS 0, ux-standards § 2.1).
 *
 * 122 US5a: the skeleton is AURA's own `DataTable` in its loading state with
 * the real table's columns — the same headers, sizes and phone-card
 * breakpoint — plus the checkbox column when the admin table has one.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

function renderSkeleton(withSelection?: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MembersTableSkeleton {...(withSelection ? { withSelection } : {})} />
    </NextIntlClientProvider>,
  );
}

const COLUMNS = enMessages.admin.members.directory.columns;

describe('MembersTableSkeleton has the live table shape', () => {
  it('is an AURA grid with the real headers, stacked like the table below 640px', () => {
    const { container } = renderSkeleton();
    const grid = container.querySelector('.aura-table');
    expect(grid).not.toBeNull();
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent?.trim());
    expect(headers.slice(0, 7)).toEqual([
      COLUMNS.company,
      COLUMNS.memberNumber,
      COLUMNS.primaryContact,
      COLUMNS.plan,
      COLUMNS.status,
      COLUMNS.engagement,
      COLUMNS.lastActivity,
    ]);
    expect(headers).toHaveLength(8); // + the row-menu column
    expect(container.querySelectorAll('.aura-table__row--skeleton').length).toBe(15);
  });

  it('adds the checkbox column for the admin table', () => {
    const { container } = renderSkeleton(true);
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(9);
  });

  it('keeps keyboard focus out of the hidden placeholder (R15 axe aria-hidden-focus)', () => {
    // AURA's select-all header is tabbable; inside an aria-hidden subtree a
    // keyboard user could land on it while screen readers are told it is gone.
    const { getByTestId } = renderSkeleton(true);
    const skeleton = getByTestId('members-table-skeleton');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton).toHaveAttribute('inert');
  });
});

// The skeleton draws the list table as the page does: AURA's table, edge to
// edge inside the card (`bleed`), so nothing moves when the rows arrive.
describe('MembersTableSkeleton in the list card', () => {
  it('bleeds to the card edges like the table', () => {
    const { container } = renderSkeleton();
    expect(container.querySelector('.aura-bleed')).not.toBeNull();
  });
});
