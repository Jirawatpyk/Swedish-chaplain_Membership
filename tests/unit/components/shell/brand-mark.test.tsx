/**
 * Unit tests for <BrandMark> — the official SweCham "Interlocking Link" logo.
 *
 * Covers the contract every consuming surface relies on:
 *   - decorative by default (aria-hidden, no accessible name) so an adjacent
 *     wordmark isn't double-announced;
 *   - labelled + role="img" when a `title` is supplied (auth pages);
 *   - all three variants render their SVG geometry;
 *   - the gold ring stays pinned to the --brand-accent token and the navy/white
 *     ring uses currentColor so the mark reverses with the theme;
 *   - caller classes compose with the default colour utilities.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { BrandMark } from '@/components/shell/brand-mark';

afterEach(cleanup);

describe('<BrandMark>', () => {
  it('is decorative by default (aria-hidden, no img role)', () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
  });

  it('exposes an accessible image when titled', () => {
    const { container } = render(<BrandMark title="SweCham — staff" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('SweCham — staff');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });

  it('reverses with the theme: navy/white ring via currentColor, gold pinned to the token', () => {
    const { container } = render(<BrandMark />);
    const strokes = Array.from(container.querySelectorAll('circle')).map((c) =>
      c.getAttribute('stroke'),
    );
    expect(strokes).toContain('currentColor');
    expect(strokes).toContain('var(--brand-accent)');
  });

  it('applies the default reversible colour utilities and composes caller classes', () => {
    const { container } = render(<BrandMark className="size-8 shrink-0" />);
    const cls = container.querySelector('svg')!.getAttribute('class') ?? '';
    expect(cls).toContain('text-[#0B2A4A]');
    expect(cls).toContain('dark:text-white');
    expect(cls).toContain('size-8');
    expect(cls).toContain('shrink-0');
  });

  it.each([
    ['mark', '0 0 104 96'],
    ['lockup', '0 0 516 120'],
    ['vertical', '0 0 330 248'],
  ] as const)('renders the %s variant', (variant, viewBox) => {
    const { container } = render(<BrandMark variant={variant} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe(viewBox);
    // every variant draws the three-circle woven symbol
    expect(container.querySelectorAll('circle').length).toBe(3);
  });

  it('generates a unique weave clip-path id per instance', () => {
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark />
      </>,
    );
    const ids = Array.from(container.querySelectorAll('clipPath')).map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
