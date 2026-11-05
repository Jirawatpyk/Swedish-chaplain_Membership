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
import { LoadErrorCard } from '@/components/shell/load-error-card';

describe('<LoadErrorCard> tone', () => {
  it('defaults to the destructive alert skin when tone is omitted', () => {
    const { container } = render(<LoadErrorCard message="Couldn't load" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    // PR O — AURA's EmptyState in the danger tone, framed (the old Card).
    expect(alert).toHaveClass('aura-empty', 'is-danger', 'is-bordered');
    expect(alert).toHaveTextContent("Couldn't load");
    expect(container.querySelector('.aura-empty__icon')).toHaveAttribute('aria-hidden', 'true');
  });

  it('tone="muted" renders a polite status notice instead of an assertive alert', () => {
    const { container } = render(
      <LoadErrorCard tone="muted" message="Couldn't load these figures right now." />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveClass('aura-empty');
    expect(status).not.toHaveClass('is-danger');
    expect(status).toHaveTextContent("Couldn't load these figures right now.");
    expect(container.querySelector('.aura-empty__icon')).toHaveAttribute('aria-hidden', 'true');
  });

  it('tone="muted" composes with card={false} (bare inline variant)', () => {
    render(
      <LoadErrorCard tone="muted" card={false} message="Couldn't load." />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.tagName).toBe('DIV');
    expect(status).toHaveClass('aura-empty');
    expect(status).not.toHaveClass('is-bordered');
  });
});
