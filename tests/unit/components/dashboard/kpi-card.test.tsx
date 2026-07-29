/**
 * KpiCard — label + value + optional basis caption.
 *
 * The caption is the disambiguator that lets the dashboard keep short KPI
 * labels while every tile still states its own basis (e.g. revenue is
 * fiscal-year/ex-VAT, distinct from the VAT-inclusive donut). These tests pin
 * that the caption renders when given and is absent — not an empty node — when
 * omitted, so a card without a basis note stays clean.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiCard } from '@/components/dashboard/kpi-card';

describe('KpiCard', () => {
  it('renders the label and value', () => {
    render(<KpiCard label="Total members" value="477" />);
    expect(screen.getByText('Total members')).toBeInTheDocument();
    expect(screen.getByText('477')).toBeInTheDocument();
  });

  it('renders the basis caption when provided', () => {
    render(<KpiCard label="Paid revenue" value="฿ 1,632,645" caption="Fiscal year to date · ex-VAT" />);
    expect(screen.getByText('Fiscal year to date · ex-VAT')).toBeInTheDocument();
  });

  it('renders no caption element when caption is omitted', () => {
    const { container } = render(<KpiCard label="Active members" value="475" />);
    // Only the label + value text nodes — no stray empty <p> for the caption.
    expect(container.querySelector('p')).toBeNull();
  });
});

/**
 * UX-review follow-up F2 — `href` × `labelHint` mutual exclusion.
 *
 * The discriminated union must make "linked tile with an interactive label
 * hint" a COMPILE-TIME error (nested interactive control + the link's
 * `aria-label` swallows descendant text for screen readers). The
 * `@ts-expect-error` pins are the proof the union actually rejects the bad
 * combinations — if a refactor ever widens the props back to a plain
 * optional bag, the pragmas become unused and `pnpm typecheck` fails with
 * TS2578. Runtime render behaviour is intentionally unchanged; the
 * valid-branch renders pin that every pre-existing call-site shape still
 * works.
 */
describe('KpiCard href × labelHint union (F2)', () => {
  it('still renders a linked tile (href branch) and a hinted tile (labelHint branch)', () => {
    render(
      <>
        <KpiCard label="Past due" value="500.00" href="/admin/renewals" ariaLabel="Past due" />
        <KpiCard label="Rate" value="79.2%" labelHint={<span data-testid="hint" />} />
      </>,
    );
    expect(screen.getByRole('link', { name: 'Past due' })).toBeInTheDocument();
    expect(screen.getByTestId('hint')).toBeInTheDocument();
  });

  it('type-level: passing BOTH href and labelHint is a compile error', () => {
    const bad = (
      // @ts-expect-error — F2 union: labelHint is `never` on the href branch
      <KpiCard label="x" value="y" href="/x" labelHint={<span />} />
    );
    // Never rendered — the JSX expression exists only to host the pragma.
    expect(bad).toBeTruthy();
  });

  it('type-level: ariaLabel without href is also rejected (it only names the link)', () => {
    const bad = (
      // @ts-expect-error — F2 union: ariaLabel is `never` on the non-href branch
      <KpiCard label="x" value="y" ariaLabel="orphan label" />
    );
    expect(bad).toBeTruthy();
  });
});
