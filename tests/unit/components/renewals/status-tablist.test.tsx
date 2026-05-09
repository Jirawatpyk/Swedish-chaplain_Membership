/**
 * F8 Phase 8 R8 IMP-D close — `<StatusTablist>` keyboard contract
 * unit tests. Pins the ARIA APG composite-widget tablist contract:
 *   - Roving tabIndex (selected=0, others=-1)
 *   - ArrowLeft/Right (and Up/Down) wrap-around focus
 *   - Home / End jumps
 *   - Manual activation: Arrow keys do NOT trigger `onSelect`;
 *     only click / Enter / Space (Button default) does
 *   - Focused-but-not-selected tab gets the SF-A visual ring class
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { useTranslations } from 'next-intl';
import { StatusTablist, STATUS_TABS } from '@/app/(staff)/admin/renewals/tasks/_components/status-tablist';

// R8 R4-IMP-2 close — tests pass a stub translator since they don't
// exercise the rich/markup/raw/has methods. Cast at the boundary so
// the strict ReturnType<typeof useTranslations<...>> is satisfied.
const noopT = ((key: string) => key) as unknown as ReturnType<
  typeof useTranslations<'admin.renewals.tasks'>
>;

describe('<StatusTablist> (R8 IMP-D / R8 C3-2)', () => {
  it('selected tab has tabIndex=0; others have tabIndex=-1', () => {
    render(<StatusTablist status="open" t={noopT} onSelect={vi.fn()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(STATUS_TABS.length);
    const openTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(openTab?.getAttribute('tabindex')).toBe('0');
    const others = tabs.filter((t) => t.getAttribute('aria-selected') === 'false');
    others.forEach((t) => expect(t.getAttribute('tabindex')).toBe('-1'));
  });

  it('ArrowRight on selected tab moves focus, NOT activation (manual activation)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    // R8 C3-2: arrow keys focus only — onSelect must NOT have fired.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ArrowLeft on tab[0] wraps to last tab (focus only)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ArrowUp / ArrowDown also navigate (R8 IMP-K — documented)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Home / End jump to first / last tab (focus only)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'Home' });
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('click activates the tab (onSelect fires with the clicked tab)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    // The displayed text is the t(key) pass-through: "status_tab.done".
    const doneTab = screen
      .getAllByRole('tab')
      .find((t) => t.textContent?.includes('status_tab.done'));
    expect(doneTab).toBeDefined();
    fireEvent.click(doneTab!);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('done');
  });

  it('Enter on focused tab activates (Button default click handler)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    const skippedTab = screen
      .getAllByRole('tab')
      .find((t) => t.textContent?.includes('status_tab.skipped'));
    expect(skippedTab).toBeDefined();
    skippedTab!.focus();
    // base-ui Button accepts Enter as click via native button semantics.
    fireEvent.keyDown(skippedTab!, { key: 'Enter' });
    fireEvent.click(skippedTab!);
    expect(onSelect).toHaveBeenCalled();
    expect(onSelect).toHaveBeenLastCalledWith('skipped');
  });

  it('SF-A: focused-but-not-selected tab gets data-focused attribute', () => {
    render(<StatusTablist status="open" t={noopT} onSelect={vi.fn()} />);
    const doneTab = screen
      .getAllByRole('tab')
      .find((t) => t.textContent?.includes('status_tab.done'));
    expect(doneTab).toBeDefined();
    fireEvent.focus(doneTab!);
    expect(doneTab!.getAttribute('data-focused')).toBe('true');
    // Selected open tab should NOT have data-focused even when its
    // index matches focusedIdx.
    const openTab = screen
      .getAllByRole('tab')
      .find((t) => t.getAttribute('aria-selected') === 'true');
    expect(openTab?.getAttribute('data-focused')).toBeNull();
  });

  it('each tab has a stable id matching task-status-tab-<key>', () => {
    render(<StatusTablist status="open" t={noopT} onSelect={vi.fn()} />);
    expect(document.getElementById('task-status-tab-open')).not.toBeNull();
    expect(document.getElementById('task-status-tab-done')).not.toBeNull();
    expect(document.getElementById('task-status-tab-skipped')).not.toBeNull();
  });

  // R8 close (Round 4 test gap) — pin the onBlur handler that
  // clears focusedIdx when focus leaves the tablist. Without this,
  // a future refactor that drops the relatedTarget guard would
  // leave a stale `data-focused` ring on a tab the user has tabbed
  // out of (visual regression for SF-A focus-state cue).
  it('onBlur clears data-focused when focus leaves the tablist', () => {
    render(<StatusTablist status="open" t={noopT} onSelect={vi.fn()} />);
    const doneTab = screen
      .getAllByRole('tab')
      .find((t) => t.textContent?.includes('status_tab.done'));
    expect(doneTab).toBeDefined();
    fireEvent.focus(doneTab!);
    expect(doneTab!.getAttribute('data-focused')).toBe('true');
    // Blur to a node OUTSIDE the tablist (relatedTarget=document.body
    // simulates Tab-out to the next page element).
    fireEvent.blur(doneTab!, { relatedTarget: document.body });
    expect(doneTab!.getAttribute('data-focused')).toBeNull();
  });
});
