import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { Stepper, type StepperStep } from '@/components/ui/stepper';

const steps: StepperStep[] = [
  { id: 'confirm', label: 'Confirm', status: 'complete' },
  { id: 'authorize', label: 'Authorize', status: 'current', description: '3DS challenge' },
  { id: 'done', label: 'Done', status: 'upcoming' },
];

describe('<Stepper>', () => {
  it('renders as an ordered list with the provided aria-label', () => {
    render(<Stepper steps={steps} aria-label="Payment flow" />);
    const list = screen.getByRole('list', { name: 'Payment flow' });
    expect(list.getAttribute('data-slot')).toBe('stepper');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('marks the current step with aria-current=step', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[2]!.getAttribute('aria-current')).toBeNull();
  });

  it('exposes data-status per step for styling and tests', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.getAttribute('data-status')).toBe('complete');
    expect(items[1]!.getAttribute('data-status')).toBe('current');
    expect(items[2]!.getAttribute('data-status')).toBe('upcoming');
  });

  it('renders a check icon for completed steps and index number otherwise', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    const items = screen.getAllByRole('listitem');
    // Completed — has an svg (lucide Check)
    expect(items[0]!.querySelector('svg')).not.toBeNull();
    // Current — shows "2"
    expect(within(items[1]!).getByText('2')).toBeDefined();
    // Upcoming — shows "3"
    expect(within(items[2]!).getByText('3')).toBeDefined();
  });

  it('renders the step description when provided', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    expect(screen.getByText('3DS challenge')).toBeDefined();
  });

  it('supports vertical orientation via data-orientation attribute', () => {
    render(<Stepper steps={steps} aria-label="Flow" orientation="vertical" />);
    const list = screen.getByRole('list');
    expect(list.getAttribute('data-orientation')).toBe('vertical');
  });

  // F2 polish round 2 — `status='error'` variant
  it('renders an error step with AlertCircle icon + aria-invalid + destructive label class', () => {
    const stepsWithError: StepperStep[] = [
      { id: 'basics', label: 'Basics', status: 'complete' },
      { id: 'fees', label: 'Fees', status: 'error' },
      { id: 'review', label: 'Review', status: 'upcoming' },
    ];
    render(<Stepper steps={stepsWithError} aria-label="Wizard" />);
    const items = screen.getAllByRole('listitem');
    const errorItem = items[1]!;
    expect(errorItem.getAttribute('data-status')).toBe('error');
    expect(errorItem.getAttribute('aria-invalid')).toBe('true');
    // Indicator carries an SVG (lucide AlertCircle); fall-through index
    // number must NOT be rendered alongside the icon.
    expect(errorItem.querySelector('svg')).not.toBeNull();
    expect(within(errorItem).queryByText('2')).toBeNull();
    // Label gets text-destructive class (visual cue + SR-independent).
    const label = errorItem.querySelector('[data-slot="stepper-label"]')!;
    expect(label.className).toMatch(/text-destructive/);
  });

  // F2 polish round 2 — `compact` mode toggles a responsive utility
  // class so labels collapse below sm:640px. Vitest's jsdom has no real
  // viewport, so we assert on the class string rather than visibility.
  it('compact mode hides labels under sm (via hidden sm:block utility)', () => {
    render(<Stepper steps={steps} aria-label="Flow" compact />);
    const labels = screen
      .getAllByRole('listitem')
      .map((item) => item.querySelector('[data-slot="stepper-label"]')!.parentElement!);
    for (const wrapper of labels) {
      expect(wrapper.className).toMatch(/hidden/);
      expect(wrapper.className).toMatch(/sm:block/);
    }
  });

  it('default (non-compact) keeps labels visible at all breakpoints', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    const labels = screen
      .getAllByRole('listitem')
      .map((item) => item.querySelector('[data-slot="stepper-label"]')!.parentElement!);
    for (const wrapper of labels) {
      expect(wrapper.className).not.toMatch(/\bhidden\b/);
    }
  });
});
