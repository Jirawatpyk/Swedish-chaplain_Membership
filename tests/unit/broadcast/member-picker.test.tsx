/**
 * DV-4 — closed-state guard for the admin <MemberPicker />.
 *
 * Base UI / cmdk popovers deadlock under jsdom + React 19 (documented in
 * tests/unit/broadcasts/components/approve-reject-final-focus.test.ts), so
 * this suite NEVER opens the Popover. It asserts only the trigger-button
 * surface that renders in the closed state:
 *   - placeholder text when no member is selected
 *   - the selected company name when a value is set
 *   - `triggerRef` resolving to the trigger <button> (the compose form
 *     focuses it on `broadcast_member_not_found`)
 *
 * The data-fetching effect only fires when `open === true`, so no fetch
 * mock is needed for the closed-state render.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createRef } from 'react';
import { MemberPicker } from '@/components/broadcast/member-picker';

afterEach(() => cleanup());

describe('MemberPicker (closed-state guard)', () => {
  const baseProps = {
    onSelect: vi.fn(),
    label: 'Member',
    placeholder: 'Search by company name…',
    searchFailedText: 'Search failed',
    emptyText: 'No members',
  };

  it('shows the placeholder when no member is selected', () => {
    render(<MemberPicker {...baseProps} value={null} />);
    expect(screen.getByText('Search by company name…')).toBeInTheDocument();
  });

  it('shows the selected company name', () => {
    render(
      <MemberPicker
        {...baseProps}
        value={{ memberId: 'm-1', companyName: 'Acme AB', primaryContactName: 'Jo' }}
      />,
    );
    expect(screen.getByText('Acme AB')).toBeInTheDocument();
  });

  it('forwards triggerRef to the trigger button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<MemberPicker {...baseProps} value={null} triggerRef={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
