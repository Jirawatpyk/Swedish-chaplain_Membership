/**
 * ADMIN-5 (055-member-number) — MembersTableSkeleton column count must match
 * the live table (10 without selection, 11 with selection) after the
 * member-number column was added (ADMIN-4). Guards CLS-0 per ux-standards § 2.1.
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
  it('renders 10 header cells without selection (manager + baseline)', () => {
    const { container } = render(<MembersTableSkeleton />);
    expect(headerCellCount(container)).toBe(10);
  });

  it('renders 11 header cells with selection (admin)', () => {
    const { container } = render(<MembersTableSkeleton withSelection />);
    expect(headerCellCount(container)).toBe(11);
  });
});
