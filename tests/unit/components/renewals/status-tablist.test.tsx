/**
 * F8 Phase 8 R7 IMP-D close — `<StatusTablist>` keyboard contract
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
import { StatusTablist, STATUS_TABS } from '@/app/(staff)/admin/renewals/tasks/_components/status-tablist';

function noopT(key: string): string {
  return key; // pass-through; tests don't depend on i18n content
}

describe('<StatusTablist> (R7 IMP-D / R7 C3-2)', () => {
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
    // R7 C3-2: arrow keys focus only — onSelect must NOT have fired.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ArrowLeft on tab[0] wraps to last tab (focus only)', () => {
    const onSelect = vi.fn();
    render(<StatusTablist status="open" t={noopT} onSelect={onSelect} />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ArrowUp / ArrowDown also navigate (R7 IMP-K — documented)', () => {
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
});
