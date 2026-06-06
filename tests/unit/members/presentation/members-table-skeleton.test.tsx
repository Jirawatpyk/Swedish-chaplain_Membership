/**
 * ADMIN-5 (055-member-number) — MembersTableSkeleton column count must match
 * the live table. Guards CLS-0 per ux-standards § 2.1.
 *
 * 056-members-table-compact: the directory was reduced to a lean 8-column
 * layout, so the skeleton now renders 7 cells without selection and 8 with
 * selection (down from 11/12).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

function headerCellCount(container: HTMLElement): number {
  // The header row is the first grid; count its Skeleton children (div elements).
  const grids = container.querySelectorAll('div.grid');
  return grids[0]!.querySelectorAll('div').length;
}

describe('MembersTableSkeleton column count matches the live table', () => {
  it('renders 7 header cells without selection (manager + baseline)', () => {
    const { container } = render(<MembersTableSkeleton />);
    expect(headerCellCount(container)).toBe(7);
  });

  it('renders 8 header cells with selection (admin)', () => {
    const { container } = render(<MembersTableSkeleton withSelection />);
    expect(headerCellCount(container)).toBe(8);
  });
});
