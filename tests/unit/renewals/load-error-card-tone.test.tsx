/**
 * Fix round 1 (review, `renewals-restructure-wave2` Task 8) I-2 —
 * `<LoadErrorCard>` `tone` prop.
 *
 * Default (`tone` omitted, i.e. `'destructive'`) MUST stay byte-identical to
 * the pre-fix behaviour — the pipeline's own load-failure, the at-risk
 * widget's error branch, `MembersWithoutCycleTray`, and `PendingReviewSection`
 * all render this component without a `tone` prop and must keep the loud
 * `role="alert"` / `aria-live="assertive"` / destructive-red skin.
 *
 * `tone="muted"` is the new, proportional variant for auxiliary surfaces
 * (the money-band KPI section) where a page-level alarm would be
 * disproportionate: `role="status"` / `aria-live="polite"` +
 * `text-muted-foreground` instead of `text-destructive`.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadErrorCard } from '@/app/(staff)/admin/renewals/_components/load-error-card';

describe('<LoadErrorCard> tone', () => {
  it('defaults to the destructive alert skin when tone is omitted', () => {
    const { container } = render(<LoadErrorCard message="Couldn't load" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText("Couldn't load")).toHaveClass('text-destructive');
    const icon = container.querySelector('svg[aria-hidden="true"]');
    expect(icon).toHaveClass('text-destructive');
  });

  it('tone="muted" renders a polite status notice instead of an assertive alert', () => {
    const { container } = render(
      <LoadErrorCard tone="muted" message="Couldn't load these figures right now." />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(
      screen.getByText("Couldn't load these figures right now."),
    ).toHaveClass('text-muted-foreground');
    const icon = container.querySelector('svg[aria-hidden="true"]');
    expect(icon).toHaveClass('text-muted-foreground');
    expect(icon).not.toHaveClass('text-destructive');
  });

  it('tone="muted" composes with card={false} (bare inline variant)', () => {
    render(
      <LoadErrorCard tone="muted" card={false} message="Couldn't load." />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.tagName).toBe('DIV');
  });
});
