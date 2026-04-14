import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { PlanFormWizardSkeleton } from '@/components/plans/plan-form-wizard-skeleton';

describe('<PlanFormWizardSkeleton>', () => {
  it('announces itself as an aria-busy loading region', () => {
    const { container } = render(<PlanFormWizardSkeleton />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('aria-busy')).toBe('true');
    // No role="status" — outer <PageSkeletonShell> owns the live region
    // so nested skeletons only set aria-busy (see page-skeletons.tsx doc).
    expect(root.getAttribute('role')).toBeNull();
  });

  it('renders a 4-item step indicator matching the real wizard', () => {
    const { container } = render(<PlanFormWizardSkeleton />);
    // First direct child is the step indicator flex row; its 4
    // SkeletonBlocks mirror STEPS = ['basics','fees','benefits','review'].
    const stepRow = container.firstChild!.firstChild as HTMLElement;
    const stepBlocks = stepRow.querySelectorAll('[data-slot="skeleton-block"]');
    expect(stepBlocks.length).toBe(4);
  });

  it('matches the basics-step layout with footer Next button only', () => {
    const { container } = render(<PlanFormWizardSkeleton />);
    const allBlocks = container.querySelectorAll('[data-slot="skeleton-block"]');
    // 4 step indicator + basics section + footer. Keep soft (≥) so a
    // future decorative addition to the skeleton doesn't break this.
    expect(allBlocks.length).toBeGreaterThanOrEqual(20);
  });
});
