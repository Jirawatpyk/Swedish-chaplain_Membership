/**
 * 108 PR-D review cycle 15 (/speckit.review tests MEDIUM-6) — `ReadOnlyBanner`
 * is the one component every read-only surface uses (members directory,
 * Marketing audience). Its a11y contract is stated in its docstring but was
 * pinned nowhere: `role="note"` with the visible text as the region's content
 * and NO `aria-label` — a label equal to the text makes a screen reader
 * announce the region name AND its content. axe cannot catch that (the role
 * is valid, the label is permitted), so only a test can.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReadOnlyBanner } from '@/components/shell/read-only-banner';

afterEach(() => cleanup());

describe('ReadOnlyBanner', () => {
  it('is a note whose accessible content is the visible text — never an aria-label', () => {
    render(<ReadOnlyBanner>Read-only — you cannot change these.</ReadOnlyBanner>);
    const note = screen.getByRole('note');
    expect(note).not.toHaveAttribute('aria-label');
    expect(note).not.toHaveAttribute('aria-labelledby');
    expect(note).toHaveTextContent('Read-only — you cannot change these.');
  });

  it('the icon is decorative (never announced alongside the sentence)', () => {
    const { container } = render(<ReadOnlyBanner>x</ReadOnlyBanner>);
    const icon = container.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('extra props reach the element so a caller can add a test id', () => {
    render(<ReadOnlyBanner data-testid="audience-read-only">x</ReadOnlyBanner>);
    expect(screen.getByTestId('audience-read-only')).toHaveAttribute('role', 'note');
  });
});
