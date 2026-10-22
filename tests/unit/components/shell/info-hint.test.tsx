/**
 * Spec 122 follow-up 5, PR 6 (relay R70b, 22 Oct) — the emergency-primary ⓘ
 * was a hand-made 24px button while every other help ⓘ in the app is an AURA
 * `IconButton` (32px, AURA's 44px hit area). `InfoHint` renders the same
 * `IconButton`, so the help icons are one size.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InfoHint } from '@/components/shell/info-hint';

describe('InfoHint (AURA)', () => {
  it('renders its trigger as an AURA IconButton, like the other help icons', () => {
    render(<InfoHint ariaLabel="About the emergency primary">Body</InfoHint>);
    const trigger = screen.getByRole('button', { name: 'About the emergency primary' });
    expect(trigger).toHaveClass('aura-icon-btn');
    expect(trigger).not.toHaveClass('size-6');
  });
});
