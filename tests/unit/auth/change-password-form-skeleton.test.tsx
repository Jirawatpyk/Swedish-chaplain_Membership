import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';

describe('<ChangePasswordFormSkeleton>', () => {
  it('announces itself as an aria-busy loading region', () => {
    const { container } = render(<ChangePasswordFormSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-busy')).toBe('true');
  });

  it('renders the three password fields plus the strength meter and submit', () => {
    const { container } = render(<ChangePasswordFormSkeleton />);
    const blocks = container.querySelectorAll('[data-slot="skeleton-block"]');
    // 3 fields × (label + input = 2) + 1 strength meter + 1 submit = 8.
    expect(blocks.length).toBe(8);
  });
});
