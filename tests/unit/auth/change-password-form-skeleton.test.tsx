import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';

describe('<ChangePasswordFormSkeleton>', () => {
  it('marks itself aria-busy without claiming a live region', () => {
    // The outer <PageSkeletonShell> in `loading.tsx` owns role="status";
    // this component is always nested inside it, so it only signals
    // busy to avoid nested live regions (ARIA best practice).
    const { container } = render(<ChangePasswordFormSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('role')).toBeNull();
    expect(root.getAttribute('aria-busy')).toBe('true');
  });

  it('renders the three password fields plus the strength meter and submit', () => {
    const { container } = render(<ChangePasswordFormSkeleton />);
    const blocks = container.querySelectorAll('[data-slot="skeleton-block"]');
    // 3 fields × (label + input) + 1 strength meter + 1 submit = 8 minimum.
    // Soft lower bound so future decorative additions (e.g. helper text
    // under the confirm field) don't produce false-positive failures.
    expect(blocks.length).toBeGreaterThanOrEqual(8);
  });
});
