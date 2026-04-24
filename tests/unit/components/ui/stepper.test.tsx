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
    expect(items[0].getAttribute('aria-current')).toBeNull();
    expect(items[1].getAttribute('aria-current')).toBe('step');
    expect(items[2].getAttribute('aria-current')).toBeNull();
  });

  it('exposes data-status per step for styling and tests', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    const items = screen.getAllByRole('listitem');
    expect(items[0].getAttribute('data-status')).toBe('complete');
    expect(items[1].getAttribute('data-status')).toBe('current');
    expect(items[2].getAttribute('data-status')).toBe('upcoming');
  });

  it('renders a check icon for completed steps and index number otherwise', () => {
    render(<Stepper steps={steps} aria-label="Flow" />);
    const items = screen.getAllByRole('listitem');
    // Completed — has an svg (lucide Check)
    expect(items[0].querySelector('svg')).not.toBeNull();
    // Current — shows "2"
    expect(within(items[1]).getByText('2')).toBeDefined();
    // Upcoming — shows "3"
    expect(within(items[2]).getByText('3')).toBeDefined();
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
});
