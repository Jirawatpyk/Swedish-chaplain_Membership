/**
 * Fix round 1 (review, `renewals-restructure-wave2` Task 8) M-3 —
 * `<EmptyState>` `iconClassName` override.
 *
 * The at-risk widget's empty state ("no one at risk") used a deliberate
 * positive-affirmation green `ShieldCheck` icon before it was routed through
 * this shared primitive, which defaults every icon to a neutral
 * `text-muted-foreground`. `iconClassName` is additive: omitted, every
 * existing consumer's neutral-grey icon is byte-unchanged; passed, it
 * overrides the colour (via `cn()`/`tailwind-merge`, so the conflicting
 * `text-*` utility is replaced, not appended) without dropping the shared
 * `size-10` sizing.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ShieldCheck } from 'lucide-react';
import { EmptyState } from '@/components/shell/empty-state';

describe('<EmptyState> icon colour', () => {
  it('draws the icon in AURA\'s empty-state tile when iconClassName is omitted (spec 122 US1)', () => {
    const { container } = render(
      <EmptyState icon={ShieldCheck} title="Nothing here" />,
    );
    const icon = container.querySelector('svg[aria-hidden="true"]');
    // AURA #86 (5.14): AURA's own EmptyState wraps a custom icon in its sized span
    expect(icon?.closest('.aura-empty__icon')).not.toBeNull();
    expect(icon).not.toHaveClass('text-success');
  });

  it('overrides the icon colour via iconClassName, inside AURA\'s sized icon span', () => {
    const { container } = render(
      <EmptyState
        icon={ShieldCheck}
        title="No one at risk"
        iconClassName="text-success"
      />,
    );
    const icon = container.querySelector('svg[aria-hidden="true"]');
    expect(icon).toHaveClass('text-success');
    expect(icon?.parentElement).toHaveClass('aura-icon--custom');
  });
});

describe('<EmptyState> on AURA (spec 122 #86)', () => {
  it('keeps the title a paragraph and the status role optional', () => {
    const { container, rerender } = render(<EmptyState title="Nothing here" data-testid="e" />);
    const root = container.firstElementChild;
    expect(root).toHaveClass('aura-empty', 'is-bordered');
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('data-testid', 'e');
    expect(container.querySelector('p.aura-empty__title')).toHaveTextContent('Nothing here');
    expect(container.querySelector('h2, h3, h4, h5, h6')).toBeNull();
    rerender(<EmptyState title="Nothing here" announce={false} bordered={false} />);
    expect(container.firstElementChild).not.toHaveAttribute('role');
    expect(container.firstElementChild).not.toHaveClass('is-bordered');
  });
});
