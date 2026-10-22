/**
 * Spec 122 follow-up 5 — the top bar's email-delivery warning is the same
 * AURA `IconButton` with `touchHeight` as the bar's search and theme buttons:
 * 32px with a mouse from 640px, 44px on a phone or a touch screen. It was a
 * hand-made 36px button (44px only on a coarse pointer), out of the
 * small-button guard's sight.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutboxHealthPopover } from '@/components/shell/outbox-health-popover';

describe('OutboxHealthPopover (AURA)', () => {
  it('renders its trigger as an AURA IconButton with touchHeight', () => {
    render(<OutboxHealthPopover label="Email delivery issues detected" lines={['2 emails failed']} />);
    const trigger = screen.getByRole('button', { name: 'Email delivery issues detected' });
    expect(trigger).toHaveClass('aura-icon-btn', 'aura-icon-btn--touch');
    expect(trigger).not.toHaveClass('size-9');
  });
});
