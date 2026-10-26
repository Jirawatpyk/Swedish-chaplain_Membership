/**
 * DV-4 — closed-state guard for the admin <MemberPicker />.
 *
 * Asserts the surface that renders before anything is typed:
 *   - the placeholder when no member is selected
 *   - the selected company name when a value is set
 *   - `inputRef` resolving to the combobox <input> (the compose form
 *     focuses it on `broadcast_member_not_found`)
 *
 * Spec 122 US12d-3 (T1270): the picker is AURA's Combobox now, so the
 * placeholder and the chosen name are the input's own placeholder and value
 * rather than text in a trigger <button>. The search only runs once
 * something is typed, so no fetch mock is needed for these renders.
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
    loadingText: 'Loading members…',
  };

  it('shows the placeholder when no member is selected', () => {
    render(<MemberPicker {...baseProps} value={null} />);
    expect(screen.getByRole('combobox', { name: 'Member' })).toHaveAttribute(
      'placeholder',
      'Search by company name…',
    );
  });

  it('shows the selected company name', () => {
    render(
      <MemberPicker
        {...baseProps}
        value={{
          memberId: 'm-1',
          companyName: 'Acme AB',
          primaryContactName: 'Jo',
          hasPrimaryContactEmail: true,
        }}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Member' })).toHaveValue('Acme AB');
  });

  it('forwards inputRef to the combobox input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<MemberPicker {...baseProps} value={null} inputRef={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(screen.getByRole('combobox', { name: 'Member' }));
  });

  it('renders with a member that has no primary contact email (hasPrimaryContactEmail: false)', () => {
    // The MemberPicker renders the company name regardless of email presence;
    // the warning/disable logic lives in ProxyComposeForm. This test guards
    // that hasPrimaryContactEmail:false in the option does not crash the picker.
    render(
      <MemberPicker
        {...baseProps}
        value={{
          memberId: 'm-2',
          companyName: 'NoEmail Corp',
          primaryContactName: null,
          hasPrimaryContactEmail: false,
        }}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Member' })).toHaveValue('NoEmail Corp');
  });
});
