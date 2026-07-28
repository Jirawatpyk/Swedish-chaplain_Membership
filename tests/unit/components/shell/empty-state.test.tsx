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
  it('defaults the icon to text-muted-foreground when iconClassName is omitted', () => {
    const { container } = render(
      <EmptyState icon={ShieldCheck} title="Nothing here" />,
    );
    const icon = container.querySelector('svg[aria-hidden="true"]');
    expect(icon).toHaveClass('text-muted-foreground');
    expect(icon).not.toHaveClass('text-success');
  });

  it('overrides the icon colour via iconClassName without losing size-10', () => {
    const { container } = render(
      <EmptyState
        icon={ShieldCheck}
        title="No one at risk"
        iconClassName="text-success"
      />,
    );
    const icon = container.querySelector('svg[aria-hidden="true"]');
    expect(icon).toHaveClass('text-success');
    expect(icon).toHaveClass('size-10');
    expect(icon).not.toHaveClass('text-muted-foreground');
  });
});
